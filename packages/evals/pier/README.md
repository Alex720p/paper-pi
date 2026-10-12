# Deep-SWE with paper-pi

This adapter runs paper-pi through **Pier 0.3.1**, using each task's Docker environment. Pier
owns image selection/building, task limits, artifact collection, and the separate verifier.
Pi's model calls run on the host; model credentials are never mounted into a zone.

## Setup

Use a Linux host with Node, Python 3.12+, Docker Compose, and a Docker daemon that permits overlay
mounts inside an exec container. Nix and KVM are unnecessary for this eval profile.

From the paper-pi checkout, with paper-api checked out alongside it:

```sh
cd ../paper-api
npm install --ignore-scripts
node_modules/.bin/tsup
cd ../paper-pi
npm install --ignore-scripts
cd packages/coding-agent/examples/extensions/paper
npm install --ignore-scripts
cd ../../../../..
uv venv --python 3.12 packages/evals/pier/.venv
uv pip install --python packages/evals/pier/.venv/bin/python -r packages/evals/pier/requirements.txt
. packages/evals/pier/.venv/bin/activate
git clone https://github.com/datacurve-ai/deep-swe /path/to/deep-swe
```

The adapter is pinned because it uses Pier's Docker Compose container lookup. Keep paper-api's
`dist` up to date: the extension consumes compiled exports through its `file:` dependency.

## Run

Authenticate Pi normally, or provide the selected provider's API key in the host environment.
The adapter uses the host's `auth.json` and `models.json` from `PI_CODING_AGENT_DIR` (default
`~/.pi/agent`), while isolating trial settings, extensions, and sessions in a fresh directory.
The model argument uses **Pi provider/model IDs**, for example `openai/gpt-5.5` or
`openai-codex/gpt-5.5` for configured subscription credentials.

From the paper-pi checkout:

```sh
export PYTHONPATH="$PWD/packages/evals/pier${PYTHONPATH:+:$PYTHONPATH}"
python -m paper_job run -p /path/to/deep-swe/tasks/etree-xml-diff-patch \
  --model openai/gpt-5.5 --n-concurrent 1 \
  --jobs-dir packages/evals/.eval/deep-swe --max-retries 0
```

For the corpus, change `-p` to `/path/to/deep-swe/tasks`. Use `--n-tasks` and `--sample-seed`
for a subset. This adapter runs the paper arm only; it creates no paired baseline. Execution is
currently local Linux Docker only. MCP/skills tasks fail explicitly instead of running without
their required tools. Thinking defaults to `high` for models registered with `reasoning: true`,
and `off` otherwise. Set `--ak thinking_level=high` to select it explicitly. A model that always
thinks needs provider-compatible reasoning configuration; `off` cannot disable server defaults.

For EPFL's GLM-5.3-Flash, the entry in `~/.pi/agent/models.json` needs:

```json
{
  "id": "zai-org/GLM-5.3-Flash",
  "reasoning": true,
  "thinkingLevelMap": { "off": null, "minimal": null, "medium": null, "xhigh": null, "max": null },
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": { "reasoning_effort": { "$var": "thinking.effort" } }
  }
}
```

Keep the entry's other fields. Its [published chat template](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/chat_template.jinja)
accepts `low` and `high`, and defaults to maximum effort when missing. Use
`--model epfl/zai-org/GLM-5.3-Flash --ak thinking_level=high --n-concurrent 1`.
With a provider limited to one active request, run only one Pier job at a time too.
The EPFL endpoint must be reachable from the host through the EPFL network or VPN; model calls
do not go through the network zone.

`--ak max_output_tokens=32768` optionally caps each response, including reasoning. Without it,
the catalog's `maxTokens` applies. A cap can truncate reasoning or tool arguments and fail a task;
it is a limit rather than a guarantee the model will finish its response.

The launcher defaults to one concurrent trial and no automatic retries. `--config job.json`
(or YAML) accepts Pier's native `JobConfig`, including timeout multipliers and resource overrides;
set its agent import to `paper_agent:PaperAgent`. CLI options override the corresponding saved
config fields. The launcher resolves dataset sampling into explicit absolute task paths before
starting, so reconnecting cannot resample the corpus. Existing direct `pier run` commands remain
available, but the paper launcher adds automatic job pause and optional pruning hooks.

## VPN expiry and resume

Run long jobs inside `tmux` to keep them alive when the SSH connection closes:

```sh
tmux new -s paper-eval
. packages/evals/pier/.venv/bin/activate
export PYTHONPATH="$PWD/packages/evals/pier${PYTHONPATH:+:$PYTHONPATH}"
python -m paper_job run -p /path/to/deep-swe/tasks \
  --model epfl/zai-org/GLM-5.3-Flash --ak thinking_level=high \
  --jobs-dir packages/evals/.eval/deep-swe --prune-docker-cache
```

Detach with Ctrl-b, then d. After reconnecting SSH, use `tmux attach -t paper-eval`.
The launcher prints the job directory before execution. Keep that directory and the original
task paths. When inference becomes unreachable, the runner saves staged work, logs, and a partial
patch, closes zones, and pauses the job after the trial result and verification finish. The
launcher exits with status 75 and prints a resume command. Reconnect the VPN, restore host model
credentials as needed, then run from the paper-pi checkout:

```sh
. packages/evals/pier/.venv/bin/activate
export PYTHONPATH="$PWD/packages/evals/pier${PYTHONPATH:+:$PYTHONPATH}"
python -m paper_job resume packages/evals/.eval/deep-swe/<job-name>
```

Resume uses the saved task selection, model ID, agent options, limits, concurrency, and pruning
setting. It restarts the interrupted task **from the beginning**, with a fresh conversation and
workspace. Completed graded tasks are skipped, including reward zero, graded timeouts, and
finalized ordinary agent failures. Infrastructure failures and attempts without verification
are also retried. Their complete trial directories are moved under `<job-dir>/.interrupted/`
before Pier scans completed results, preserving logs, patches, and previous verifier output.
The same command handles a manual interruption or process crash. Concurrent launches/resumes
of the same job are rejected. Jobs created with the earlier documented `pier run` command can
also be resumed if they use this agent, local Docker, and `max_retries = 0`.

The connectivity monitor runs on the host, where paper-pi makes its LLM requests. Before the
prompt and while inference is active, it probes the effective model endpoint's `/models` route
without generating tokens. A probe times out after 20 seconds; probes are spaced 30 seconds apart,
and three consecutive failures confirm loss of access. Streamed model activity resets failures.
HTTP authentication errors, unsupported routes, and rate limits establish reachability and do
not trigger VPN recovery; transport failures and HTTP 502/503/504 count as unavailable. Actual
inference transport errors also trigger bounded connectivity confirmation. A reachable probe
does not prove inference succeeds: ordinary model/authentication errors remain visible as agent
failures. Faux-provider tests perform no connectivity probes.

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
storage is recorded with `storageLimitEnforced: false`. The image must include Python 3, bash,
cp, mount, and umount. Staged symlinks are unsupported.
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

With the venv active and Docker reachable:

```sh
python -m unittest discover -s packages/evals/pier -p 'test_paper_job.py' -v
PAPER_PIER_INTEGRATION=1 python -m unittest discover -s packages/evals/pier -p 'test_paper_agent*.py' -v
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
