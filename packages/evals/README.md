# Pi evals

Pi evals are behavioral, model-backed checks for Pi workflows. They adapt a real `AgentSession` to `vitest-evals`, run
it in isolated temporary project and agent directories, and attach native Pi session artifacts.
Use them to measure end-to-end behavior and compare prompts, tools, skills, models, or other harness configurations.

## Running evals

Run from the repository root with a default provider and model:

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
```

The equivalent environment variables are:

```bash
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol npm run eval
```

CLI values take precedence and become defaults for harnesses that do not select a model explicitly. Provider and model must be supplied together. The runner also allows no default when every executed harness configures its own model.
Authentication comes from Pi's normal `ModelRuntime`, including Pi subscription credentials and provider API-key
environment variables.

Additional arguments are forwarded to Vitest:

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

Each invocation prints an ignored `.eval/` artifact directory. `runs.jsonl` indexes completed harness runs and their
native Pi session JSONL attachments under `sessions/`. These files may contain prompts, responses, source code, and tool
output.

## Writing evals

Follow [`vitest-evals`](https://github.com/getsentry/vitest-evals) for general suite, judge, assertion, and normalized
trace guidance. Pi-specific evals use `createPiCodingAgentHarness(...)` from `src/pi-harness.ts`, with one harness bound
to each `describeEval(...)` suite:

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Pi smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### Configuring the Pi harness

`createPiCodingAgentHarness(...)` accepts:

- `name`: stable harness identity used by reports and comparisons.
- `model`: optional `{ provider, id }` selection. It overrides the runner's default model.
- `noTools`: Pi's tool-disable configuration.
- `transformSystemPrompt`: transforms the complete default prompt before the eval starts.
- `output`: transforms the final response and `AgentSession` into a JSON-safe domain result.

An explicitly selected model makes model-comparison harnesses independent of the runner default:

```ts
const harness = createPiCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

A run accepts either one prompt or a sequence of prompt and reload steps. Reload steps are useful when the preceding
prompt creates or changes Pi resources:

```ts
const result = await run([
	{ type: "prompt", content: "Create a Pi extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### Transforming harness output

Use `output` to expose scenario-specific, JSON-safe behavior without adding that behavior to the generic Pi adapter:

```ts
const harness = createPiCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

Assert application behavior on `result.output`. Assert model and tool traces on `result.session`, using
`vitest-evals` helpers such as `toolCalls(...)`.

### Fake sessions

A fake session runs a real `AgentSession` with **no model behind it**: the benchmark author issues
every assistant message, so tool calls are chosen by test code instead of an LLM. Everything
downstream of that message still runs for real — the agent loop, tool dispatch, tool hooks, session
JSONL persistence, and session events all behave exactly as in a model-backed session.

Use fake sessions to benchmark Pi itself — tool backends, exec zones, persistence, extension hooks —
deterministically, with no provider credentials and no tokens. They measure the harness, not the
model, so they do not belong in model-comparison eval sets.

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createFakeSessionHarness } from "./fake-session-harness.ts";

const harness = createFakeSessionHarness<{ path: string }, string>({
	drive: async (driver, input) => {
		await driver.start("Round-trip a file.");
		await driver.toolCall("write", { path: input.path, content: "hello" });
		const read = await driver.toolCall("read", { path: input.path });
		expect(read.isError).toBe(false);
		return await driver.finish("Round-trip complete.");
	},
});

describeEval("tool round-trip", { harness }, (it) => {
	it("writes and reads a file", async ({ run }) => {
		const result = await run({ path: "note.txt" });
		expect(result.output).toBe("Round-trip complete.");
		expect(result.usage.toolCalls).toBe(2);
	});
});
```

`createFakeSessionHarness(...)` accepts `name`, `noTools`, and `transformSystemPrompt` exactly like
the model-backed harness, plus:

- `drive`: receives the `FakeSessionDriver` and the run input, and returns the JSON-safe output.
- `stepTimeoutMs`: how long one driver step waits for the harness before failing. Defaults to 30s,
  so a wedged drive fails loudly instead of hanging Vitest.

The driver API:

- `start(prompt)` sends the user message that opens a run and resolves once the harness asks for its
  first assistant message.
- `toolCall(name, args, { text?, id? })` issues one tool call and resolves with its
  `{ toolCallId, toolName, text, content, isError }` result. A failing tool returns `isError: true`
  rather than throwing.
- `toolCalls([...])` puts several calls in one assistant message, exercising parallel tool
  execution; results come back in the requested order.
- `finish(text)` ends the run with a text-only assistant message and returns the final text.
- `reload()` reloads session resources between runs, and `session` exposes the underlying
  `AgentSession` for assertions.

Keep `input` JSON-serializable so `vitest-evals` keeps hashing it for run grouping and comparative
harness tables; the driving logic belongs in `drive`, not in the input.

Fake sessions use a large context window so auto-compaction never consumes a driver instruction
mid-run. A benchmark that needs compaction should trigger it explicitly.

#### Driving a sandboxed backend (the paper extension)

The driver does not care what is behind a tool. Load an extension that reroutes the built-in tools
and the same `toolCall(...)` sequence exercises the real backend, still with no model. With the
[`paper`](../coding-agent/examples/extensions/paper) extension, `write` stages through a gVisor
container and `bash` runs inside a microVM, so a driven `write` then `bash cat` proves the two
sandboxes agree on one tree.

This needs paper's own prerequisites — Docker with gVisor registered as `runsc`, Nix with flakes,
KVM (`/dev/kvm`, and your user in the `kvm` group), `paper-api` built, and `npm install
--ignore-scripts` in the extension directory. See that extension's README for setup.

`createFakeSessionHarness(...)` cannot load extensions: like the model-backed harness, it asserts an
eval session starts with none, so an eval never silently picks up whatever is installed on the
machine. Build the session yourself and use the driver directly:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	initTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
// paper-api is a `file:` dependency of the extension, not a workspace package,
// so it resolves through the extension's own node_modules.
import { scaffoldZoneDir } from "<repo>/packages/coding-agent/examples/extensions/paper/node_modules/paper-api/dist/index.js";
import { FakeSessionDriver } from "./fake-session/driver.ts";
import { createFakeModelRuntime } from "./fake-session/model.ts";

const PAPER = "<repo>/packages/coding-agent/examples/extensions/paper";

// paper's tools render through Pi's theme, which the CLI initializes at startup
// and a bare programmatic session does not. Without this every tool call comes
// back as an error result reading "Theme not initialized".
initTheme("dark");

const root = await mkdtemp(join(tmpdir(), "paper-zone-"));
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
await Promise.all([mkdir(cwd), mkdir(agentDir)]);
// The zone builds from the project's own NixOS config. Interactively the first
// bash call offers to create this; headless there is nothing to accept with.
await scaffoldZoneDir(join(cwd, ".pi", "zone"));

const { modelRuntime, model, faux } = await createFakeModelRuntime();
const services = await createAgentSessionServices({
	cwd,
	agentDir,
	modelRuntime,
	settingsManager: SettingsManager.inMemory(),
	// The programmatic equivalent of `pi -e <path>`.
	resourceLoaderOptions: { additionalExtensionPaths: [PAPER] },
});
const { session } = await createAgentSessionFromServices({
	services,
	sessionManager: SessionManager.create(cwd, join(root, "sessions")),
	model,
	thinkingLevel: "off",
});

// The zone boots on the first bash call and lives for the session, so allow
// far more than the 30s default per step.
const driver = new FakeSessionDriver({ session, faux, stepTimeoutMs: 600_000 });
try {
	await driver.start("Create a file and read it back from the shell.");

	// Assert you are in the VM rather than assuming it: the guest reports its
	// own kernel, `paper-zone` as the hostname, and /workspace as the cwd.
	const zone = await driver.toolCall("bash", { command: "uname -r; hostname; pwd" });
	console.log(zone.text);

	await driver.toolCall("write", { path: "probe.txt", content: "written by the fake model" });
	const catted = await driver.toolCall("bash", { command: "cat probe.txt" });
	console.log(catted.text); // written by the fake model

	await driver.finish("Done.");
} finally {
	await driver.dispose();
	session.dispose();
}
```

Check that the extension actually loaded before trusting a green run — without it the tools fall
back to the host and the same script still passes:

```ts
const paths = session.extensionRunner.getExtensionPaths();
if (!paths.some((path) => path.includes("paper"))) throw new Error("paper extension did not load");
```

No approval is involved in the flow above, even though paper gates file changes. `write` only
*stages* into the scratchpad, and the zone mounts that staged tree as the lower layer of its overlay
(`lowerSource: "staged"`), so the zone sees the file without anything reaching the real project.
Asserting that a change lands on the **host** is a different test: it needs `"autoCommit": true` in
the project's `.pi/paper.json`, which is off by default precisely because there is no UI to approve
in.

`driver.dispose()` unwinds the run and `session.dispose()` fires paper's `session_shutdown`, which
tears down the VM and containers. Skip them and a qemu process outlives the test.

### RQ2: per-tool-call latency benchmark

`src/rq2-latency.ts` measures the latency the `paper` sandbox adds to each tool call, against the
same tools running unsandboxed. Both arms are driven through the fake-session interface, so an
identical tool-call sequence runs with no model and no provider credentials, and the only difference
between them is whether the extension is loaded.

It is a standalone script rather than an eval, so it never runs under `npm run eval`, `test.sh` or
CI — nothing boots a VM unless you ask it to:

```bash
node_modules/.bin/tsx --tsconfig tsconfig.json \
  packages/evals/src/rq2-latency.ts --trials 5 --reps 20 --warmup 3
```

| flag | default | meaning |
|---|---|---|
| `--trials <n>` | 5 | independent rounds, each with a fresh session and a freshly booted VM |
| `--warmup <n>` | 3 | calls per tool excluded from the table; the first one measures zone startup |
| `--reps <n>` | 20 | measured calls per tool per trial |
| `--tools <a,b>` | all 7 | restrict the tool set |
| `--fixture <n>` | 20 | files in `src/`, the tree `ls`, `grep` and `find` walk |
| `--json <path>` | – | also write the summary and raw samples as JSON |

`--fixture` exists because tree size is part of the result for the read-only tools. Sweeping it is
how the `ls` behaviour below was characterised:
`--tools ls --fixture 5,20,40` gives 220, 592 and 961 ms, i.e. about `114 ms + 21 ms x entries`.

`--trials 1 --reps 5` is a fast check. Results print to stdout at the end; progress goes to stderr,
so stdout can be redirected on its own. Needs paper's prerequisites: Docker with gVisor as `runsc`,
Nix with flakes, and KVM.

The reported metric is the interval between the harness's `tool_execution_start` and
`tool_execution_end` events — argument validation plus the tool's own `execute`, with none of the
agent loop, session persistence or driver rendezvous. That instrumentation is identical in both
arms, so the harness overhead common to both cancels in the comparison.

Four things the script does deliberately, each because getting them wrong produced a wrong answer:

- **Activates all seven tools explicitly.** The default active set is `read/bash/edit/write`, so
  `ls`, `grep` and `find` otherwise return "tool not found" in microseconds and look like an
  enormous speedup.
- **Aborts on any tool error** rather than recording it. Error paths are fast, so a silently failing
  tool reads as an improvement.
- **Measures one tool group at a time**, with `read` first and `bash` second. `write` and `edit`
  call `markLowerDirty()`, and the next `bash` re-syncs the zone's overlay; interleaving therefore
  charges one tool's cost to another. This ordering also isolates the two setup costs — the first
  `read` pays for opening the session, the first `bash` pays for booting the VM.
- **Keeps the measured tree independent of the flags.** `ls`, `grep` and `find` walk `src/`, which
  holds a fixed number of files, while per-repetition files go to `out/` and `edits/`. Scoped to
  `.` instead, those three grow with `--reps` and stop being comparable between configurations —
  `ls` moved 56% between `5x20` and `3x30` before this.
- **Tears the session down properly**, emitting `session_shutdown` before `dispose()`.
  `AgentSession.dispose()` is synchronous and does not emit it, so a process that opens many
  sessions leaks paper's containers and VM. Measured against leaked sandboxes, VM boot inflated
  from 14 s to 110 s and every read-zone call drifted upward across trials.
- **Disables paper's transcript** via `.pi/paper.json`, because its `tool_call`/`tool_result` hooks
  write JSONL inside the measured span.

Expect roughly 10% run-to-run variation in the absolute means on an otherwise busy machine; the
relative ordering and the slowdown factors are far more stable than the absolute figures. Quote
numbers from a single run rather than mixing runs, and state the fixture size alongside `ls`,
`grep` and `find`.

#### Why `ls` is the outlier

Under paper, `ls` costs roughly `114 ms + 21 ms x entries`, while every other tool is flat. It is
the only tool whose backend call count scales with its output: `ls.ts` stats each entry separately,
in a serial loop, purely to append `/` to directories. Locally each `stat` is `fs.stat` and costs
microseconds; through a gVisor container each becomes a round trip, and the measured ~21 ms per
entry matches the cost of a single sandboxed call. `grep` and `find` avoid this entirely by spawning
`rg`/`fd` inside the container and letting it do the walking — one call, whatever the tree size.

The type information is available without those extra calls: `createPaperLsOps.readdir` receives
`Array<{name, type}>` and discards the type, because `LsOperations.readdir` is typed `=> string[]`.
Widening that interface, or adding an optional `readdirWithTypes` so the local path is unchanged,
would collapse `ls` to a single round trip. That is a change to the shipped tool interface rather
than to the sandbox, so it is left alone here.

Zone startup is reported on its own lines and never folded into per-call latency. The first run on a
machine additionally pays a `nix build` for the zone image, which can take minutes; later runs hit
the store cache.

### Writing comparative eval sets

Use `evalHarnessTable(...)` with Vitest's native `describe.for(...)` to run the same inputs against multiple harnesses.
Harnesses may differ by prompt, tools, skills, model, or any other Pi configuration:

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

Comparative suites should record correctness with deterministic or model-backed judges and set `judgeThreshold: null`.
This keeps a low score as an observation instead of making the Vitest invocation fail. Use hard assertions only for
suite invariants and infrastructure contracts. `expect.soft(...)` still fails the test and is not a scoring mechanism.

The Pi harness snapshots native session JSONL before deleting its temporary workspace. An eval-only `afterEach` hook
registers that snapshot against the explicit Vitest test task before reporters run.

Harness names must be stable and unique within an eval set. The grouping key combines repetition with a non-empty string
`input.id` when available, otherwise with a SHA-256 hash of strict canonical JSON input. Use `candidate` for one treatment
or `candidates` for multiple treatments. Each candidate is compared only with the declared baseline. For each matched
input and repetition, the reporter computes pass-rate lift from each run's recorded average judge score, treating a score
of at least `1` as passing. Lift is the candidate pass rate minus the baseline pass rate, in percentage points. Missing
judge scores are reported as incomplete observations. Tokens, latency, and estimated cost remain separate
candidate-minus-baseline paired deltas; missing telemetry remains unavailable. If execution-order randomization becomes
necessary, use Vitest's built-in sequence shuffling.

See the [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) guidance for comparative-eval methodology,
repetition strategy, trustworthy judges, and telemetry interpretation.
