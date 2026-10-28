# Deep-SWE with paper-pi

This adapter runs paper-pi through **Pier 0.3.1**, using each task's Docker environment. Pier
owns image selection/building, task limits, artifact collection, and the separate verifier.
Pi's model calls run on the host; model credentials are never mounted into a zone.

## Setup on this VPS

Docker and Compose are already installed. With paper-api checked out alongside paper-pi:

```sh
cd /home/ubuntu/zones/paper-pi
python3 packages/evals/pier/bootstrap.py
```

Bootstrap installs Node 24.21.0 under `zones/.tools`, Python 3.12.15 in `.venv`, and
`datacurve-pier==0.3.1` with locked Python dependencies and the `paper-deepswe` entry point.
It reuses the baseline's uv/Python
installation when available, installs npm dependencies from their existing lockfiles with
scripts disabled, compiles paper-api, and hydrates Pi's ignored provider data from the
checksum-verified 0.83.0 release artifact. This fork's additional Baseten and Copilot metadata
comes from a saved snapshot of its committed generator. The benchmark's custom model comes from TOML.
Nix, a microVM, KVM, and a local inference model are unnecessary.

If `config.local.toml` does not exist, bootstrap copies the old pi-deepswe `[model]` section
verbatim and points `[run]` at the existing DeepSWE dataset and the paper output directory.
Later bootstrap runs preserve this file. `config.example.toml` shows the same schema.
Paths resolve from the directory where the command is launched. The dataset used on this VPS
is `/home/ubuntu/pi-deepswe/datasets/deep-swe`, pinned at
`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea` (113 tasks).

## Run using the baseline-compatible config

Restore the EPFL VPN with `/home/ubuntu/epfl-vpn/connect` and export `MODEL_API_KEY` in the
benchmark shell. The VPN requires your login/MFA. Then run from the paper-pi checkout:

```sh
.venv/bin/paper-deepswe check --config config.local.toml --all
.venv/bin/paper-deepswe run --config config.local.toml --all --prune-docker-cache
```

The Python environment is this checkout's `.venv`. `paper-deepswe` identifies the zones runner;
`pi-deepswe` remains an alias for the exact old command. Both names run the same paper adapter.
The original baseline executable lives in `/home/ubuntu/pi-deepswe/.venv/bin/pi-deepswe`.
The command options and TOML schema match the baseline. No `--ak`, activation, Node PATH, or host
Pi configuration is needed. The launcher selects the locally installed Node runtime itself.
The TOML model configuration supplies endpoint, model ID, context/output limits, reasoning,
thinking map, sampling, compatibility, and optional prices. Compatibility fields are forwarded
as configured; no `thinkingFormat` or `chatTemplateKwargs` is inserted. A fresh host-only
catalog and empty auth file prevent user Pi settings from overriding the benchmark model.
Only the API key environment variable's name is saved in configuration and provenance.
Host inference retains localhost addresses unchanged.

`check` validates configuration, Node imports, Docker/Compose, and every selected task's
single-step Linux/no-network profile. It makes no inference requests and does not pull all
task images. Task-image tool checks run during setup; model connectivity/authentication and
server request compatibility are exercised by a real trial.

For a single-task pilot, omit `--all` (defaults to `abs-module-cache-flags`) or use
`--task <name>`. For a repeatable subset, use `--n-tasks 5 --seed 42`. Selection follows the
old sorted-then-seeded-shuffle algorithm and is frozen as absolute paths for resume.
The wrapper rejects `concurrency` other than 1, runs one attempt per task with no whole-trial
retries, and locks against another wrapper job sharing this zones directory. Run the old
baseline and any other inference clients separately as well.

Task CPU, memory, and timeout settings are unchanged. Each task's 8192 MiB is a container
ceiling, not preallocated RAM. Limits apply per zone, so total trial usage can exceed one
container's ceiling. Docker volumes have no portable hard disk quota. On this VPS, check
memory/disk use during the pilot before committing to the full corpus; no swap is installed.

## VPN expiry and resume

Use `tmux new -s paper-eval` for a long job; run the same command above inside it.
Detach with Ctrl-b, then d; reconnect with `tmux attach -t paper-eval`.
The launcher prints the job directory before execution. On confirmed inference loss, it saves
staged work and logs, closes zones, pauses the queue, exits 75, and prints:

```sh
.venv/bin/paper-deepswe resume packages/evals/.eval/deep-swe/<job-name>
```

Reconnect the VPN and restore the key before resuming. The saved selection, complete model
settings, limits, and pruning policy are reused even if the original TOML changes. Only confirmed
inference disconnections restart from the beginning: an `InferenceUnavailableError` or trusted
`paper.inferenceUnavailable: true` metadata must identify the attempt. These attempts are archived
under `.interrupted/`, preserving their logs and patches. Other outcomes, including zero scores,
timeouts, model errors, Git/submission failures, setup failures, and manual cancellations, are
retained without retry. Tasks that have never started still run normally.

Press Ctrl+C once in the launcher's terminal to stop the queue gracefully. The Node runner uses
its own process session, so terminal signals do not race its sandbox cleanup hooks. The launcher
requests finalization with SIGUSR1, waits for the runner, and records the cancelled trial.
A manual interruption does not authorize a fresh attempt. Let cleanup finish before resume.

Summary and resume select the first non-VPN attempt per task, including ungraded infrastructure
failures. A later pass cannot replace it. Only a confirmed disconnection remains retryable even
if it has a raw verifier reward. Summary includes current and archived attempts, marks the selected
result and its `retryable` status, and reports infrastructure outcomes separately. Missing grades
remain missing; the adapter does not invent a verifier reward. Resume restores an archived first
non-VPN result when necessary. This stricter selection also applies when inspecting older jobs.
If a started trial has no `result.json`, resume stops before moving any attempts because it cannot
establish a disconnection; its artifacts are preserved for inspection. Resume fingerprints record
the `first_non_vpn_attempt` selection policy.

Pier can create the next task's config and empty log before the disconnect guard stops it.
Resume archives this unstarted queue record only for a serial job, when its config was written
after a recorded inference disconnection finished and its agent/verifier/artifact directories
contain no entries. No result or verifier reward is invented. Nonempty logs, execution artifacts,
unknown files, and records predating the disconnection still block resume for inspection.

The host connectivity monitor probes the effective endpoint's `/models` route without
generating tokens. Probes time out after 20 seconds, run 30 seconds apart while inference is
active, and require three consecutive failures; streamed activity resets the count.
Authentication errors, unsupported routes, and rate limits establish reachability, while
transport failures and HTTP 502/503/504 count as unavailable. Reachability does not prove an
inference request succeeds; actual model/authentication failures remain visible in results.

Each new job saves `config.json` and `pi-deepswe-provenance.json` with task selection, model
settings, repository revisions/dirty flags, runtime/package versions, provider-data hashes,
and zone profile. Inspect results with `.venv/bin/paper-deepswe summary <job-directory>`.
Every resume appends `resume-history.jsonl` with the implementation commit, source SHA-256
fingerprints, selected result policy, and archived attempt paths. This records implementation
repairs between resumptions without changing the original provenance or model configuration.

## Native Pier interface

Existing native JSON/YAML jobs and provider-based Pi authentication remain available:

```sh
export PATH="$PWD/../.tools/node-v24.21.0-linux-x64/bin:$PWD/.venv/bin:$PATH"
.venv/bin/python -m paper_job run -p /path/to/deep-swe/tasks \
  --model provider/model-id --n-concurrent 1 --max-retries 0 \
  --jobs-dir packages/evals/.eval/deep-swe
```

This advanced interface uses host Pi `auth.json`/`models.json`, allows `--ak` agent options,
and accepts `--config` for Pier's native JobConfig. Resume these jobs with
`.venv/bin/python -m paper_job resume <job-directory>`. The TOML wrapper is the interface
for the baseline-compatible paper run.

## Docker cache pruning

`--prune-docker-cache` is opt-in and requires `--n-concurrent 1` and environment deletion. Native
configs can set `environment.kwargs.prune_docker_cache = true`. After each trial's verifier has
stopped and `result.json` is saved, the launcher removes recorded unused task/agent/verifier image
tags without forcing deletion, then runs `docker builder prune --all --force`. Images referenced
by any container are skipped. Unrelated tags, shared paper utility images, and volumes are not
pruned. Unused build cache is reclaimed **across the Docker builder**; use this option on a host
where that cache cleanup is appropriate. Run one benchmark job at a time when pruning.

Each trial records `docker-images.json` before builds, including failed starts, and
`docker-cleanup.json` with removal outcomes. Cleanup failures are logged and never replace the
saved benchmark result. Pruned prebuilt task images may need to be pulled again on resume.
`run-state.json` in the job directory records running, paused, stopped, or finished state.

## Zones and submission

| Capability | Eval container | Workspace access |
|---|---|---|
| read / ls / grep / find | one BusyBox container, `runc` | staged tree, read-only |
| write / edit / delete_file | one BusyBox container, `runc` | staged tree, read-write |
| bash | one container from the task image, `runc` | private overlay at `/app`, no network |
| fetch_url | one Alpine container, `runc`, created on first fetch | network, no workspace mounts |

The file containers start on first tool use. Exec and network start independently on demand and
are reused throughout the session. If the task forbids networking, `fetch_url` is disabled and no
network container is created. A task that permits networking can use `fetch_url`; shell commands
still have no network. Pier's submission container and separate verifier are additional harness
containers, outside paper's four zones.
Concurrent first shell calls share the same exec startup and private filesystem.
Staged writes and deletions are serialized with initial startup. Exec mounts only a private
Docker volume; staged snapshots are copied through Docker's archive API. Shell remounts and
snapshot writes cannot reach the host scratchpad or the submitted source checkout.

The task image supplies its toolchain, dependencies, and Git checkout. The host seed is a Git
archive of the task's `HEAD`; the read/write staging view excludes `.git`, `node_modules`, `dist`,
`build`, `.venv`, `__pycache__`, and `.next`. Those image directories remain available to exec.
Repository-relative paths and `/app/...` paths address the staged source tools.

Source export skips symbolic and hard links rather than following them onto the host; it records
their paths and targets in `agent/source-export.json`. The task image retains its original link
fixtures inside exec and the separate verifier. Skipping a link in the host baseline does not
submit a deletion of the image's link. Regular source extraction still validates archive paths
and rejects special files. This supports Helm's tracked `/dev/null` fixture without changing
the task image or verifier.

Staged write/edit/delete operations reject `.git` and its descendants before mutation. The
disposable submission repository's Git metadata belongs to the harness. `.gitignore`, `.github`
and ordinary source files remain writable. Private Git commands in exec are unchanged.

Shell writes and deletion whiteouts stay in exec's private overlay upper. They persist between
commands, lower refreshes, and restarts, and can shadow later staged edits. The agent must use
`write` / `edit` for submitted source changes; shell `git commit`, formatters, and code generation
cannot submit anything. At completion, agent failure, or graceful timeout, the trusted adapter applies staged
changes to its disposable source checkout, makes a binary Git patch, and applies and commits that
patch in Pier's submission environment. Pier's task-defined collection hook then transfers it to
the pristine verifier. The agent receives neither held-out tests nor the reference solution.
Finalized agent failures use Pier's `NonZeroAgentExitCodeError` so their partial patch is verified.
Setup, commit, shutdown, and submission failures are infrastructure errors and are not scored.

Shell results remind the agent to submit source through `write` / `edit` / `delete_file`. Before `edit`, use
`read` to obtain the staged contents: shell reads can show a different private version. Run
formatters in check mode, or copy final generated contents through `write`. Passing tests against
private shell changes does not validate the submitted patch.

The private overlay backing directories under `/paper-state` remain accessible to exec commands.
Directly modifying a mounted backing layer can corrupt exec's private filesystem view and cause
stale-file-handle errors. This repair leaves exec's overlay, permissions and refresh semantics
unchanged; copied snapshots still isolate those backing files from the authoritative staged tree.

The eval profile pins `runtime: runc`, `zone.backend: docker`, `/app`, and `autoCommit: true` using
`PAPER_CONFIG_PATH`. Task-local `.pi/paper.json`, user extensions, skills, prompt templates, and
context files cannot override this profile. The existing interactive Nix defaults are unchanged.

## Artifacts and limits

Each trial records:

- `agent/paper-result.json`: status, `failureKind` (`agent` or `infrastructure` on failure),
  `submissionReady`, immutable image ID, selected model, session stats, estimated
  cost availability, effective thinking/output limits, setup/agent timing, and per-tool durations
  (including first-use startup).
- `agent/runner-stdout.txt`: live thinking, text, tool arguments, tool start/end markers, and a
  heartbeat every 15 seconds with the current phase and time since the last activity.
- `agent/runner-stderr.txt`: runner diagnostics, persisted as they happen, including on interruption.
- `agent/runner-process.json`: child PID recorded at spawn, and whether forced termination was required.
- `agent/source-export.json`: archive links omitted from the host staging baseline, with original targets.
- `agent/sessions/*.jsonl` and `agent/transcripts/*.jsonl`: native Pi session and paper transcript.
- `agent/model.patch`: staged source changes actually submitted; no private shell changes.
- Pier's `result.json`: token/cost context, paper metadata, repository revisions and dirty flags,
  plus verifier scores. `verifier/` holds the task's test reports.

Watch a running trial with `tail -n 20 -f <trial-directory>/agent/runner-stdout.txt`.
Session JSONL saves responses when they finish; use the runner log to see partial responses.

CPU, memory, and PID limits apply **per zone**; the entire trial can use more than one container's
limit. Pier alone enforces its agent/verifier deadlines, including overrides and multipliers;
shell calls default to 120 seconds and accept
the bash tool's `timeout` override. Docker volume storage has no portable hard quota; requested
storage is recorded with `storageLimitEnforced: false`. The image must include Python 3, bash, Git,
cp, mount, and umount; setup fails explicitly if a tool is absent. Staged symlinks are unsupported.
Source read/edit inputs must fit within 32 MiB and be complete; oversized reads fail before edits.

The exec container needs `CAP_SYS_ADMIN` and AppArmor unconfined to mount overlayfs. This profile
measures paper's zone/tool design with Docker; it has weaker isolation than the Nix VM. Closing
a session removes the exec container and its private volume. Cancellation during exec setup removes
partial resources. Pier signals the runner with `SIGUSR1` and allows 15 seconds to finalize;
after child exit it removes only paper containers and exec volumes labelled with that child's PID.
A forced kill or missing result is an infrastructure failure and skips submission and verification.
`paper-api.reapOrphans()` reclaims
managed resources whose host owner died in a hard crash.

## Deterministic integration check

From the paper-pi checkout, with Docker reachable:

```sh
export PATH="$PWD/../.tools/node-v24.21.0-linux-x64/bin:$PWD/.venv/bin:$PATH"
.venv/bin/python -m unittest discover -s packages/evals/pier -p 'test_paper_*.py' -v
PAPER_PIER_INTEGRATION=1 .venv/bin/python -m unittest discover -s packages/evals/pier -p 'test_paper_agent*.py' -v
```

This builds a tiny fixture, drives real Pi tools using the faux provider, and expects reward 1
from a separate verifier in completion, agent-error, timeout, and extended-deadline cases. It checks that private shell edits
are excluded, task-local config cannot override the profile, and containers/private volumes are
removed. Adapter regressions also check infrastructure failures and force-kill cleanup that
preserves resources owned by another process. `PAPER_PIER_TEST_BASE` can select an existing Debian-derived image
with Python, bash, and Git instead of installing Git in `python:3.12-slim`.
These are infrastructure checks; faux usage statistics are synthetic and are not model scores.
The disconnect/resume fixture runs three tasks, injects VPN loss on the second, and verifies that
resume preserves the first task's result and archives the disconnected attempt. Its image cleanup
uses Docker, while builder-wide pruning is mocked to preserve the host's unrelated cache.
