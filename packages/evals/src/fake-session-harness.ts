import { performance } from "node:perf_hooks";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness, type JsonValue, type SimpleHarnessResult } from "vitest-evals/harness";
import { FakeSessionDriver } from "./fake-session/driver.ts";
import { createFakeModelRuntime } from "./fake-session/model.ts";
import { toHarnessUsage, toTranscriptEvents, withEvalSession } from "./pi-harness.ts";

export { FakeSessionDriver, type FakeToolCallRequest, type FakeToolResult } from "./fake-session/driver.ts";
export { createFakeModelRuntime, FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./fake-session/model.ts";

/**
 * Fake-session inputs stay JSON-serializable so `vitest-evals` keeps hashing
 * them for run grouping and comparative harness tables. Put the driving logic
 * in `drive`, not in the input.
 */
export type FakeSessionInput = JsonValue;

export interface FakeSessionHarnessOptions<TInput extends FakeSessionInput, TOutput extends JsonValue> {
	name?: string;
	noTools?: CreateAgentSessionOptions["noTools"];
	transformSystemPrompt?: (defaultPrompt: string) => string;
	/** How long a single driver step waits for the harness. Defaults to 30s. */
	stepTimeoutMs?: number;
	/** Drives the session. The caller issues every assistant message. */
	drive: (driver: FakeSessionDriver, input: TInput) => Promise<TOutput>;
}

/**
 * A harness that runs a real `AgentSession` with no model behind it: the
 * `drive` callback issues the tool calls that an LLM would otherwise choose.
 *
 * Use it to benchmark the harness and its tools — tool backends, exec zones,
 * session persistence, extension hooks — deterministically and without tokens.
 * It measures Pi, not the model, so it does not belong in model comparisons.
 */
export function createFakeSessionHarness<TInput extends FakeSessionInput, TOutput extends JsonValue>(
	options: FakeSessionHarnessOptions<TInput, TOutput>,
): Harness<TInput, TOutput> {
	return createHarness<TInput, TOutput>({
		name: options.name ?? "pi-fake-session",
		run: async ({ input, signal, setArtifact }): Promise<SimpleHarnessResult<TOutput>> => {
			const startedAt = performance.now();
			signal?.throwIfAborted();
			const { modelRuntime, model, faux } = await createFakeModelRuntime();

			const result = await withEvalSession(
				{
					modelRuntime,
					model,
					setArtifact,
					signal,
					noTools: options.noTools,
					transformSystemPrompt: options.transformSystemPrompt,
				},
				async (session) => {
					const driver = new FakeSessionDriver({
						session,
						faux,
						signal,
						stepTimeoutMs: options.stepTimeoutMs,
					});
					try {
						const output = await options.drive(driver, input);
						return {
							output,
							events: toTranscriptEvents(session.messages),
							usage: toHarnessUsage(session, model),
						} satisfies SimpleHarnessResult<TOutput>;
					} finally {
						await driver.dispose();
					}
				},
			);

			return { ...result, timings: { totalMs: performance.now() - startedAt } };
		},
	});
}
