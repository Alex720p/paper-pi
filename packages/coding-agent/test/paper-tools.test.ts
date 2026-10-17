import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PaperSession } from "../examples/extensions/paper/session.ts";
import { createPaperEditOps, createPaperWriteOps, executePaperDelete } from "../examples/extensions/paper/tools.ts";

function fixture() {
	const writeFile = vi.fn(async (_file: string, _content: string) => undefined);
	const deleteFile = vi.fn(async (_file: string) => undefined);
	const mutateStaged = vi.fn(async (work: () => Promise<void>) => work());
	const session = {
		cwd: path.resolve("/fixture/workspace"),
		config: { zone: { backend: "docker", workspacePath: "/app" } },
		read: { stat: vi.fn(async () => ({ type: "file", size: 4 })) },
		write: { writeFile, deleteFile },
		mutateStaged,
	} as unknown as PaperSession;
	return { session, writeFile, deleteFile, mutateStaged };
}

describe("paper staged Git metadata protection", () => {
	it.each([
		".git",
		".git/HEAD",
		"./.git/config",
		"source/../.git/HEAD",
		"/app/.git/refs/heads/task",
		"/app/source/../.git/HEAD",
		"/fixture/workspace/.git/HEAD",
	])("rejects writes, edits and deletions of %s before mutating staging", async (target) => {
		const { session, writeFile, deleteFile, mutateStaged } = fixture();
		await expect(createPaperWriteOps(session).writeFile(target, "metadata")).rejects.toThrow("Git metadata");
		await expect(createPaperEditOps(session).access(target)).rejects.toThrow("Git metadata");
		await expect(createPaperEditOps(session).writeFile(target, "metadata")).rejects.toThrow("Git metadata");
		await expect(executePaperDelete(session, target)).rejects.toThrow("Git metadata");
		expect(writeFile).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
		expect(mutateStaged).not.toHaveBeenCalled();
	});

	it("continues staging source changes after a rejected metadata write", async () => {
		const { session, writeFile, deleteFile } = fixture();
		await expect(createPaperWriteOps(session).writeFile(".git/HEAD", "branch")).rejects.toThrow("Git metadata");
		for (const file of [".gitignore", ".gitmodules", ".github/workflows/test.yml", "source.ts"]) {
			await createPaperWriteOps(session).writeFile(`/app/${file}`, "source");
			expect(writeFile).toHaveBeenCalledWith(file, "source");
		}
		await createPaperEditOps(session).writeFile("/app/source.ts", "edited");
		expect(writeFile).toHaveBeenLastCalledWith("source.ts", "edited");
		await executePaperDelete(session, "/app/source.ts");
		expect(deleteFile).toHaveBeenCalledWith("source.ts");
	});
});
