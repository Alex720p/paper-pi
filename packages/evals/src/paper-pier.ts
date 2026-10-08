import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FakeSessionDriver, type FakeToolCallRequest } from "./fake-session/driver.ts";
import { createFakeModelRuntime } from "./fake-session/model.ts";

const PAPER = fileURLToPath(new URL("../../coding-agent/examples/extensions/paper", import.meta.url));

export interface PaperPierInput {
	workspace: string;
	agentDir: string;
	logsDir: string;
	image: string;
	instruction: string;
	provider: string;
	model: string;
	memoryBytes: number;
	cpus: number;
	allowInternet: boolean;
	env: Record<string, string>;
	/** Host credential/catalog paths; never forwarded into a zone. */
	authPath?: string;
	modelsPath?: string;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	/** Optional cap per response, including reasoning; the model catalog limit is the default. */
	maxOutputTokens?: number;
	/** Deterministic infrastructure validation only; never used in a model benchmark. */
	fakeSteps?: FakeToolCallRequest[];
}

export async function runPaperPier(input: PaperPierInput): Promise<void> {
	const started = performance.now();
	// One host process per trial; paper's config lookup uses this same isolated agent directory.
	process.env.PI_CODING_AGENT_DIR = input.agentDir;
	process.env.PAPER_CONFIG_PATH = join(input.agentDir, "extensions", "paper.json");
	initTheme("dark");
	await mkdir(join(input.agentDir, "extensions"), { recursive: true });
	await mkdir(input.logsDir, { recursive: true });
	await writeFile(
		join(input.agentDir, "extensions", "paper.json"),
		JSON.stringify(
			{
				runtime: "runc",
				network: { enabled: input.allowInternet },
				zone: {
					backend: "docker",
					image: input.image,
					workspacePath: "/app",
					lowerSource: "staged",
					enabled: true,
					allowInstall: false,
					env: input.env,
				},
				workspace: {
					include: ["."],
					exclude: [".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".next"],
					maxSeedFiles: 100_000,
					maxSeedBytes: 1024 * 1024 * 1024,
				},
				bash: { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, env: [] },
				resources: { cpus: input.cpus, memoryBytes: input.memoryBytes, pidsLimit: 1024 },
				autoCommit: true,
				transcript: { enabled: true, stateDir: input.logsDir },
			},
			null,
			2,
		),
	);
	let fake: Awaited<ReturnType<typeof createFakeModelRuntime>> | undefined;
	let model: Model<Api> | undefined;
	let session: AgentSession | undefined;
	let driver: FakeSessionDriver | undefined;
	const spans: Array<{ toolCallId: string; tool: string; durationMs: number; isError: boolean }> = [];
	const starts = new Map<string, number>();
	const controller = new AbortController();
	let error: unknown;
	let failureKind: "agent" | "infrastructure" | undefined;
	let agentStarted = false;
	let timedOut = false;
	let submissionReady = false;
	let aborting: Promise<void> | undefined;
	let phase = "setup";
	let lastActivity = performance.now();
	let thinkingChars = 0;
	let textChars = 0;
	const log = (message: string) => process.stdout.write(`\n[${new Date().toISOString()}] ${message}\n`);
	log(`Starting ${input.provider}/${input.model}`);
	const heartbeat = setInterval(() => {
		log(
			`Heartbeat: ${phase}; ${Math.round((performance.now() - started) / 1000)}s elapsed; ` +
				`${Math.round((performance.now() - lastActivity) / 1000)}s since activity; ` +
				`${thinkingChars} thinking chars; ${textChars} text chars`,
		);
	}, 15_000);
	const abort = () => {
		log("Aborting trial");
		timedOut = true;
		controller.abort();
		aborting ??= session?.abort();
	};
	const infrastructureError = (cause: unknown) => {
		error = cause;
		failureKind = "infrastructure";
		log(`Infrastructure error: ${cause instanceof Error ? cause.message : String(cause)}`);
		controller.abort();
		aborting ??= session?.abort();
	};
	process.on("SIGTERM", abort);
	process.on("SIGINT", abort);
	// Pier cancellation uses this signal so paper-api's process-exit hooks cannot race submission.
	process.on("SIGUSR1", abort);
	let setupMs = 0;
	try {
		fake = input.fakeSteps ? await createFakeModelRuntime() : undefined;
		const modelRuntime =
			fake?.modelRuntime ??
			(await ModelRuntime.create({
				allowModelNetwork: false,
				authPath: input.authPath,
				modelsPath: input.modelsPath,
			}));
		model = fake?.model ?? modelRuntime.getModel(input.provider, input.model);
		if (!model) throw new Error(`Model not found: ${input.provider}/${input.model}`);
		if (input.maxOutputTokens !== undefined) {
			if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
				throw new Error("maxOutputTokens must be a positive integer");
			}
			model = { ...model, maxTokens: Math.min(model.maxTokens, input.maxOutputTokens) };
		}
		const services = await createAgentSessionServices({
			cwd: input.workspace,
			agentDir: input.agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				additionalExtensionPaths: [PAPER],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
		});
		session = (
			await createAgentSessionFromServices({
				services,
				model,
				thinkingLevel: input.thinkingLevel ?? (model.reasoning ? "high" : "off"),
				sessionManager: SessionManager.create(input.workspace, join(input.logsDir, "sessions")),
				tools: [
					"read",
					"write",
					"edit",
					"delete_file",
					"bash",
					"ls",
					"grep",
					"find",
					...(input.allowInternet ? ["fetch_url"] : []),
				],
			})
		).session;
		// Programmatic sessions need explicit startup binding for session_start hooks.
		await session.bindExtensions({ mode: "print", onError: (cause) => infrastructureError(new Error(cause.error)) });
		if (failureKind === "infrastructure") throw error;
		const extensions = session.extensionRunner.getExtensionPaths();
		if (extensions.length !== 1 || !extensions[0]?.startsWith(PAPER)) {
			throw new Error(`Expected only paper extension, loaded: ${extensions.join(", ")}`);
		}
		if (session.getActiveToolNames().includes("zone_install")) throw new Error("Docker session exposed zone_install");
		log(`Model ready: thinking=${session.thinkingLevel}; maxOutputTokens=${model.maxTokens}`);
		session.subscribe((event) => {
			lastActivity = performance.now();
			if (event.type === "message_start" && event.message.role === "assistant") {
				phase = "waiting for model";
				log("Assistant response started");
			}
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta.type === "thinking_start" || delta.type === "text_start" || delta.type === "toolcall_start") {
					phase = delta.type.replace("_start", "");
					log(phase);
				}
				if (delta.type === "thinking_delta" || delta.type === "text_delta" || delta.type === "toolcall_delta") {
					if (delta.type === "thinking_delta") thinkingChars += delta.delta.length;
					if (delta.type === "text_delta") textChars += delta.delta.length;
					process.stdout.write(delta.delta);
				}
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				log(`Assistant response ended: ${event.message.stopReason}`);
				if (event.message.errorMessage) log(event.message.errorMessage);
			}
			if (event.type === "tool_execution_start") {
				starts.set(event.toolCallId, performance.now());
				phase = `tool ${event.toolName}`;
				log(`Tool start: ${event.toolName} ${JSON.stringify(event.args)}`);
			}
			if (event.type === "tool_execution_end") {
				const began = starts.get(event.toolCallId);
				if (began !== undefined)
					spans.push({
						toolCallId: event.toolCallId,
						tool: event.toolName,
						durationMs: performance.now() - began,
						isError: event.isError,
					});
				starts.delete(event.toolCallId);
				log(`Tool end: ${event.toolName}; isError=${event.isError}`);
				phase = starts.size > 0 ? `tools running (${starts.size})` : "waiting for model";
			}
		});
		setupMs = performance.now() - started;
		controller.signal.throwIfAborted();
		phase = "waiting for model";
		log("Sending task prompt");
		agentStarted = true;
		if (fake && input.fakeSteps) {
			driver = new FakeSessionDriver({
				session,
				faux: fake.faux,
				signal: controller.signal,
				stepTimeoutMs: 120_000,
			});
			await driver.start(input.instruction);
			for (const step of input.fakeSteps) {
				const result = await driver.toolCall(step.name, step.arguments);
				if (result.isError) throw new Error(`${step.name}: ${result.text}`);
			}
			await driver.finish("Infrastructure validation complete.");
		} else {
			await session.prompt(input.instruction);
			const last = [...session.messages].reverse().find((message) => message.role === "assistant");
			if (last?.stopReason !== "stop") throw new Error(last?.errorMessage ?? "Agent did not finish normally");
		}
	} catch (cause) {
		error ??= cause;
		failureKind ??= agentStarted ? "agent" : "infrastructure";
		log(`Trial error: ${cause instanceof Error ? cause.message : String(cause)}`);
	} finally {
		clearInterval(heartbeat);
		try {
			await aborting;
			await driver?.dispose();
		} catch (cause) {
			infrastructureError(cause);
		}
		try {
			// Emit shutdown before dispose: paper commits remaining staged edits and closes its zones.
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} catch (cause) {
			infrastructureError(cause);
		}
		submissionReady = Boolean(session && agentStarted && failureKind !== "infrastructure");
		process.off("SIGTERM", abort);
		process.off("SIGINT", abort);
		process.off("SIGUSR1", abort);
		const stats = session?.getSessionStats();
		const status = failureKind === "infrastructure" ? "error" : timedOut ? "timeout" : error ? "error" : "completed";
		await writeFile(
			join(input.logsDir, "paper-result.json"),
			JSON.stringify(
				{
					processId: process.pid,
					status,
					failureKind,
					submissionReady,
					error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
					image: input.image,
					provider: model?.provider ?? input.provider,
					model: model?.id ?? input.model,
					generation: { thinkingLevel: session?.thinkingLevel, maxOutputTokens: model?.maxTokens },
					timings: { setupMs, agentMs: performance.now() - started - setupMs },
					stats,
					costAvailable: Boolean(!fake && model && Object.values(model.cost).some((rate) => rate > 0)),
					spans,
					deterministic: Boolean(fake),
				},
				null,
				2,
			),
		);
		session?.dispose();
		log(`Trial ended: ${status}`);
	}
	if (error) throw error;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const inputPath = process.argv[2];
	if (!inputPath) throw new Error("usage: paper-pier.ts input.json");
	const input: PaperPierInput = JSON.parse(await readFile(inputPath, "utf8"));
	await mkdir(dirname(inputPath), { recursive: true });
	await runPaperPier(input).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}
