# Deep-SWE with paper-pi

This adapter runs paper-pi through **Pier 0.3.1**, using each task's Docker environment. Pier
manages task images, resource limits, artifact collection, and the separate verifier. Pi's
model calls run on the host; model credentials are never mounted into a zone.

## Setup

Requirements: Linux x86_64, Python 3 to run bootstrap, Docker with Compose, a DeepSWE dataset,
and a paper-api checkout alongside paper-pi. Run all commands from the paper-pi checkout.

```sh
python3 packages/evals/pier/bootstrap.py
```

Bootstrap installs Node 24.21.0 under `../.tools`, creates `.venv` with Python 3.12.15 and
locked Python dependencies, and installs the `paper-deepswe` command. It also installs npm
dependencies with lifecycle scripts disabled, compiles paper-api, and restores Pi's pinned
provider data.

Bootstrap creates `config.local.toml` if it is missing and preserves it on later runs. Review
it before running; [config.example.toml](config.example.toml) documents the TOML structure.
Set:

- `[model]`: endpoint (`base_url`), model ID, API key environment variable name, context/output
  limits, reasoning settings, and any sampling, compatibility, or pricing options.
- `[run]`: `tasks_dir` pointing to the dataset's task directory, `jobs_dir` for results, and
  `concurrency = 1`.

Paths resolve from the directory where the command is launched. Export the variable named by
`model.api_key_env` in the same shell, for example:

```sh
export MODEL_API_KEY='<your-api-key>'
```

The launcher selects its local Node runtime and builds an isolated model catalog from the
TOML settings. User Pi configuration does not override the benchmark model. Configuration and
provenance save the API key variable's name, not its value. Localhost endpoints work directly
because inference runs on the host.

## Run

Check prerequisites, then run the selected tasks:

```sh
.venv/bin/paper-deepswe check --config config.local.toml --all
.venv/bin/paper-deepswe run --config config.local.toml --all
```

`check` validates configuration, Node imports, Docker/Compose, and each selected task's
single-step Linux/no-network profile. It makes no inference requests and does not pull all task
images. Task-image tools are checked during setup; a real trial exercises model authentication
and request compatibility.

Omit `--all` for the default pilot task (`abs-module-cache-flags`), use `--task <name>` for a
specific task, or use `--n-tasks 5 --seed 42` for a repeatable subset. Selection sorts tasks
before a seeded shuffle and saves their absolute paths for resume. The wrapper runs serially,
with one attempt per task and no whole-trial retries except confirmed inference disconnections.
It locks against another wrapper job sharing the same parent directory.

The launcher prints the job directory before execution. Inspect results with:

```sh
.venv/bin/paper-deepswe summary <job-directory>
```

For a long job, start a terminal session with `tmux new -s paper-eval` and run the command
inside it. Detach with Ctrl-b, then d; reconnect with `tmux attach -t paper-eval`.

## Stop and resume

On confirmed inference connectivity loss, the launcher saves staged work and logs, closes
zones, pauses the queue, exits with code 75, and prints a resume command:

```sh
.venv/bin/paper-deepswe resume <job-directory>
```

Restore model connectivity and export the API key before resuming. Resume reuses the saved
task selection, model settings, limits, and pruning policy even if the original TOML changes.
Confirmed disconnected attempts are archived under `.interrupted/` and restart from the
beginning, preserving their logs and patches. Tasks that have never started run normally.

Other outcomes, including zero scores, timeouts, model errors, infrastructure failures, and
manual cancellations, are retained without retry. Summary and resume select the first attempt
per task that was not a confirmed inference disconnection, including ungraded infrastructure
failures; later attempts cannot replace it. Missing grades remain missing. If a started trial
has no `result.json`, resume stops and preserves its artifacts for inspection. Empty queue
records created after a confirmed disconnection can be archived; records with execution
artifacts or unknown files block resume for inspection.

Press Ctrl+C once to stop the queue gracefully. Let cleanup finish before resuming; manual
interruption records a cancelled trial and does not authorize a fresh attempt.

The host connectivity monitor probes the endpoint's `/models` route without generating tokens.
Probes time out after 20 seconds, run 30 seconds apart while inference is active, and require
three consecutive failures; streamed activity resets the count. Transport failures and HTTP
502/503/504 count as unavailable. Authentication errors, unsupported routes, and rate limits
establish reachability; actual model errors remain visible in results.

## Native Pier interface

For native JSON/YAML job configuration and provider-based Pi authentication:

```sh
export PATH="$PWD/../.tools/node-v24.21.0-linux-x64/bin:$PWD/.venv/bin:$PATH"
.venv/bin/python -m paper_job run -p /path/to/deep-swe/tasks \
  --model provider/model-id --n-concurrent 1 --max-retries 0 \
  --jobs-dir packages/evals/.eval/deep-swe
```

This interface uses host Pi `auth.json`/`models.json`, allows `--ak` agent options, and accepts
`--config` for Pier's native JobConfig. Resume these jobs with
`.venv/bin/python -m paper_job resume <job-directory>`.

## Docker cache pruning

Add `--prune-docker-cache` to `paper-deepswe run` to reclaim unused task images and build cache
after each trial. Native jobs require `--n-concurrent 1` and environment deletion; native
configs can set `environment.kwargs.prune_docker_cache = true`.

After the verifier stops and `result.json` is saved, cleanup removes recorded unused
task/agent/verifier image tags without forcing deletion, then runs
`docker builder prune --all --force`. Images referenced by containers, unrelated tags, shared
paper utility images, and volumes are preserved. Build cache cleanup applies **across the
Docker builder**. Run one benchmark job at a time when pruning.

Each trial records `docker-images.json` and `docker-cleanup.json`. Cleanup failures are logged
without replacing the benchmark result. Pruned task images may need to be pulled again on resume.

## Zones and submission

| Capability | Eval container | Workspace access |
|---|---|---|
| read / ls / grep / find | BusyBox, `runc` | staged tree, read-only |
| write / edit / delete_file | BusyBox, `runc` | staged tree, read-write |
| bash | task image, `runc` | private overlay at `/app`, no network |
| fetch_url | Alpine, `runc` | network, no workspace mounts |

Containers start on first use and are reused throughout the session. If a task forbids
networking, `fetch_url` is disabled and no network container is created. Shell commands always
have no network. Pier's submission container and separate verifier run outside these four zones.

The task image supplies its toolchain, dependencies, and Git checkout. Staging starts from a
Git archive of the task's `HEAD`, excluding `.git`, `node_modules`, `dist`, `build`, `.venv`,
`__pycache__`, and `.next`; those image directories remain available to shell commands.
Repository-relative paths and `/app/...` paths address the staged source tools. Symbolic and
hard links are omitted from staging and recorded in `agent/source-export.json`; the task image
and verifier retain their original links. Staged tools reject changes to `.git` and its contents.

**Only changes made through `write`, `edit`, and `delete_file` are submitted.** Shell writes,
formatters, code generation, and private Git commits stay in the exec overlay and can shadow
staged edits. Use `read` before `edit` to obtain staged contents, run formatters in check mode,
and copy generated source through `write`. Tests against private shell changes do not validate
the submitted patch. Avoid modifying overlay backing directories under `/paper-state`, which
can corrupt the private filesystem view.

At completion, agent failure, or graceful timeout, the adapter turns staged changes into a
binary Git patch and commits it in Pier's disposable submission environment. The task's
collection hook transfers it to the separate verifier. The agent receives neither held-out
tests nor the reference solution. Finalized agent failures still have their partial patch
verified; setup, commit, shutdown, and submission failures are ungraded infrastructure errors.

The evaluation profile fixes `runtime: runc`, `zone.backend: docker`, `/app`, and
`autoCommit: true` through `PAPER_CONFIG_PATH`. Task-local configuration, user extensions,
skills, prompt templates, and context files cannot override it.

## Artifacts and limits

Each job saves `config.json` and `pi-deepswe-provenance.json` with task selection, model settings,
repository revisions/dirty flags, runtime/package versions, provider-data hashes, and zone
profile. `run-state.json` records running, paused, stopped, or finished state. Each resume appends
implementation fingerprints, result selection policy, and archived attempt paths to
`resume-history.jsonl` without changing the original provenance or model configuration.

Each trial records:

- `agent/paper-result.json`: status, agent/infrastructure failure classification, submission
  readiness, image ID, model, usage, estimated cost availability, limits, and timings.
- `agent/runner-stdout.txt`: live thinking, text, tool calls, and a heartbeat every 15 seconds.
- `agent/runner-stderr.txt`: runner diagnostics, including interruptions.
- `agent/runner-process.json`: child PID and whether forced termination was required.
- `agent/source-export.json`: links omitted from staging, with their original targets.
- `agent/sessions/*.jsonl` and `agent/transcripts/*.jsonl`: Pi sessions and paper transcripts.
- `agent/model.patch`: the staged source changes actually submitted.
- `result.json` and `verifier/`: Pier results, usage metadata, verifier scores, and test reports.

Watch a running trial with `tail -n 20 -f <trial-directory>/agent/runner-stdout.txt`.
Session JSONL saves responses when they finish; the runner log shows partial responses.

CPU, memory, and PID limits apply **per zone**, so a trial can exceed one container's limit.
Pier enforces agent/verifier deadlines; shell calls default to 120 seconds and accept the bash
tool's `timeout` override. Docker volume storage has no portable hard quota; requested storage
is recorded with `storageLimitEnforced: false`. Source read/edit inputs must be complete and fit
within 32 MiB. Staged symlinks are unsupported.

Task images must include Python 3, bash, Git, cp, mount, and umount. The exec container requires
`CAP_SYS_ADMIN` and AppArmor unconfined for overlayfs, giving weaker isolation than the Nix VM.
Closing a session removes its exec container and private volume. On cancellation, Pier allows
15 seconds for finalization and cleans up resources labelled with the runner's PID. A forced
kill or missing result is an infrastructure failure and skips submission and verification.
`paper-api.reapOrphans()` reclaims managed resources whose host owner died in a hard crash.

## Integration checks

From the paper-pi checkout, with Docker reachable:

```sh
export PATH="$PWD/../.tools/node-v24.21.0-linux-x64/bin:$PWD/.venv/bin:$PATH"
.venv/bin/python -m unittest discover -s packages/evals/pier -p 'test_paper_*.py' -v
PAPER_PIER_INTEGRATION=1 .venv/bin/python -m unittest discover -s packages/evals/pier -p 'test_paper_agent*.py' -v
```

The integration fixture drives real Pi tools with a faux provider and separate verifier. It
checks completion, agent errors, deadlines, staged submission, configuration isolation, and
resource cleanup. Recovery checks inject inference connectivity loss and verify that resume
preserves completed results and archives disconnected attempts. Builder-wide pruning is mocked
to preserve unrelated cache. These checks use synthetic usage statistics, not model scores.

`PAPER_PIER_TEST_BASE` can select an existing Debian-derived image with Python, bash, and Git
instead of installing Git in `python:3.12-slim`.
