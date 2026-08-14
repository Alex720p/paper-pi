import { realpath } from "node:fs/promises";
import path from "node:path";

import {
	createExecZone,
	createNetworkZone,
	createReadZone,
	createWriteZone,
	type ExecZone,
	type NetworkZone,
	type ReadZone,
	type WriteZone,
} from "paper-api";

import type { PaperConfig } from "./config.ts";

/**
 * The zones backing one pi session: one container per capability, plus the VM. Every one of them
 * lives as long as the session does — built on first use, torn down by `close()`.
 *
 * The two file containers bind-mount the same host scratchpad, with opposite postures —
 * read-write for the zone that mutates it, read-only for the zone that inspects it — and the
 * execution zone gets it a third time, read-only, as the lower layer of its overlay. The network
 * container is the odd one out: it mounts nothing at all, which is what buys it connectivity.
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
	 * `fetch_url`. Built lazily by `ensureNetZone`, like the VM: it is the one sandbox with
	 * connectivity, and plenty of sessions never fetch anything at all.
	 */
	net: NetworkZone | undefined;
	ensureNetZone(): Promise<NetworkZone>;
	/**
	 * Realpath of `write.scratchDir`. `createReadZone` resolves its mount host paths, and grep
	 * matches come back relative to the resolved one, so comparing against the unresolved
	 * `scratchDir` would silently fail wherever the temp prefix is a symlink (macOS `/tmp`).
	 */
	scratchRoot: string;
	/**
	 * `config.readPaths`, realpath'd. The read zone resolves its mount host paths, so a readPath
	 * that goes through a symlink is reachable by neither spelling otherwise: the configured one
	 * fails the zone's own check, and the resolved one looks like it was never configured.
	 */
	readRoots: string[];
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
	let net: NetworkZone | undefined;
	let startingNet: Promise<NetworkZone> | undefined;

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
					// Tuning goes first because it is whatever was left in an untyped JSON file:
					// a `zoneDir`, `sessionId` or `onLog` typed into .pi/paper.json must not win
					// over what this session computed. `onLog` is passed unconditionally for the
					// same reason — the library calls it, so a string from a config file would
					// throw mid-build.
					...tuning,
					zoneDir: path.resolve(cwd, dir),
					// The staged tree, not the real one: `bash` has to see the edits the agent
					// made this turn, and the real tree is deliberately mounted nowhere.
					lowerSource: lowerSource === "cwd" ? cwd : write.scratchDir,
					sessionId,
					onLog,
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
		get net() {
			return net;
		},
		async ensureNetZone() {
			// Only a ready handle is reusable. A zone closed out from under the session — the
			// signal handler's `closeAll()`, an idle timeout somebody configures later — would
			// otherwise be handed back to throw `ZoneClosedError` on every fetch for the rest of
			// the session, when rebuilding it costs one container start.
			if (net?.status().state === "ready") return net;
			if (!startingNet) {
				startingNet = createNetworkZone({
					// wget only: the zone's own allowlist already bars interpreters, and this is
					// the single binary `fetch_url` knows how to read the output of.
					allowedBinaries: ["wget"],
					resources: config.resources,
				})
					.then((created) => {
						net = created;
						return created;
					})
					.finally(() => {
						startingNet = undefined;
					});
			}
			return startingNet;
		},
		scratchRoot: await realpath(write.scratchDir),
		readRoots: await Promise.all(
			config.readPaths.map(async (candidate) => {
				const absolute = path.resolve(candidate);
				// A readPath that does not exist yet is kept as configured rather than dropped:
				// the read zone will reject it with its own message.
				return realpath(absolute).catch(() => absolute);
			}),
		),
		close: async () => {
			// Scoped, not `closeAll()`: that tore down every zone the process had registered,
			// including any a host application had opened alongside this session.
			//
			// The in-flight cases matter as much as the settled ones: quitting while the VM's
			// first boot is still running (a cold `nix build` is minutes) left a qemu and a
			// virtiofsd exporting the scratchpad for the rest of the process's life, because
			// `zone` was still undefined. A fetch racing the shutdown leaks the same way.
			const closingZone = zone
				? zone.close()
				: (startingZone?.then((created) => created.close()) ?? Promise.resolve());
			const closingNet = net ? net.close() : (startingNet?.then((created) => created.close()) ?? Promise.resolve());
			await Promise.allSettled([read.close(), write.close(), closingZone, closingNet]);
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
	for (const readPath of session.readRoots) {
		const fromRead = path.relative(readPath, absolute);
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
