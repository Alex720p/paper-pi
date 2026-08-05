import path from "node:path";

import { closeAll, createReadZone, createWriteZone, type ReadZone, type WriteZone } from "paper-api";

import type { PaperConfig } from "./config.ts";

/**
 * The zones backing one pi session.
 *
 * There is exactly one write zone, and its scratchpad is the single tree everything else agrees
 * on: `read`, `edit`, `grep`, `ls` and `find` see it directly, and `bash` gets it mounted
 * read-only into each throwaway exec container. Without that, the agent would edit a file and
 * then run a test against the version it had just replaced.
 */
export interface PaperSession {
	cwd: string;
	config: PaperConfig;
	/** Staged edits live here. The real tree changes only through `write.commit()`. */
	write: WriteZone;
	/** Present only when `readPaths` is configured; covers paths outside the working directory. */
	read: ReadZone | null;
	close(): Promise<void>;
}

export async function openPaperSession(cwd: string, config: PaperConfig): Promise<PaperSession> {
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

	const read =
		config.readPaths.length > 0
			? await createReadZone({ paths: config.readPaths, resources: config.resources })
			: null;

	return {
		cwd,
		config,
		write,
		read,
		close: async () => {
			await closeAll();
		},
	};
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
