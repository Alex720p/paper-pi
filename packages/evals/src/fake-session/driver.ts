import type {
	AssistantMessage,
	FauxContentBlock,
	FauxProviderHandle,
	FauxResponseStep,
	ImageContent,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import { contentText, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_FINAL_TEXT = "Done.";

/** One tool call to place in a driven assistant message. */
export interface FakeToolCallRequest {
	name: string;
	arguments: Record<string, unknown>;
	/** Explicit tool call id. Defaults to a generated one. */
	id?: string;
}

/** The tool result the harness produced for a driven tool call. */
export interface FakeToolResult {
	toolCallId: string;
	toolName: string;
	/** Text blocks of the result, joined by newline. */
	text: string;
	content: Array<TextContent | ImageContent>;
	isError: boolean;
}

export interface FakeSessionDriverOptions {
	session: AgentSession;
	faux: FauxProviderHandle;
	signal?: AbortSignal;
	/** How long a single driver step waits for the harness. Defaults to 30s. */
	stepTimeoutMs?: number;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolveFn) => {
		resolve = resolveFn;
	});
	return { promise, resolve };
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Drives an `AgentSession` without a model: the caller decides every assistant
 * message, so tool calls are issued by benchmark code instead of an LLM.
 *
 * Everything downstream of the assistant message still runs for real — the
 * agent loop, tool dispatch, tool hooks, session persistence, and session
 * events all behave exactly as they do in a model-backed session.
 *
 * The driver and the harness meet at a rendezvous. The faux provider's
 * response factory blocks whenever the loop asks for an assistant message;
 * `toolCall()` and `finish()` release it with a message the caller composed.
 */
export class FakeSessionDriver {
	readonly session: AgentSession;
	readonly #faux: FauxProviderHandle;
	readonly #signal: AbortSignal | undefined;
	readonly #stepTimeoutMs: number;

	/** Set while the harness is blocked waiting for an assistant message. */
	#pendingInstruction: Deferred<AssistantMessage> | undefined;
	/** Driver-side waiters released when the harness asks for a message. */
	#requestWaiters: Array<Deferred<void>> = [];
	#run: Promise<void> | undefined;
	/** Mirrors `#run` but never rejects, so racing on it is always safe. */
	#runSettled: Promise<void> = Promise.resolve();
	#runError: Error | undefined;
	#isRunDone = false;
	#toolCallSeq = 0;

	constructor(options: FakeSessionDriverOptions) {
		this.session = options.session;
		this.#faux = options.faux;
		this.#signal = options.signal;
		this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

		// A self-replenishing factory: the faux queue is never exhausted, and
		// each invocation parks until the driver supplies the next message.
		const factory: FauxResponseStep = async () => {
			this.#faux.appendResponses([factory]);
			const instruction = createDeferred<AssistantMessage>();
			this.#pendingInstruction = instruction;
			for (const waiter of this.#requestWaiters.splice(0)) waiter.resolve();
			return instruction.promise;
		};
		this.#faux.setResponses([factory]);
	}

	/** Messages recorded on the underlying session, including tool results. */
	get messages(): AgentSession["messages"] {
		return this.session.messages;
	}

	/** True while an agent run is in flight and awaiting driver instructions. */
	get isRunning(): boolean {
		return this.#run !== undefined && this.#runError === undefined && !this.#isRunDone;
	}

	/**
	 * Send the user prompt that opens a run, then wait until the harness asks
	 * for its first assistant message. Resolves before any tool runs.
	 */
	async start(prompt: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.#run !== undefined && !this.#isRunDone) {
			throw new Error("A fake session run is already in progress. Call finish() before starting another.");
		}
		this.#runError = undefined;
		this.#isRunDone = false;
		const run = this.session.prompt(prompt, options?.images ? { images: options.images } : undefined);
		this.#run = run;
		this.#runSettled = run.then(
			() => {
				this.#isRunDone = true;
			},
			(error) => {
				this.#isRunDone = true;
				this.#runError = toError(error);
			},
		);
		await this.#awaitInstruction();
	}

	/** Issue one tool call and return its result once the harness produced it. */
	async toolCall(
		name: string,
		args: Record<string, unknown>,
		options?: { text?: string; id?: string },
	): Promise<FakeToolResult> {
		const [result] = await this.toolCalls([{ name, arguments: args, id: options?.id }], { text: options?.text });
		return result!;
	}

	/**
	 * Issue several tool calls in a single assistant message, exercising the
	 * loop's parallel tool execution. Results come back in the requested order.
	 */
	async toolCalls(calls: FakeToolCallRequest[], options?: { text?: string }): Promise<FakeToolResult[]> {
		if (calls.length === 0) throw new Error("toolCalls() requires at least one tool call.");
		const instruction = await this.#awaitInstruction();
		const toolCalls = calls.map((call) =>
			fauxToolCall(call.name, call.arguments, { id: call.id ?? `fake-tool-${++this.#toolCallSeq}` }),
		);
		const content: FauxContentBlock[] = options?.text ? [fauxText(options.text), ...toolCalls] : toolCalls;

		this.#pendingInstruction = undefined;
		// Arm the next-request waiter before releasing the harness, otherwise a
		// fast turn could ask for the following message before we start listening.
		const settled = this.#awaitNextRequestOrRunEnd();
		instruction.resolve(fauxAssistantMessage(content, { stopReason: "toolUse" }));
		await settled;

		return toolCalls.map((toolCall) => this.#requireToolResult(toolCall));
	}

	/**
	 * End the run with a text-only assistant message. No tool calls means the
	 * agent loop stops, so this resolves the pending `prompt()` and returns the
	 * final assistant text.
	 */
	async finish(text: string = DEFAULT_FINAL_TEXT): Promise<string> {
		if (!text.trim()) throw new Error("finish() requires non-empty assistant text.");
		const instruction = await this.#awaitInstruction();
		this.#pendingInstruction = undefined;
		instruction.resolve(fauxAssistantMessage(text, { stopReason: "stop" }));
		await this.#withDeadline(this.#runSettled, "the agent run to finish");
		if (this.#runError) throw this.#runError;
		const output = this.session.getLastAssistantText();
		if (!output) throw new Error("Fake session finished without an assistant text message.");
		return output;
	}

	/**
	 * Reload session resources (extensions, skills, prompts) between runs. Not
	 * valid mid-run, where a resource swap would race the active turn.
	 */
	async reload(): Promise<void> {
		if (this.#run !== undefined && !this.#isRunDone) {
			throw new Error("reload() requires an idle fake session. Call finish() first.");
		}
		await this.session.reload();
	}

	/**
	 * Unwind an unfinished run so a failed assertion cannot leave `prompt()`
	 * pending forever. Safe to call more than once.
	 */
	async dispose(): Promise<void> {
		if (this.#run === undefined || this.#isRunDone) return;
		const instruction = this.#pendingInstruction;
		this.#pendingInstruction = undefined;
		if (instruction) {
			instruction.resolve(fauxAssistantMessage("Aborted.", { stopReason: "stop" }));
		} else {
			await this.session.abort();
		}
		await this.#runSettled;
	}

	/** Wait until the harness is blocked asking for an assistant message. */
	async #awaitInstruction(): Promise<Deferred<AssistantMessage>> {
		await this.#awaitNextRequestOrRunEnd();
		const instruction = this.#pendingInstruction;
		if (instruction) return instruction;
		if (this.#runError) throw this.#runError;
		throw new Error("The agent run ended; the fake session cannot send another assistant message.");
	}

	async #awaitNextRequestOrRunEnd(): Promise<void> {
		if (this.#pendingInstruction) return;
		if (this.#run === undefined) throw new Error("Call start() before driving a fake session.");
		if (this.#isRunDone) return;
		const waiter = createDeferred<void>();
		this.#requestWaiters.push(waiter);
		await this.#withDeadline(
			Promise.race([waiter.promise, this.#runSettled]),
			"the harness to request an assistant message",
		);
	}

	#requireToolResult(toolCall: ToolCall): FakeToolResult {
		for (const message of this.session.messages) {
			if (message.role !== "toolResult" || message.toolCallId !== toolCall.id) continue;
			return {
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				text: contentText(message.content),
				content: message.content,
				isError: message.isError,
			};
		}
		if (this.#runError) throw this.#runError;
		throw new Error(
			`No tool result for "${toolCall.name}" (${toolCall.id}). The agent run ended before producing one, ` +
				"which happens when every tool result in the batch sets terminate: true.",
		);
	}

	async #withDeadline<T>(promise: Promise<T>, waitingFor: string): Promise<T> {
		this.#signal?.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Fake session timed out after ${this.#stepTimeoutMs}ms waiting for ${waitingFor}.`)),
				this.#stepTimeoutMs,
			);
		});
		const aborted = new Promise<never>((_resolve, reject) => {
			const signal = this.#signal;
			if (!signal) return;
			onAbort = () => reject(toError(signal.reason));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([promise, deadline, aborted]);
		} finally {
			clearTimeout(timer);
			if (onAbort) this.#signal?.removeEventListener("abort", onAbort);
		}
	}
}
