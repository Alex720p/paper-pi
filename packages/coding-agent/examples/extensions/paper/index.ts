/**
 * paper: run pi's tools inside gVisor sandboxes, with edits gated on human approval.
 *
 * pi ships no sandbox by design — its built-in tools call node:fs and spawn shells directly on
 * the host. This extension routes all of them through paper-api's zones instead:
 *
 *   read / ls / grep / find   a container with the staged tree mounted, no network, no exec
 *   write / edit              staged in a scratchpad; the real files change only on approval
 *   bash / !                  a throwaway gVisor container: read-only, no network, discarded
 *   fetch_url                 a network container with no filesystem mounts at all
 *
 * Two consequences worth knowing before you start, both deliberate:
 *   - sandboxed bash cannot persist anything, so formatters and code generators do nothing;
 *   - sandboxed bash has no network, so installs and fetches fail. Use fetch_url.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/paper
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/paper
 *
 * Requirements: Docker, and gVisor registered as the `runsc` runtime (`sudo runsc install`).
 */
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type GrepToolInput,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createNetworkZone, createTranscript, nullTranscript, type Transcript } from "paper-api";
import { Type } from "typebox";

import { loadPaperConfig, type PaperConfig } from "./config.ts";
import { openPaperSession, type PaperSession } from "./session.ts";
import {
	createPaperBashOps,
	createPaperEditOps,
	createPaperFindOps,
	createPaperLsOps,
	createPaperReadOps,
	createPaperWriteOps,
	executePaperGrep,
	SANDBOX_WORKSPACE,
} from "./tools.ts";

const SANDBOX_NOTE =
	`Runs in a gVisor sandbox with no network access. The working directory is mounted at ` +
	`${SANDBOX_WORKSPACE} and is read-only, so nothing this command writes survives — use the ` +
	`write and edit tools to change files, and fetch_url to reach the network.`;

export default function (pi: ExtensionAPI): void {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);

	let config: PaperConfig | undefined;
	let session: PaperSession | undefined;
	let starting: Promise<PaperSession> | undefined;
	let transcript: Transcript = nullTranscript;

	async function ensureConfig(): Promise<PaperConfig> {
		if (!config) config = await loadPaperConfig(localCwd, getAgentDir());
		return config;
	}

	async function start(ctx?: ExtensionContext): Promise<PaperSession> {
		const resolved = await ensureConfig();
		ctx?.ui.setStatus("paper", ctx.ui.theme.fg("accent", "paper: staging workspace"));
		const opened = await openPaperSession(localCwd, resolved);
		session = opened;
		ctx?.ui.setStatus("paper", ctx.ui.theme.fg("accent", "paper: sandboxed"));
		return opened;
	}

	/** Zones cost a container each, so they are built on first use rather than at startup. */
	async function ensureSession(ctx?: ExtensionContext): Promise<PaperSession> {
		if (session) return session;
		if (!starting) {
			starting = start(ctx).finally(() => {
				starting = undefined;
			});
		}
		return starting;
	}

	// --- approval ------------------------------------------------------------

	function describeDiff(entry: {
		path: string;
		status: string;
		additions: number;
		deletions: number;
		binary: boolean;
	}): string {
		if (entry.binary) return `${entry.path} (${entry.status}, binary)`;
		return `${entry.path} (${entry.status}, +${entry.additions}/-${entry.deletions})`;
	}

	function reportCommit(
		ctx: ExtensionContext,
		result: { committed: string[]; skipped: string[]; conflicts: string[] },
	): void {
		const lines: string[] = [];
		if (result.committed.length > 0) lines.push(`Applied: ${result.committed.join(", ")}`);
		if (result.skipped.length > 0) lines.push(`Nothing to apply: ${result.skipped.join(", ")}`);
		if (result.conflicts.length > 0) {
			// The real file moved under us; committing anyway would silently discard whatever
			// else touched it.
			lines.push(`Changed on disk since staging, left alone: ${result.conflicts.join(", ")}`);
		}
		ctx.ui.notify(lines.join("\n") || "Nothing to apply.", result.conflicts.length > 0 ? "warning" : "info");
	}

	async function reviewStagedEdits(ctx: ExtensionContext, quietWhenEmpty: boolean): Promise<void> {
		const active = await ensureSession(ctx);
		const diffs = await active.write.diff();

		if (diffs.length === 0) {
			if (!quietWhenEmpty) ctx.ui.notify("No staged changes.", "info");
			return;
		}

		if (!ctx.hasUI) {
			// Nothing can be approved without a UI. Failing closed leaves the edits staged and
			// the real tree untouched, which is the recoverable half of the two options.
			if (!active.config.autoCommit) {
				ctx.ui.notify(
					`${diffs.length} staged change(s) left unapplied: no UI to approve them. ` +
						`Set "autoCommit": true in .pi/paper.json to apply them without asking.`,
					"warning",
				);
				return;
			}
			reportCommit(ctx, await active.write.commit());
			return;
		}

		ctx.ui.notify(`Staged changes:\n${diffs.map((entry) => `  ${describeDiff(entry)}`).join("\n")}`, "info");

		const choice = await ctx.ui.select(`Apply ${diffs.length} staged change(s)?`, [
			"Apply all",
			"Review each",
			"Show diffs",
			"Discard all",
			"Keep staged",
		]);

		if (choice === "Apply all") {
			reportCommit(ctx, await active.write.commit());
			return;
		}

		if (choice === "Show diffs") {
			for (const entry of diffs) {
				ctx.ui.notify(entry.binary ? `${entry.path}: binary change, no diff to show` : entry.unified, "info");
			}
			await reviewStagedEdits(ctx, quietWhenEmpty);
			return;
		}

		if (choice === "Review each") {
			const approved: string[] = [];
			for (const entry of diffs) {
				const body = entry.binary ? "Binary change; there is no diff to show." : entry.unified;
				if (await ctx.ui.confirm(`Apply ${describeDiff(entry)}?`, body)) approved.push(entry.path);
			}
			if (approved.length === 0) {
				ctx.ui.notify("Nothing applied; changes are still staged.", "info");
				return;
			}
			reportCommit(ctx, await active.write.commit(approved));
			return;
		}

		if (choice === "Discard all") {
			if (await ctx.ui.confirm("Discard all staged changes?", diffs.map(describeDiff).join("\n"))) {
				await active.write.discard();
				ctx.ui.notify("Staged changes discarded.", "info");
			}
			return;
		}

		ctx.ui.notify("Changes left staged. Run /paper to review them later.", "info");
	}

	// --- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const resolved = await ensureConfig();
		if (resolved.transcript.enabled) {
			// Created eagerly: it needs no container, and a transcript that starts at the first
			// tool call would miss the prompt that caused it.
			transcript = await createTranscript({
				sessionId: ctx.sessionManager.getSessionId(),
				...(resolved.transcript.stateDir ? { stateDir: resolved.transcript.stateDir } : {}),
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const active = session;
		session = undefined;
		starting = undefined;
		try {
			if (active) {
				const pending = await active.write.diff().catch(() => []);
				if (pending.length > 0) {
					ctx.ui.notify(
						`Discarding ${pending.length} unapplied staged change(s): ` +
							`${pending.map((entry) => entry.path).join(", ")}`,
						"warning",
					);
				}
				await active.close();
			}
			await transcript.close();
		} finally {
			transcript = nullTranscript;
			ctx.ui.setStatus("paper", undefined);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!session) return;
		await reviewStagedEdits(ctx, true);
	});

	pi.registerCommand("paper", {
		description: "Review and apply staged edits from the sandbox",
		handler: async (_args, ctx) => {
			await reviewStagedEdits(ctx, false);
		},
	});

	// --- transcript ----------------------------------------------------------

	pi.on("input", (event) => {
		transcript.userMessage(event.text);
	});

	pi.on("tool_call", (event) => {
		transcript.toolCall(event.toolName, event.input, { callId: event.toolCallId });
	});

	pi.on("tool_result", (event) => {
		transcript.toolResult(event.toolCallId, event.content, { ok: !event.isError });
	});

	// --- tools ---------------------------------------------------------------

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createReadTool(localCwd, { operations: createPaperReadOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		description: `${localWrite.description}\n\nThe change is staged for human approval; the real file is not modified until it is applied.`,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createWriteTool(localCwd, { operations: createPaperWriteOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		description: `${localEdit.description}\n\nThe change is staged for human approval; the real file is not modified until it is applied.`,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createEditTool(localCwd, { operations: createPaperEditOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createLsTool(localCwd, { operations: createPaperLsOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createFindTool(localCwd, { operations: createPaperFindOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		description: `${localBash.description}\n\n${SANDBOX_NOTE}`,
		async execute(id, params, signal, onUpdate, ctx) {
			const active = await ensureSession(ctx);
			const tool = createBashTool(localCwd, { operations: createPaperBashOps(active) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// grep is not just an operations swap: the search itself is a ripgrep spawn that
	// GrepOperations never sees. Spreading the built-in keeps its parameters, renderers and
	// details shape; only the execute body is ours.
	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const active = await ensureSession(ctx);
			// The schema came from the built-in via the spread, so this is that schema's shape;
			// the spread widens it to TSchema, which erases the inference.
			return executePaperGrep(active, params as GrepToolInput, signal);
		},
	});

	pi.registerTool(
		defineTool({
			name: "fetch_url",
			label: "Fetch",
			description:
				"Fetch a URL and return the response body. Runs in a container with network access " +
				"and no filesystem mounts whatsoever, so nothing local can be sent out through it. " +
				"This is the only tool with network access.",
			promptSnippet: "fetch_url: fetch a URL from an isolated network sandbox",
			parameters: Type.Object({
				url: Type.String({ description: "The URL to fetch" }),
			}),
			async execute(_id, params, signal) {
				// A fresh zone per fetch keeps the blast radius to a single request.
				const net = await createNetworkZone({ allowedBinaries: ["wget"] });
				try {
					const result = await net.exec(["wget", "-q", "-O-", "--timeout=20", params.url], {
						signal,
					});
					if (result.exitCode !== 0) {
						throw new Error(result.stderr.trim() || `wget exited with code ${result.exitCode}`);
					}
					const text = result.truncated ? `${result.stdout}\n\n[output truncated]` : result.stdout;
					return { content: [{ type: "text", text }], details: undefined };
				} finally {
					await net.close();
				}
			},
		}),
	);

	pi.on("user_bash", async (_event, ctx) => {
		const active = await ensureSession(ctx);
		return { operations: createPaperBashOps(active) };
	});
}
