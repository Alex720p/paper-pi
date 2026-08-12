import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExecZoneTuning } from "paper-api";

/**
 * The execution zone: one microvm.nix VM per session, ephemeral throughout.
 *
 * Everything about how the VM is built and sized — `vcpu`, `memMb`, `upperSizeMb`, `shareProto`,
 * `workspaceMode`, `machine`, the timeouts, `preserveUpperOnRebuild`, `maxPreserveBytes` — comes
 * from paper-api's `ExecZoneTuning` and is passed through untouched, so a knob is documented and
 * defaulted in one place. What is left below is the part that is pi policy rather than VM shape.
 */
export interface ZoneConfig extends ExecZoneTuning {
	/** Off falls back to nothing: `bash` has no backend, so the tool refuses to run. */
	enabled: boolean;
	/** Where the zone's NixOS config lives, relative to the working directory. */
	dir: string;
	/** Which tree the zone sees: the staged scratchpad, or the real working directory. */
	lowerSource: "staged" | "cwd";
	/** Let the agent ask to add nixpkgs attributes to packages.json. */
	allowInstall: boolean;
}

/**
 * Configuration for the paper extension, merged from a global file and a project file the same
 * way pi merges its own settings: project wins, key by key.
 *
 *   ~/.pi/agent/extensions/paper.json
 *   <cwd>/.pi/paper.json
 */
export interface PaperConfig {
	/** Extra host paths the agent may read, outside the working directory. Read-only. */
	readPaths: string[];
	workspace: {
		/** Entries under the working directory to stage, relative to it. */
		include: string[];
		/** Names or relative paths never staged. Matched exactly, no globbing. */
		exclude: string[];
		maxSeedFiles: number;
		maxSeedBytes: number;
	};
	bash: {
		timeoutMs: number;
		maxOutputBytes: number;
		/**
		 * Host environment variables to forward into the sandbox, by name. Empty by default:
		 * the host environment of a coding agent holds provider API keys, and a sandbox whose
		 * whole purpose is running untrusted commands is the last place they belong.
		 */
		env: string[];
	};
	zone: ZoneConfig;
	resources: {
		memoryBytes?: number;
		cpus?: number;
		pidsLimit?: number;
	};
	/**
	 * Commit staged edits without asking. Off by default; without a UI to approve in, a staged
	 * edit that is never committed is safer than one applied silently.
	 */
	autoCommit: boolean;
	transcript: {
		enabled: boolean;
		stateDir?: string;
	};
}

export const DEFAULT_CONFIG: PaperConfig = {
	readPaths: [],
	workspace: {
		include: ["."],
		exclude: [".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".next"],
		maxSeedFiles: 5000,
		maxSeedBytes: 256 * 1024 * 1024,
	},
	bash: {
		timeoutMs: 120_000,
		maxOutputBytes: 1024 * 1024,
		env: [],
	},
	// Anything not named here keeps paper-api's default; see DEFAULT_EXEC_ZONE.
	zone: {
		enabled: true,
		dir: ".pi/zone",
		lowerSource: "staged",
		allowInstall: true,
	},
	resources: {},
	autoCommit: false,
	transcript: {
		enabled: true,
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge; arrays and primitives override wholesale, matching pi's settings merge. */
function mergeInto(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(overrides)) {
		const override = overrides[key];
		if (override === undefined) continue;
		const existing = base[key];
		result[key] = isPlainObject(existing) && isPlainObject(override) ? mergeInto(existing, override) : override;
	}
	return result;
}

async function readJsonIfPresent(file: string): Promise<Record<string, unknown> | null> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isPlainObject(parsed)) throw new Error(`${file} must contain a JSON object`);
	return parsed;
}

export async function loadPaperConfig(cwd: string, agentDir: string): Promise<PaperConfig> {
	const global = await readJsonIfPresent(path.join(agentDir, "extensions", "paper.json"));
	const project = await readJsonIfPresent(path.join(cwd, ".pi", "paper.json"));

	let merged = DEFAULT_CONFIG as unknown as Record<string, unknown>;
	if (global) merged = mergeInto(merged, global);
	if (project) merged = mergeInto(merged, project);
	return merged as unknown as PaperConfig;
}
