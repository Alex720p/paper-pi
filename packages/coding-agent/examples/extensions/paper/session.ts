import { realpath } from "node:fs/promises";
import path from "node:path";

import {
	createExecZone,
	createReadZone,
	createWriteZone,
	type ExecZone,
	type ReadZone,
	type WriteZone,
} from "paper-api";

import type { PaperConfig } from "./config.ts";

/**
 * The zones backing one pi session: one container per capability, plus the VM.
 *
 * Both containers bind-mount the same host scratchpad, with opposite postures — read-write for
 * the zone that mutates it, read-only for the zone that inspects it — and the execution zone gets
 * it a third time, read-only, as the lower layer of its overlay.
 *
 * The scratchpad, rather than the real tree, is what everything agrees on because approval is
 * batched: the only prompt is at `agent_end`, so for the rest of a turn the staged tree is the
 * only current view. Reading the real tree instead would hand the agent back the file it had just
 * replaced, and run tests against code it had just changed.
 */
export interface PaperSession {
	cwd: string;
	config: PaperConfig;
	/** Every read: the staged tree at /mnt/0, `config.readPaths` at /mnt/1 onwards. */
	read: ReadZone;
	/** Every mutation, as allowlisted processes in its own container. `commit()` is host-side. */
	write: WriteZone;
	/**
	 * `bash` and `!`. Built lazily by `ensureZone`, because a VM costs a `nix build` and a boot,
	 * and plenty of sessions never run a command at all.
	 */
	zone: ExecZone | undefined;
	ensureZone(onLog?: (line: string) => void): Promise<ExecZone>;
	/**
	 * Realpath of `write.scratchDir`. `createReadZone` resolves its mount host paths, and grep
	 * matches come back relative to the resolved one, so comparing against the unresolved
	 * `scratchDir` would silently fail wherever the temp prefix is a symlink (macOS `/tmp`).
	 */
	scratchRoot: string;
	close(): Promise<void>;
}

export async function openPaperSession(cwd: string, config: PaperConfig, sessionId: string): Promise<PaperSession> {
	const write = await createWriteZone({
		root: cwd,
		files: config.workspace.include,
		allowNewFiles: true,
		seedDirectories: true,
		exclude: config.workspace.exclude,
		maxSeedFiles: config.workspace.maxSeedFiles,
		maxSeedBytes: config.workspace.maxSeedBytes,
		resources: config.resources,
	});

	// The scratchpad is always mount 0, so a workspace-relative path needs no mapping at the call
	// sites: `toContainerPath` resolves a relative path against the first mount.
	let read: ReadZone;
	try {
		read = await createReadZone({
			paths: [write.scratchDir, ...config.readPaths],
			resources: config.resources,
		});
	} catch (error) {
		// The write zone is already up and has already copied the tree; without this its container
		// and scratchpad outlive the failed session.
		await write.close().catch(() => undefined);
		throw error;
	}

	let zone: ExecZone | undefined;
	let startingZone: Promise<ExecZone> | undefined;

	const session: PaperSession = {
		cwd,
		config,
		read,
		write,
		get zone() {
			return zone;
		},
		async ensureZone(onLog) {
			if (zone) return zone;
			if (!config.zone.enabled) {
				throw new Error(
					`The execution zone is disabled ("zone": { "enabled": false } in .pi/paper.json), ` +
						`so there is nowhere to run commands.`,
				);
			}
			if (!startingZone) {
				// Everything but the four knobs this extension owns is a paper-api tuning value,
				// passed straight through so the defaults live in one place.
				const { enabled: _enabled, dir, lowerSource, allowInstall: _allowInstall, ...tuning } = config.zone;
				startingZone = createExecZone({
					zoneDir: path.resolve(cwd, dir),
					// The staged tree, not the real one: `bash` has to see the edits the agent
					// made this turn, and the real tree is deliberately mounted nowhere.
					lowerSource: lowerSource === "cwd" ? cwd : write.scratchDir,
					sessionId,
					...tuning,
					...(onLog ? { onLog } : {}),
				})
					.then((created) => {
						zone = created;
						return created;
					})
					.finally(() => {
						startingZone = undefined;
					});
			}
			return startingZone;
		},
		scratchRoot: await realpath(write.scratchDir),
		close: async () => {
			// Scoped, not `closeAll()`: that tore down every zone the process had registered,
			// including an in-flight fetch_url network zone belonging to nobody here.
			await Promise.allSettled([read.close(), write.close(), zone?.close() ?? Promise.resolve()]);
		},
	};

	return session;
}

/** Where a host path lives, as far as this session is concerned. */
export type Located = { where: "workspace"; relative: string } | { where: "read"; path: string } | { where: "outside" };

export function locate(session: PaperSession, candidate: string): Located {
	const absolute = path.resolve(session.cwd, stripAtPrefix(candidate));
	const relative = path.relative(session.cwd, absolute);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		return { where: "workspace", relative: relative === "" ? "." : relative };
	}
	for (const readPath of session.config.readPaths) {
		const fromRead = path.relative(path.resolve(readPath), absolute);
		if (fromRead === "" || (!fromRead.startsWith("..") && !path.isAbsolute(fromRead))) {
			return { where: "read", path: absolute };
		}
	}
	return { where: "outside" };
}

/** pi passes `@`-prefixed paths through from its file-reference syntax. */
function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function outsideError(candidate: string): Error {
	return new Error(
		`${candidate} is outside the sandbox. Only the working directory and configured readPaths ` +
			`are reachable; add it to readPaths in .pi/paper.json to read it.`,
	);
}
