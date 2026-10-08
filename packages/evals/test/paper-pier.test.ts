import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PaperPierInput, runPaperPier } from "../src/paper-pier.ts";

const runner = vi.hoisted(() => ({
	onError: undefined as ((cause: { error: string }) => void) | undefined,
	failBind: false,
	failShutdown: false,
	prompt: vi.fn(),
	abort: vi.fn().mockResolvedValue(undefined),
}));
const paper = fileURLToPath(new URL("../../coding-agent/examples/extensions/paper", import.meta.url));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	initTheme: vi.fn(),
	ModelRuntime: {
		create: async () => ({
			getModel: () => ({
				provider: "fixture",
				id: "fixture",
				reasoning: false,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		}),
	},
	SettingsManager: { inMemory: vi.fn() },
	SessionManager: { create: vi.fn() },
	createAgentSessionServices: vi.fn(),
	createAgentSessionFromServices: async () => ({
		session: {
			thinkingLevel: "off",
			messages: [{ role: "assistant", stopReason: "stop" }],
			bindExtensions: async (options: { onError: (cause: { error: string }) => void }) => {
				runner.onError = options.onError;
				if (runner.failBind) options.onError({ error: "startup failed" });
			},
			extensionRunner: {
				getExtensionPaths: () => [paper],
				emit: async () => {
					// Real ExtensionRunner reports and swallows hook exceptions.
					if (runner.failShutdown) runner.onError?.({ error: "commit failed" });
				},
			},
			getActiveToolNames: () => ["read", "write", "bash"],
			subscribe: vi.fn(),
			prompt: runner.prompt,
			abort: runner.abort,
			getSessionStats: () => ({}),
			dispose: vi.fn(),
		},
	}),
}));

describe("paper benchmark finalization", () => {
	let directory: string;
	let input: PaperPierInput;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalConfig = process.env.PAPER_CONFIG_PATH;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "paper-runner-test-"));
		input = {
			workspace: directory,
			agentDir: join(directory, "agent"),
			logsDir: join(directory, "logs"),
			image: "fixture",
			instruction: "task",
			provider: "fixture",
			model: "fixture",
			memoryBytes: 1024 ** 3,
			cpus: 1,
			allowInternet: false,
			env: {},
		};
		runner.failBind = false;
		runner.failShutdown = false;
		runner.prompt.mockReset().mockResolvedValue(undefined);
		runner.abort.mockClear();
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalConfig === undefined) delete process.env.PAPER_CONFIG_PATH;
		else process.env.PAPER_CONFIG_PATH = originalConfig;
	});
	const result = async () => JSON.parse(await readFile(join(input.logsDir, "paper-result.json"), "utf8"));

	it("finalizes a submission after a model error", async () => {
		runner.prompt.mockRejectedValue(new Error("provider failed"));
		await expect(runPaperPier(input)).rejects.toThrow("provider failed");
		expect(await result()).toMatchObject({ status: "error", failureKind: "agent", submissionReady: true });
	});
	it("reports swallowed commit errors as infrastructure failures", async () => {
		runner.failShutdown = true;
		await expect(runPaperPier(input)).rejects.toThrow("commit failed");
		expect(await result()).toMatchObject({ status: "error", failureKind: "infrastructure", submissionReady: false });
	});
	it("stops before the prompt when extension startup fails", async () => {
		runner.failBind = true;
		await expect(runPaperPier(input)).rejects.toThrow("startup failed");
		expect(runner.prompt).not.toHaveBeenCalled();
		expect(await result()).toMatchObject({ failureKind: "infrastructure", submissionReady: false });
	});
	it("finalizes graceful Pier cancellation for verification", async () => {
		runner.prompt.mockImplementation(async () => {
			process.emit("SIGUSR1");
			throw new Error("aborted");
		});
		await expect(runPaperPier(input)).rejects.toThrow("aborted");
		expect(await result()).toMatchObject({ status: "timeout", submissionReady: true });
	});
});
