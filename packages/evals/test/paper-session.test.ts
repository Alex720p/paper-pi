import { createEditTool } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../coding-agent/examples/extensions/paper/config.ts";
import { openPaperSession } from "../../coding-agent/examples/extensions/paper/session.ts";
import {
	createPaperEditOps,
	createPaperWriteOps,
	executePaperDelete,
} from "../../coding-agent/examples/extensions/paper/tools.ts";

const zones = vi.hoisted(() => ({
	GUEST_WORKSPACE: "/workspace",
	HARD_MAX_READ_BYTES: 32 * 1024 * 1024,
	createWriteZone: vi.fn(),
	createReadZone: vi.fn(),
	createDockerExecZone: vi.fn(),
	createExecZone: vi.fn(),
	createNetworkZone: vi.fn(),
}));

vi.mock("../../coding-agent/examples/extensions/paper/node_modules/paper-api/dist/index.js", () => zones);

describe("paper Docker session startup", () => {
	beforeEach(() => vi.resetAllMocks());

	it("queues writes and deletions until startup has published its zone", async () => {
		const write = {
			scratchDir: process.cwd(),
			diff: vi.fn().mockResolvedValue([]),
			writeFile: vi.fn().mockResolvedValue(undefined),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			close: vi.fn(),
		};
		const exec = { close: vi.fn(), markLowerDirty: vi.fn() };
		zones.createWriteZone.mockResolvedValue(write);
		zones.createReadZone.mockResolvedValue({ close: vi.fn() });
		let complete!: (value: typeof exec) => void;
		zones.createDockerExecZone.mockReturnValue(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		const session = await openPaperSession(
			process.cwd(),
			{ ...DEFAULT_CONFIG, zone: { ...DEFAULT_CONFIG.zone, backend: "docker", image: "fixture" } },
			"race",
		);
		const startup = session.ensureZone();
		await vi.waitFor(() => expect(zones.createDockerExecZone).toHaveBeenCalledOnce());
		const writing = createPaperWriteOps(session).writeFile("new.ts", "new");
		const deleting = executePaperDelete(session, "old.ts");
		expect(write.writeFile).not.toHaveBeenCalled();
		expect(write.deleteFile).not.toHaveBeenCalled();
		complete(exec);
		await Promise.all([startup, writing, deleting]);
		expect(write.writeFile).toHaveBeenCalledWith("new.ts", "new");
		expect(write.deleteFile).toHaveBeenCalledWith("old.ts");
		expect(exec.markLowerDirty).toHaveBeenCalledTimes(2);
		await session.close();
	});

	it("passes startup cancellation through and closes a late created zone", async () => {
		const exec = { close: vi.fn() };
		zones.createWriteZone.mockResolvedValue({
			scratchDir: process.cwd(),
			diff: vi.fn().mockResolvedValue([]),
			close: vi.fn(),
		});
		zones.createReadZone.mockResolvedValue({ close: vi.fn() });
		const controller = new AbortController();
		zones.createDockerExecZone.mockImplementation(async () => {
			controller.abort();
			return exec;
		});
		const session = await openPaperSession(
			process.cwd(),
			{ ...DEFAULT_CONFIG, zone: { ...DEFAULT_CONFIG.zone, backend: "docker", image: "fixture" } },
			"cancel",
		);
		await expect(session.ensureZone(undefined, controller.signal)).rejects.toThrow();
		expect(zones.createDockerExecZone).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
		expect(exec.close).toHaveBeenCalledOnce();
		expect(session.zone).toBeUndefined();
		await session.close();
	});

	it("edits a file larger than 1 MiB without losing its tail", async () => {
		const original = `old\n${"x".repeat(1024 * 1024)}\nTAIL\n`;
		const write = { scratchDir: process.cwd(), writeFile: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
		const read = {
			close: vi.fn(),
			stat: vi.fn().mockResolvedValue({ type: "file", size: original.length }),
			readFileBytes: vi.fn().mockResolvedValue({ data: Buffer.from(original), truncated: false }),
		};
		zones.createWriteZone.mockResolvedValue(write);
		zones.createReadZone.mockResolvedValue(read);
		const session = await openPaperSession(process.cwd(), DEFAULT_CONFIG, "large-edit");
		const tool = createEditTool(process.cwd(), { operations: createPaperEditOps(session) });
		await tool.execute("edit", { path: "large.txt", edits: [{ oldText: "old", newText: "new" }] });
		expect(read.readFileBytes).toHaveBeenCalledWith("large.txt", { maxBytes: zones.HARD_MAX_READ_BYTES });
		expect(write.writeFile).toHaveBeenCalledWith("large.txt", original.replace("old", "new"));
		read.readFileBytes.mockResolvedValue({ data: Buffer.from("old"), truncated: true });
		await expect(
			tool.execute("oversized", { path: "large.txt", edits: [{ oldText: "old", newText: "new" }] }),
		).rejects.toThrow("Cannot read");
		expect(write.writeFile).toHaveBeenCalledOnce();
		await session.close();
	});

	it("shares one exec zone across concurrent first shell calls", async () => {
		const write = {
			scratchDir: process.cwd(),
			diff: vi.fn().mockResolvedValue([{ status: "deleted", path: "old.ts" }]),
			close: vi.fn(),
		};
		const read = { close: vi.fn() };
		const exec = { close: vi.fn() };
		zones.createWriteZone.mockResolvedValue(write);
		zones.createReadZone.mockResolvedValue(read);
		zones.createDockerExecZone.mockResolvedValue(exec);
		const session = await openPaperSession(
			process.cwd(),
			{
				...DEFAULT_CONFIG,
				zone: { ...DEFAULT_CONFIG.zone, backend: "docker", image: "fixture" },
			},
			"concurrent-startup",
		);
		try {
			const [first, second] = await Promise.all([session.ensureZone(), session.ensureZone()]);
			expect(zones.createDockerExecZone).toHaveBeenCalledTimes(1);
			expect(write.diff).toHaveBeenCalledTimes(1);
			expect(zones.createDockerExecZone).toHaveBeenCalledWith(
				expect.objectContaining({ initialDeletedPaths: ["old.ts"] }),
			);
			expect(first).toBe(second);
			expect(await session.ensureZone()).toBe(first);
		} finally {
			await session.close();
		}
		expect(exec.close).toHaveBeenCalledTimes(1);
	});

	it("allows a shared failed startup to retry without leaving extra zones", async () => {
		const write = {
			scratchDir: process.cwd(),
			diff: vi.fn().mockRejectedValueOnce(new Error("diff failed")).mockResolvedValue([]),
			close: vi.fn(),
		};
		const exec = { close: vi.fn() };
		zones.createWriteZone.mockResolvedValue(write);
		zones.createReadZone.mockResolvedValue({ close: vi.fn() });
		zones.createDockerExecZone.mockResolvedValue(exec);
		const session = await openPaperSession(
			process.cwd(),
			{
				...DEFAULT_CONFIG,
				zone: { ...DEFAULT_CONFIG.zone, backend: "docker", image: "fixture" },
			},
			"retry-startup",
		);
		try {
			const attempts = await Promise.allSettled([session.ensureZone(), session.ensureZone()]);
			expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
			expect(zones.createDockerExecZone).not.toHaveBeenCalled();
			await session.ensureZone();
			expect(zones.createDockerExecZone).toHaveBeenCalledTimes(1);
		} finally {
			await session.close();
		}
	});

	it("deletes staged files, refreshes exec, and rejects paths outside the workspace", async () => {
		const write = {
			scratchDir: process.cwd(),
			diff: vi.fn().mockResolvedValue([]),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			close: vi.fn(),
		};
		const exec = { close: vi.fn(), markLowerDirty: vi.fn() };
		zones.createWriteZone.mockResolvedValue(write);
		zones.createReadZone.mockResolvedValue({ close: vi.fn() });
		zones.createDockerExecZone.mockResolvedValue(exec);
		const session = await openPaperSession(
			process.cwd(),
			{ ...DEFAULT_CONFIG, zone: { ...DEFAULT_CONFIG.zone, backend: "docker", image: "fixture" } },
			"staged-deletion",
		);
		try {
			await session.ensureZone();
			await executePaperDelete(session, "/app/obsolete.txt");
			expect(write.deleteFile).toHaveBeenCalledWith("obsolete.txt");
			expect(exec.markLowerDirty).toHaveBeenCalledTimes(1);
			await expect(executePaperDelete(session, "/etc/passwd")).rejects.toThrow("outside the working directory");
			await expect(executePaperDelete(session, "/app/../../etc/passwd")).rejects.toThrow(
				"outside the working directory",
			);
			expect(write.deleteFile).toHaveBeenCalledTimes(1);
			expect(exec.markLowerDirty).toHaveBeenCalledTimes(1);
		} finally {
			await session.close();
		}
	});
});
