import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createFakeSessionHarness } from "./fake-session-harness.ts";

/**
 * Fake sessions run a real `AgentSession` with no model behind it: the drive
 * callback issues every tool call. Use them to benchmark the harness and its
 * tool backends deterministically, with no provider credentials and no tokens.
 */
const fileRoundTripHarness = createFakeSessionHarness<{ id: string; path: string; content: string }, string>({
	name: "fake-session-file-round-trip",
	drive: async (driver, input) => {
		await driver.start(`Round-trip ${input.path} through the built-in tools.`);

		const written = await driver.toolCall("write", { path: input.path, content: input.content });
		expect(written.isError).toBe(false);

		const read = await driver.toolCall("read", { path: input.path });
		expect(read.isError).toBe(false);
		expect(read.text).toContain(input.content);

		const listed = await driver.toolCall("bash", { command: "ls" });
		expect(listed.text).toContain(input.path);

		return await driver.finish("Round-trip complete.");
	},
});

describeEval("Pi fake session tool round-trip", { harness: fileRoundTripHarness }, (it) => {
	it("writes, reads, and lists a file with no model in the loop", async ({ run }) => {
		const result = await run({ id: "round-trip", path: "note.txt", content: "written by the benchmark" });

		expect(result.output).toBe("Round-trip complete.");
		expect(result.errors).toEqual([]);
		expect(result.usage.toolCalls).toBe(3);
	});
});
