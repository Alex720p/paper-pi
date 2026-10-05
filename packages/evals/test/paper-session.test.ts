import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../coding-agent/examples/extensions/paper/config.ts";
import { openPaperSession } from "../../coding-agent/examples/extensions/paper/session.ts";
import { executePaperDelete } from "../../coding-agent/examples/extensions/paper/tools.ts";

const zones = vi.hoisted(() => ({
	GUEST_WORKSPACE: "/workspace",
	createWriteZone: vi.fn(),
	createReadZone: vi.fn(),
	createDockerExecZone: vi.fn(),
	createExecZone: vi.fn(),
	createNetworkZone: vi.fn(),
}));

vi.mock("../../coding-agent/examples/extensions/paper/node_modules/paper-api/dist/index.js", () => zones);

describe("paper Docker session startup", () => {
	beforeEach(() => vi.resetAllMocks());

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
