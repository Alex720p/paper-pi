/**
 * paper: run pi's tools inside sandboxes, with edits gated on human approval.
 *
 * pi ships no sandbox by design — its built-in tools call node:fs and spawn shells directly on
 * the host. This extension routes all of them elsewhere:
 *
 *   read / ls / grep / find   a gVisor container with the staged tree mounted read-only
 *   write / edit              a second container with it mounted read-write; the real files
 *                             change only on approval
 *   bash / !                  a microvm.nix VM that lives as long as the session: the staged
 *                             tree read-only under a tmpfs overlay, and no network device
 *   fetch_url                 a network container with no filesystem mounts at all
 *
 * One sandbox per capability, so no single one both reads and writes, and the only one that runs
 * arbitrary commands cannot reach the network or the host filesystem.
 *
 * The zone is ephemeral for the whole session rather than for one command: `npm install`, build
 * caches and background servers survive from one `bash` call to the next, and all of it is thrown
 * away when the session ends. A tool the zone does not have is added with `zone_install`, which
 * asks first, edits `.pi/zone/packages.json`, and rebuilds the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/paper
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/paper
 *
 * Requirements: Docker with gVisor registered as the `runsc` runtime (`sudo runsc install`), and
 * Nix with flakes plus KVM for the zone.
 */

import { access } from "node:fs/promises";
import path from "node:path";
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

import {
	createNetworkZone,
	createTranscript,
	type ExecZone,
	nullTranscript,
	scaffoldZoneDir,
	type Transcript,
} from "paper-api";
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
	`Runs in the execution zone: a virtual machine with no network device, holding a copy-on-write ` +
	`view of the working directory at ${SANDBOX_WORKSPACE}.\n\n` +
	`Everything in the zone is ephemeral. It persists for the whole session — files you create, ` +
	`packages you install, servers you start are all still there in your next command — and it is ` +
	`all discarded when the session ends. Nothing you do here reaches the user's real files: to ` +
	`change those, use the write and edit tools, which stage a change for approval.\n\n` +
	`There is no network. If a command needs a program the zone does not have, call zone_install ` +
	`to add it, and fetch_url to read something from the web.`;

const ZONE_PROMPT =
	`Shell commands run in an ephemeral virtual machine ("the zone"), not on the user's machine. ` +
	`The working directory is ${SANDBOX_WORKSPACE} there, holding the same tree as the real ` +
	`working directory plus any edits staged this session.\n` +
	`- The zone keeps its state for the whole session, so an install or a build in one command is ` +
	`still there in the next one. All of it is discarded at the end; none of it touches the real ` +
	`files. Use write and edit for changes the user should keep.\n` +
	`- The zone has no network. When a command fails because a program is missing, call ` +
	`zone_install with the nixpkgs attribute names for it (for example ["nodejs"] for node and ` +
	`npm, ["python3"], ["go"]). The user is asked before anything is installed, and the zone ` +
	`restarts to pick it up.`;

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
	let sessionId = `pid-${process.pid}`;

	async function ensureConfig(): Promise<PaperConfig> {
		if (!config) config = await loadPaperConfig(localCwd, getAgentDir());
		return config;
	}

	async function start(ctx?: ExtensionContext): Promise<PaperSession> {
		const resolved = await ensureConfig();
		ctx?.ui.setStatus("paper", ctx.ui.theme.fg("accent", "paper: staging workspace"));
		const opened = await openPaperSession(localCwd, resolved, sessionId);
		session = opened;
		ctx?.ui.setStatus("paper", ctx.ui.theme.fg("accent", "paper: sandboxed"));
		return opened;
	}

	/** A session costs two containers, so they are built on first use rather than at startup. */
	async function ensureSession(ctx?: ExtensionContext): Promise<PaperSession> {
		if (session) return session;
		if (!starting) {
			starting = start(ctx).finally(() => {
				starting = undefined;
			});
		}
		return starting;
	}

	// --- the execution zone --------------------------------------------------

	function zonePath(resolved: PaperConfig): string {
		return path.resolve(localCwd, resolved.zone.dir);
	}

	/** The zone's NixOS config belongs to the project, so the first run has to put it there. */
	async function ensureZoneDir(ctx?: ExtensionContext): Promise<void> {
		const resolved = await ensureConfig();
		const dir = zonePath(resolved);
		try {
			await access(path.join(dir, "flake.nix"));
			return;
		} catch {
			// Not there yet.
		}

		if (ctx?.hasUI) {
			const approved = await ctx.ui.confirm(
				`Create ${resolved.zone.dir}?`,
				`The execution zone needs a NixOS configuration. This writes flake.nix, zone.nix, ` +
					`packages.json and agent.py into ${dir}. They are yours to edit and commit.`,
			);
			if (!approved) throw new Error(`No execution zone: ${resolved.zone.dir} was not created.`);
		}

		await scaffoldZoneDir(dir);
		ctx?.ui.notify(`Created ${resolved.zone.dir}. Edit zone.nix to change what the zone looks like.`, "info");
	}

	/**
	 * The VM, built on first use. It costs a `nix build` and a boot, and plenty of sessions never
	 * run a command at all, so nothing here happens at startup.
	 */
	async function ensureZone(ctx?: ExtensionContext): Promise<ExecZone> {
		const active = await ensureSession(ctx);
		if (active.zone) return active.zone;
		await ensureZoneDir(ctx);

		const accent = (text: string) => ctx?.ui.theme.fg("accent", text) ?? text;
		ctx?.ui.setStatus("paper", accent("paper: building the zone"));
		try {
			const zone = await active.ensureZone((line) => {
				ctx?.ui.setStatus("paper", accent(`paper: ${line.slice(0, 60)}`));
			});
			ctx?.ui.setStatus("paper", accent(`paper: zone up (cid ${zone.cid})`));
			return zone;
		} catch (error) {
			ctx?.ui.setStatus("paper", ctx.ui.theme.fg("error", "paper: zone failed"));
			throw error;
		}
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
		sessionId = ctx.sessionManager.getSessionId();
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
			// Build the zone here rather than inside the operations, so its `nix build` and boot
			// get the status line and the scaffolding prompt.
			await ensureZone(ctx);
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
		await ensureZone(ctx);
		const active = await ensureSession(ctx);
		return { operations: createPaperBashOps(active) };
	});

	pi.registerTool(
		defineTool({
			name: "zone_install",
			label: "Install",
			description:
				"Add packages to the execution zone, for when a command fails because a program is " +
				"missing. Takes nixpkgs attribute names, not the names of the commands themselves: " +
				'["nodejs"] gives you node and npm, ["python3"] gives you python3 and pip, ' +
				'["go"], ["rustc", "cargo"], ["jq"].\n\n' +
				"The user is asked before anything is installed. On approval the names are appended " +
				"to .pi/zone/packages.json and the zone is rebuilt and restarted, which takes a " +
				"while; files you created in the zone are carried across, but running processes are " +
				"not. There is no other way to install anything: the zone has no network.",
			promptSnippet: "zone_install: add packages to the execution zone (asks the user first)",
			parameters: Type.Object({
				packages: Type.Array(Type.String(), {
					description: 'nixpkgs attribute names, for example ["nodejs"] or ["python3", "uv"]',
				}),
				reason: Type.String({
					description: "Why they are needed. Shown to the user in the approval prompt.",
				}),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const resolved = await ensureConfig();
				if (!resolved.zone.allowInstall) {
					throw new Error(
						`Installing into the zone is disabled ("zone": { "allowInstall": false }). ` +
							`Add the packages to ${resolved.zone.dir}/packages.json by hand.`,
					);
				}
				if (params.packages.length === 0) throw new Error("No packages given.");

				const zone = await ensureZone(ctx);
				const current = await zone.packages();
				const wanted = params.packages.filter((name) => !current.includes(name));
				if (wanted.length === 0) {
					return {
						content: [{ type: "text", text: `Already in the zone: ${params.packages.join(", ")}` }],
						details: undefined,
					};
				}

				// Resolving first means a typo costs an eval instead of a five-minute build.
				const { unknown } = await zone.resolvePackages(wanted);
				if (unknown.length > 0) {
					throw new Error(
						`No such nixpkgs attribute: ${unknown.join(", ")}. Use the attribute name, not the ` +
							`command name — search https://search.nixos.org/packages for the right one.`,
					);
				}

				if (!ctx.hasUI) {
					// Same posture as staged edits: without someone to ask, nothing changes.
					throw new Error(
						`Cannot install ${wanted.join(", ")}: there is no UI to approve it. Add them to ` +
							`${resolved.zone.dir}/packages.json and restart.`,
					);
				}

				const approved = await ctx.ui.confirm(
					`Add ${wanted.join(", ")} to the execution zone?`,
					`${params.reason}\n\n${resolved.zone.dir}/packages.json\n${wanted.map((name) => `+ ${name}`).join("\n")}\n\n` +
						`The zone will be rebuilt and restarted.`,
				);
				if (!approved) {
					return {
						content: [
							{
								type: "text",
								text: `The user declined to install ${wanted.join(", ")}. Carry on without it, or find another way.`,
							},
						],
						details: undefined,
					};
				}

				const accent = (text: string) => ctx.ui.theme.fg("accent", text);
				ctx.ui.setStatus("paper", accent(`paper: installing ${wanted.join(", ")}`));
				try {
					const result = await zone.install(wanted, (line) => {
						ctx.ui.setStatus("paper", accent(`paper: ${line.slice(0, 60)}`));
					});
					ctx.ui.setStatus("paper", accent(`paper: zone up (cid ${zone.cid})`));

					const lines = [`Installed ${result.added.join(", ")}. The zone restarted to pick them up.`];
					if (result.preserveSkipped) {
						lines.push(
							"Files you had created in the zone were too large to carry across the restart, " +
								"so the workspace is back to its staged state.",
						);
					} else if (result.preservedBytes !== undefined) {
						lines.push("Files you had created in the zone were carried across; running processes were not.");
					}
					return { content: [{ type: "text", text: lines.join(" ") }], details: undefined };
				} catch (error) {
					ctx.ui.setStatus("paper", ctx.ui.theme.fg("error", "paper: install failed"));
					throw error;
				}
			},
		}),
	);

	pi.registerCommand("zone", {
		description: "Show, restart or scaffold the execution zone",
		handler: async (args, ctx) => {
			const resolved = await ensureConfig();
			const sub = args.trim();

			if (sub === "init") {
				await ensureZoneDir(ctx);
				return;
			}

			if (sub === "restart") {
				const zone = await ensureZone(ctx);
				ctx.ui.setStatus("paper", ctx.ui.theme.fg("accent", "paper: restarting the zone"));
				await zone.restart((line) => {
					ctx.ui.setStatus("paper", ctx.ui.theme.fg("accent", `paper: ${line.slice(0, 60)}`));
				});
				ctx.ui.setStatus("paper", ctx.ui.theme.fg("accent", `paper: zone up (cid ${zone.cid})`));
				ctx.ui.notify("The zone restarted. Everything it held is gone.", "info");
				return;
			}

			if (!session?.zone) {
				ctx.ui.notify(
					`The zone is not running; it starts with the first command.\nConfig: ${resolved.zone.dir}\n` +
						`Try "/zone restart" to start it now, or "/zone init" to scaffold the config.`,
					"info",
				);
				return;
			}

			const zone = session.zone;
			const status = zone.status();
			ctx.ui.notify(
				[
					`Zone: cid ${status.cid}, pid ${status.pid ?? "?"}, ${status.restarts} restart(s)`,
					`Workspace: ${SANDBOX_WORKSPACE} (overlay over ${status.lowerSource}, read-only)`,
					`Config: ${resolved.zone.dir}`,
					`Packages: ${(await zone.packages()).join(", ")}`,
					`Session dir: ${status.sessionDir}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${ZONE_PROMPT}` };
	});
}
