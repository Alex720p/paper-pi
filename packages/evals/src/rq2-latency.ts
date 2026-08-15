/**
 * RQ2: per-tool-call latency of the paper prototype against the original Pi Agent Harness.
 *
 *   node_modules/.bin/tsx --tsconfig tsconfig.json \
 *     packages/evals/src/rq2-latency.ts --trials 5 --reps 20 --warmup 3
 *
 * Both arms are driven through the fake-session interface, so an identical tool-call sequence runs
 * with no model and no provider credentials. The only difference between them is whether the paper
 * extension is loaded.
 *
 * The reported metric is the interval between the harness's `tool_execution_start` and
 * `tool_execution_end` events: argument validation plus the tool's own execute, and nothing of the
 * agent loop, session persistence or the driver. Zone startup is measured separately from the first
 * warmup call and never folded into the per-tool numbers.
 *
 * Needs paper's prerequisites for the prototype arm: Docker with gVisor registered as `runsc`, Nix
 * with flakes, and KVM.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	initTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FakeSessionDriver } from "./fake-session/driver.ts";
import { createFakeModelRuntime } from "./fake-session/model.ts";

const PAPER_EXTENSION = fileURLToPath(new URL("../../coding-agent/examples/extensions/paper", import.meta.url));

/**
 * Every tool paper overrides. Tools are measured one group at a time, and this order is what makes
 * the one-time costs separable:
 *
 * - `read` first, so its first call pays for opening the paper session (staging plus both
 *   containers) and nothing else.
 * - `bash` second, so its first call pays for booting the microVM alone. Run later it would also
 *   absorb an overlay refresh, because `write` and `edit` call `markLowerDirty()` and the next
 *   `bash` re-syncs the zone's lower layer. Measuring interleaved puts that refresh inside every
 *   `bash` sample and attributes another tool's cost to the shell.
 * - `ls`, `grep` and `find` before the mutating tools, so they always see the fixture and nothing
 *   else. Run after `write`, they would also see its `out-*.txt` files, making their latency a
 *   function of `--reps` rather than of the stated fixture size.
 * - `write` and `edit` last, since nothing after them can then be polluted by what they create.
 */
const ALL_TOOLS = ["read", "bash", "ls", "grep", "find", "write", "edit"] as const;
type ToolName = (typeof ALL_TOOLS)[number];

/** Fixture size is part of the result: ls, grep and find all scale with it. */
const FIXTURE_SOURCE_FILES = 20;

interface Options {
	trials: number;
	warmup: number;
	reps: number;
	tools: ToolName[];
	json: string | undefined;
}

function parseOptions(argv: string[]): Options {
	const options: Options = { trials: 5, warmup: 3, reps: 20, tools: [...ALL_TOOLS], json: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		const requireValue = (): string => {
			if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
			index++;
			return value;
		};
		if (arg === "--trials") options.trials = Number.parseInt(requireValue(), 10);
		else if (arg === "--warmup") options.warmup = Number.parseInt(requireValue(), 10);
		else if (arg === "--reps") options.reps = Number.parseInt(requireValue(), 10);
		else if (arg === "--json") options.json = requireValue();
		else if (arg === "--tools") {
			const names = requireValue()
				.split(",")
				.map((name) => name.trim());
			for (const name of names) {
				if (!ALL_TOOLS.includes(name as ToolName)) throw new Error(`unknown tool: ${name}`);
			}
			options.tools = names as ToolName[];
		} else if (arg === "--help" || arg === "-h") {
			console.log("usage: rq2-latency.ts [--trials n] [--warmup n] [--reps n] [--tools a,b] [--json path]");
			process.exit(0);
		} else throw new Error(`unknown argument: ${arg}`);
	}
	for (const [name, count] of [
		["trials", options.trials],
		["warmup", options.warmup],
		["reps", options.reps],
	] as const) {
		if (!Number.isInteger(count) || count < 1) throw new Error(`--${name} must be a positive integer`);
	}
	return options;
}

interface Stats {
	n: number;
	mean: number;
	sd: number;
}

function summarize(values: number[]): Stats {
	const n = values.length;
	if (n === 0) return { n: 0, mean: Number.NaN, sd: Number.NaN };
	const mean = values.reduce((total, value) => total + value, 0) / n;
	// Sample standard deviation; n === 1 has no spread to report.
	const variance = n < 2 ? 0 : values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1);
	return { n, mean, sd: Math.sqrt(variance) };
}

/**
 * Arguments for one call. `index` keeps written and edited paths distinct so repetitions never
 * interfere: an edit that has already been applied would not match a second time.
 */
function argsFor(tool: ToolName, index: number): Record<string, unknown> {
	if (tool === "read") return { path: "seed.txt" };
	if (tool === "bash") return { command: "true" };
	// Per-repetition files live under out/ and edits/, and the read-only tools are pointed at src/,
	// so the tree they walk is exactly FIXTURE_SOURCE_FILES whatever --reps and --warmup are set to.
	// Scoped to "." instead, ls and grep grow with the repetition count and stop being comparable
	// between configurations: they moved 56% and 25% between 5x20 and 3x30 before this.
	if (tool === "write") return { path: `out/out-${index}.txt`, content: `payload ${index}\n` };
	if (tool === "edit") return { path: `edits/edit-${index}.txt`, edits: [{ oldText: "VALUE_A", newText: "VALUE_B" }] };
	if (tool === "ls") return { path: "src" };
	if (tool === "grep") return { pattern: "answer", path: "src" };
	return { pattern: "*.ts", path: "src" };
}

async function createFixture(withPaper: boolean, editTargets: number[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), withPaper ? "rq2-proto-" : "rq2-orig-"));
	const cwd = join(root, "workspace");
	await Promise.all([mkdir(cwd), mkdir(join(root, "agent"))]);
	// src/ is the tree the read-only tools measure and is a fixed size; out/ and edits/ hold the
	// per-repetition files and are deliberately outside it.
	await mkdir(join(cwd, "src"), { recursive: true });
	await mkdir(join(cwd, "out"), { recursive: true });
	await mkdir(join(cwd, "edits"), { recursive: true });
	for (let index = 0; index < FIXTURE_SOURCE_FILES; index++) {
		await writeFile(join(cwd, "src", `mod-${index}.ts`), `export const answer${index} = ${index};\n`);
	}
	await writeFile(join(cwd, "seed.txt"), "seed line one\nseed line two\n");
	for (const index of editTargets) {
		await writeFile(join(cwd, "edits", `edit-${index}.txt`), "VALUE_A\nfiller\n");
	}
	if (withPaper) {
		// paper's tool_call/tool_result hooks append to a JSONL transcript, and that write happens
		// inside the measured span. Disabling it leaves the span as validation plus execute on both
		// sides. The zone directory is scaffolded by paper itself on the first bash call.
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "paper.json"), JSON.stringify({ transcript: { enabled: false } }, null, 2));
	}
	return root;
}

interface Arm {
	root: string;
	session: AgentSession;
	driver: FakeSessionDriver;
	/** Milliseconds of the last completed tool execution, from the session's own events. */
	lastSpanMs: () => number;
}

async function openArm(withPaper: boolean, editTargets: number[]): Promise<Arm> {
	const root = await createFixture(withPaper, editTargets);
	const cwd = join(root, "workspace");
	const { modelRuntime, model, faux } = await createFakeModelRuntime();
	const services = await createAgentSessionServices({
		cwd,
		agentDir: join(root, "agent"),
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		...(withPaper ? { resourceLoaderOptions: { additionalExtensionPaths: [PAPER_EXTENSION] } } : {}),
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		model,
		thinkingLevel: "off",
		// The default active set is read/bash/edit/write; without this ls, grep and find return
		// "tool not found" in microseconds and quietly look like an enormous speedup.
		tools: [...ALL_TOOLS],
	});
	if (withPaper) {
		const loaded = session.extensionRunner.getExtensionPaths();
		if (!loaded.some((path) => path.includes("paper"))) {
			throw new Error("the paper extension did not load; the prototype arm would measure the host tools");
		}
	}

	const started = new Map<string, number>();
	let lastSpan = Number.NaN;
	session.subscribe((event) => {
		if (event.type === "tool_execution_start") started.set(event.toolCallId, performance.now());
		if (event.type === "tool_execution_end") {
			const begin = started.get(event.toolCallId);
			if (begin !== undefined) lastSpan = performance.now() - begin;
			started.delete(event.toolCallId);
		}
	});

	return {
		root,
		session,
		driver: new FakeSessionDriver({ session, faux, stepTimeoutMs: 600_000 }),
		lastSpanMs: () => lastSpan,
	};
}

async function closeArm(arm: Arm): Promise<void> {
	await arm.driver.dispose();
	// `dispose()` is synchronous and does not emit session_shutdown, so on its own it leaves paper's
	// containers and VM running. One process here opens many sessions in a row, and leaked sandboxes
	// contend with the next trial: measured against leaked ones, VM boot went from 14s to 110s and
	// every read-zone call drifted upward. This mirrors AgentSessionRuntime.teardownCurrent().
	await arm.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	arm.session.dispose();
	await rm(arm.root, { recursive: true, force: true });
}

interface TrialResult {
	/** Measured spans per tool, warmup excluded. */
	spans: Map<ToolName, number[]>;
	/** First-call span per tool, which is the only call that pays one-time setup. */
	firstCall: Map<ToolName, number>;
}

async function runTrial(withPaper: boolean, options: Options, label: string): Promise<TrialResult> {
	const total = options.warmup + options.reps;
	const editTargets = Array.from({ length: total }, (_value, index) => index);
	const arm = await openArm(withPaper, editTargets);
	const spans = new Map<ToolName, number[]>(options.tools.map((tool) => [tool, []]));
	const firstCall = new Map<ToolName, number>();

	try {
		await arm.driver.start("RQ2 latency workload.");
		// One tool at a time, in ALL_TOOLS order, so a group's samples are consecutive and no other
		// tool's side effects land inside them.
		for (const tool of ALL_TOOLS) {
			if (!options.tools.includes(tool)) continue;
			for (let pass = 0; pass < total; pass++) {
				const result = await arm.driver.toolCall(tool, argsFor(tool, pass));
				if (result.isError) {
					// Never let a failing tool into the statistics: an error path is fast and would be
					// reported as a speedup.
					throw new Error(
						`${label}: ${tool} failed on pass ${pass}: ${result.text.replace(/\n/g, " ").slice(0, 200)}`,
					);
				}
				const span = arm.lastSpanMs();
				if (!firstCall.has(tool)) firstCall.set(tool, span);
				if (pass >= options.warmup) spans.get(tool)?.push(span);
				process.stderr.write(`\r${label}: ${tool} ${pass + 1}/${total}      `);
			}
		}
		await arm.driver.finish("Done.");
	} finally {
		process.stderr.write("\r");
		await closeArm(arm);
	}
	return { spans, firstCall };
}

function formatStats(stats: Stats): string {
	if (stats.n === 0) return "n/a";
	return `${stats.mean.toFixed(2).padStart(8)} ± ${stats.sd.toFixed(2).padStart(7)}`;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	// paper's tools render through Pi's theme, which the CLI initializes at startup and a
	// programmatic session does not. Without this every tool call fails with "Theme not initialized".
	initTheme("dark");

	const startedAt = performance.now();
	const original = new Map<ToolName, number[]>(options.tools.map((tool) => [tool, []]));
	const prototype = new Map<ToolName, number[]>(options.tools.map((tool) => [tool, []]));
	const sessionOpenMs: number[] = [];
	const zoneBootMs: number[] = [];

	for (let trial = 1; trial <= options.trials; trial++) {
		// Interleaved, so a slow patch of machine time cannot land entirely on one arm.
		const originalTrial = await runTrial(false, options, `trial ${trial}/${options.trials} original`);
		for (const [tool, values] of originalTrial.spans) original.get(tool)?.push(...values);

		const prototypeTrial = await runTrial(true, options, `trial ${trial}/${options.trials} prototype`);
		for (const [tool, values] of prototypeTrial.spans) prototype.get(tool)?.push(...values);

		// read is measured first and bash second, so the first read pays for opening the paper
		// session (staging plus both containers) and the first bash pays for booting the microVM.
		const warmRead = summarize(prototypeTrial.spans.get("read") ?? []);
		const warmBash = summarize(prototypeTrial.spans.get("bash") ?? []);
		const firstRead = prototypeTrial.firstCall.get("read");
		const firstBash = prototypeTrial.firstCall.get("bash");
		if (firstRead !== undefined && warmRead.n > 0) sessionOpenMs.push(firstRead - warmRead.mean);
		if (firstBash !== undefined && warmBash.n > 0) zoneBootMs.push(firstBash - warmBash.mean);
	}

	const rows = options.tools.map((tool) => {
		const a = summarize(original.get(tool) ?? []);
		const b = summarize(prototype.get(tool) ?? []);
		return { tool, original: a, prototype: b, slowdown: a.mean > 0 ? b.mean / a.mean : Number.NaN };
	});

	const lines: string[] = [];
	lines.push("");
	lines.push("RQ2 tool-call latency: paper prototype vs original Pi Agent Harness");
	lines.push(
		`config: trials=${options.trials} warmup=${options.warmup} reps=${options.reps} tools=${options.tools.join(",")}`,
	);
	lines.push(
		`fixture: src/ holds ${FIXTURE_SOURCE_FILES} files and is what ls, grep and find walk; ` +
			`out/ and edits/ hold ${options.warmup + options.reps} per-repetition files each`,
	);
	lines.push("metric: tool_execution_start -> tool_execution_end (argument validation + execute)");
	lines.push("order: one tool group at a time, warmed per group; read then bash first to separate setup costs");
	lines.push("");
	lines.push("tool   |   n | original mean ± sd (ms) | prototype mean ± sd (ms) | slowdown");
	lines.push("-------+-----+-------------------------+--------------------------+---------");
	for (const row of rows) {
		lines.push(
			`${row.tool.padEnd(6)} | ${String(row.original.n).padStart(3)} | ${formatStats(row.original).padStart(23)} | ` +
				`${formatStats(row.prototype).padStart(24)} | ${`${row.slowdown.toFixed(1)}x`.padStart(8)}`,
		);
	}
	lines.push("");
	lines.push(`zone startup (prototype only, one-time per session, n=${options.trials})`);
	const openStats = summarize(sessionOpenMs);
	const bootStats = summarize(zoneBootMs);
	lines.push(`  staging + read/write containers | ${formatStats(openStats)} ms`);
	lines.push(`  exec zone boot (microVM)        | ${formatStats(bootStats)} ms`);
	lines.push("");
	lines.push(`total runtime: ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
	lines.push("");
	console.log(lines.join("\n"));

	if (options.json) {
		await writeFile(
			options.json,
			JSON.stringify(
				{
					config: { ...options, fixtureSourceFiles: FIXTURE_SOURCE_FILES },
					tools: rows,
					zoneStartup: { sessionOpen: openStats, zoneBoot: bootStats },
					raw: {
						original: Object.fromEntries(original),
						prototype: Object.fromEntries(prototype),
						sessionOpenMs,
						zoneBootMs,
					},
				},
				null,
				2,
			),
		);
		console.log(`wrote ${options.json}`);
	}
}

main().catch((error) => {
	process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
