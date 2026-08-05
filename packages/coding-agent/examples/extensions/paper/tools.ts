import path from "node:path";

import {
	type BashOperations,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { execOnce } from "paper-api";

import { locate, outsideError, type PaperSession } from "./session.ts";

/** Where the staged tree is mounted inside every sandboxed command. */
export const SANDBOX_WORKSPACE = "/mnt/0";

const DEFAULT_GREP_LIMIT = 100;
const MAX_WALK_ENTRIES = 20_000;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

// --- the shared read path ----------------------------------------------------

async function readBytes(session: PaperSession, candidate: string): Promise<Buffer> {
	const located = locate(session, candidate);
	if (located.where === "workspace") {
		// The scratchpad, not the real file: the agent must see its own staged edits.
		const result = await session.write.readFileBytes(located.relative);
		return Buffer.from(result.data);
	}
	if (located.where === "read" && session.read) {
		const result = await session.read.readFileBytes(located.path);
		return Buffer.from(result.data);
	}
	throw outsideError(candidate);
}

async function statOf(session: PaperSession, candidate: string): Promise<{ type: string; size: number }> {
	const located = locate(session, candidate);
	if (located.where === "workspace") return session.write.stat(located.relative);
	if (located.where === "read" && session.read) return session.read.stat(located.path);
	throw outsideError(candidate);
}

async function listOf(session: PaperSession, candidate: string): Promise<Array<{ name: string; type: string }>> {
	const located = locate(session, candidate);
	if (located.where === "workspace") return session.write.list(located.relative);
	if (located.where === "read" && session.read) return session.read.list(located.path);
	throw outsideError(candidate);
}

function relativeInWorkspace(session: PaperSession, candidate: string): string {
	const located = locate(session, candidate);
	if (located.where !== "workspace") {
		throw new Error(`${candidate} is outside the working directory. Only files under ${session.cwd} can be edited.`);
	}
	return located.relative;
}

// --- operations --------------------------------------------------------------

export function createPaperReadOps(session: PaperSession): ReadOperations {
	return {
		readFile: (filePath) => readBytes(session, filePath),
		access: async (filePath) => {
			await statOf(session, filePath);
		},
		detectImageMimeType: async (filePath) => {
			switch (path.extname(filePath).toLowerCase()) {
				case ".png":
					return "image/png";
				case ".jpg":
				case ".jpeg":
					return "image/jpeg";
				case ".gif":
					return "image/gif";
				case ".webp":
					return "image/webp";
				default:
					return null;
			}
		},
	};
}

export function createPaperWriteOps(session: PaperSession): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await session.write.writeFile(relativeInWorkspace(session, filePath), content);
		},
		// The scratchpad creates parent directories on write, so there is nothing to do here.
		mkdir: async () => undefined,
	};
}

export function createPaperEditOps(session: PaperSession): EditOperations {
	return {
		readFile: (filePath) => readBytes(session, filePath),
		writeFile: async (filePath, content) => {
			await session.write.writeFile(relativeInWorkspace(session, filePath), content);
		},
		access: async (filePath) => {
			await statOf(session, filePath);
		},
	};
}

export function createPaperLsOps(session: PaperSession): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await statOf(session, filePath);
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => {
			const result = await statOf(session, filePath);
			return { isDirectory: () => result.type === "dir" };
		},
		readdir: async (dirPath) => (await listOf(session, dirPath)).map((entry) => entry.name),
	};
}

// --- find --------------------------------------------------------------------

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalized = pattern.split(path.sep).join(path.posix.sep);
	if (normalized.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalized) || path.posix.matchesGlob(relativePath, `**/${normalized}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalized);
}

/**
 * Walk the staged tree one directory listing at a time.
 *
 * Every step is a container round trip, so this is slower than `fd` — but `fd` would run on the
 * host against the real files, which is exactly what the sandbox exists to prevent. Entries the
 * scratchpad never staged (`.git`, `node_modules`) are already absent, so there is nothing to
 * filter here.
 */
async function walkWorkspace(
	session: PaperSession,
	root: string,
	visit: (relativePath: string) => boolean,
	signal?: AbortSignal,
): Promise<void> {
	let seen = 0;

	const walk = async (dir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		let entries: Array<{ name: string; type: string }>;
		try {
			entries = await session.write.list(dir);
		} catch {
			return true;
		}

		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const child = dir === "." ? entry.name : path.posix.join(dir, entry.name);
			seen += 1;
			if (seen > MAX_WALK_ENTRIES) return false;
			if (entry.type === "dir") {
				if (!(await walk(child))) return false;
				continue;
			}
			if (!visit(child)) return false;
		}
		return true;
	};

	await walk(root);
}

export function createPaperFindOps(session: PaperSession): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await statOf(session, filePath);
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = relativeInWorkspace(session, cwd);
			const results: string[] = [];
			await walkWorkspace(session, root, (relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) {
					results.push(path.join(session.cwd, relativePath));
				}
				return results.length < options.limit;
			});
			return results;
		},
	};
}

// --- grep --------------------------------------------------------------------

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	displayPath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = Math.max(0, params.lineIndex - params.contextLines);
	const end = Math.min(params.lines.length - 1, params.lineIndex + params.contextLines);

	for (let index = start; index <= end; index++) {
		const { text, wasTruncated } = truncateLine((params.lines[index] ?? "").replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.displayPath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

/**
 * grep, run inside the container rather than by spawning ripgrep on the host.
 *
 * `GrepOperations` only covers `isDirectory` and `readFile` — the search itself is a ripgrep
 * spawn the operations object never sees — so sandboxing grep means replacing the whole tool.
 * Matching happens behind the gVisor sentry; only the glob filter and the context lines are
 * assembled here.
 */
export async function executePaperGrep(
	session: PaperSession,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const searchRoot = relativeInWorkspace(session, params.path ?? ".");
	const rootStat = await statOf(session, params.path ?? ".");
	const rootIsDirectory = rootStat.type === "dir";
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

	const matches = await session.write.grep(params.pattern, {
		path: searchRoot,
		// pi treats the pattern as a regex unless `literal` is set. Note that the sandbox greps
		// with POSIX ERE, not ripgrep's Rust regex, so exotic syntax may not carry across.
		regex: params.literal !== true,
		ignoreCase: params.ignoreCase === true,
		// Ask for headroom: the glob filter below may discard some of these.
		maxMatches: effectiveLimit * 4,
	});

	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	const fileLines = new Map<string, string[]>();
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	for (const match of matches) {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (matchCount >= effectiveLimit) {
			matchLimitReached = true;
			break;
		}

		// paper-api reports the host-side path, which for a write zone is inside the scratchpad.
		const relativePath = path.relative(session.write.scratchDir, match.path);
		if (params.glob && !matchesToolGlob(relativePath, params.glob)) continue;

		const displayPath = rootIsDirectory ? relativePath : path.basename(relativePath);

		if (contextLines === 0) {
			const { text, wasTruncated } = truncateLine(match.text.replace(/\r/g, ""));
			if (wasTruncated) linesTruncated = true;
			outputLines.push(`${displayPath}:${match.line}: ${text}`);
		} else {
			let lines = fileLines.get(relativePath);
			if (!lines) {
				// One extra read per matched file, only when context was asked for.
				const content = await session.write.readFile(relativePath);
				lines = content.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				fileLines.set(relativePath, lines);
			}
			if (
				appendGrepBlock({
					outputLines,
					lines,
					displayPath,
					lineIndex: match.line - 1,
					contextLines,
				})
			) {
				linesTruncated = true;
			}
		}
		matchCount++;
	}

	if (matchCount === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("some lines were truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`output truncated to ${DEFAULT_MAX_BYTES} bytes`);
	}
	if (notices.length > 0) output = `${output}\n\n[${notices.join("; ")}]`;

	return { content: [{ type: "text", text: output }], details };
}

// --- bash --------------------------------------------------------------------

export function createPaperBashOps(session: PaperSession): BashOperations {
	return {
		exec: async (command, _cwd, options) => {
			// Only explicitly named variables cross the boundary. The host environment of a
			// coding agent holds provider API keys, and this is the one place running untrusted
			// commands, so forwarding it wholesale would hand them straight over.
			const env: Record<string, string> = {};
			for (const name of session.config.bash.env) {
				const value = process.env[name];
				if (value !== undefined) env[name] = value;
			}

			const timeoutMs =
				options.timeout && options.timeout > 0 ? options.timeout * 1000 : session.config.bash.timeoutMs;

			const result = await execOnce({
				// execOnce takes an argv array; `sh -c` is the caller's choice, not a shell this
				// library builds. The command still runs with no network and read-only mounts.
				command: ["/bin/sh", "-c", command],
				readPaths: [session.write.scratchDir, ...session.config.readPaths],
				workingDir: SANDBOX_WORKSPACE,
				env,
				timeoutMs,
				maxOutputBytes: session.config.bash.maxOutputBytes,
				resources: session.config.resources,
				signal: options.signal,
			});

			// execOnce resolves once, so output arrives in a single chunk rather than streaming.
			if (result.stdout.length > 0) options.onData(Buffer.from(result.stdout));
			if (result.stderr.length > 0) options.onData(Buffer.from(result.stderr));

			if (result.aborted) throw new Error("aborted");
			if (result.timedOut) throw new Error(`timeout:${Math.round(timeoutMs / 1000)}`);
			return { exitCode: result.exitCode };
		},
	};
}
