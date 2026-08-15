import { describe, expect, it } from "vitest";
import type { JsonValue } from "vitest-evals/harness";
import { createFakeSessionHarness } from "../src/fake-session-harness.ts";
import { PI_SESSION_SNAPSHOT_ARTIFACT } from "../src/vitest-evals/artifacts.ts";

function createContext() {
	const artifacts: Record<string, JsonValue> = {};
	return {
		artifacts,
		setArtifact: (name: string, value: JsonValue) => {
			artifacts[name] = value;
		},
	};
}

describe("createFakeSessionHarness", () => {
	it("drives real tools through the agent loop without a model", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Round-trip a file.");
				const written = await driver.toolCall("write", { path: "note.txt", content: "hello fake session" });
				expect(written.isError).toBe(false);
				const read = await driver.toolCall("read", { path: "note.txt" });
				expect(read.isError).toBe(false);
				expect(read.text).toContain("hello fake session");
				const response = await driver.finish("Round-trip complete.");
				return {
					response,
					toolNames: driver.messages.flatMap((m) => (m.role === "toolResult" ? [m.toolName] : [])),
				};
			},
		});

		const run = await harness.run(null, createContext());

		expect(run.output).toEqual({ response: "Round-trip complete.", toolNames: ["write", "read"] });
		expect(run.session.events.map((event) => event.type)).toEqual([
			"message",
			"tool_call",
			"tool_result",
			"tool_call",
			"tool_result",
			"message",
		]);
		expect(run.usage.toolCalls).toBe(2);
	});

	it("reports a failing tool call as an error result instead of throwing", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Read a file that is not there.");
				const missing = await driver.toolCall("read", { path: "absent.txt" });
				await driver.finish("Reported.");
				return { isError: missing.isError, text: missing.text };
			},
		});

		const run = await harness.run(null, createContext());

		expect(run.output).toMatchObject({ isError: true });
		expect((run.output as { text: string }).text).not.toBe("");
	});

	it("issues several tool calls in one assistant message and preserves order", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Write two files at once.");
				const results = await driver.toolCalls([
					{ name: "write", arguments: { path: "first.txt", content: "one" } },
					{ name: "write", arguments: { path: "second.txt", content: "two" } },
				]);
				const listing = await driver.toolCall("bash", { command: "ls" });
				await driver.finish("Both written.");
				return { count: results.length, errors: results.map((result) => result.isError), listing: listing.text };
			},
		});

		const run = await harness.run(null, createContext());

		expect(run.output).toMatchObject({ count: 2, errors: [false, false] });
		expect((run.output as { listing: string }).listing).toContain("first.txt");
		expect((run.output as { listing: string }).listing).toContain("second.txt");
	});

	it("records a session JSONL artifact containing the driven tool calls", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Touch a file.");
				await driver.toolCall("write", { path: "artifact.txt", content: "recorded" });
				return await driver.finish("Recorded.");
			},
		});

		const context = createContext();
		await harness.run(null, context);

		const snapshot = context.artifacts[PI_SESSION_SNAPSHOT_ARTIFACT];
		expect(typeof snapshot).toBe("string");
		expect(snapshot as string).toContain("artifact.txt");
		expect(typeof context.artifacts.runId).toBe("string");
	});

	it("surfaces an unknown tool name as a tool error", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Call a tool that does not exist.");
				const result = await driver.toolCall("no_such_tool", {});
				await driver.finish("Handled.");
				return { isError: result.isError, text: result.text };
			},
		});

		const run = await harness.run(null, createContext());

		expect(run.output).toMatchObject({ isError: true });
		expect((run.output as { text: string }).text).toContain("no_such_tool");
	});

	it("rejects driving a run that has already finished", async () => {
		const harness = createFakeSessionHarness({
			drive: async (driver) => {
				await driver.start("Finish immediately.");
				await driver.finish("Done here.");
				await expect(driver.toolCall("read", { path: "note.txt" })).rejects.toThrow(
					"The agent run ended; the fake session cannot send another assistant message.",
				);
				return "guarded";
			},
		});

		const run = await harness.run(null, createContext());

		expect(run.output).toBe("guarded");
	});

	it("passes the harness input through to the drive callback", async () => {
		const harness = createFakeSessionHarness<{ path: string }, string>({
			name: "fake-session-input",
			drive: async (driver, input) => {
				await driver.start(`Write ${input.path}.`);
				await driver.toolCall("write", { path: input.path, content: "from input" });
				const read = await driver.toolCall("read", { path: input.path });
				await driver.finish("Wrote it.");
				return read.text;
			},
		});

		const run = await harness.run({ path: "input.txt" }, createContext());

		expect(run.output).toContain("from input");
	});
});
