# VPS validation (2026-10-12)

The zones launcher is installed at `/home/ubuntu/zones/paper-pi/.venv/bin/paper-deepswe`;
`pi-deepswe` remains a compatibility alias in that environment.
Node 24.21.0, Python 3.12.15, uv 0.12.23, and Pier 0.3.1 are pinned. Python packages
are installed from `uv.lock`; npm dependencies use the existing project lockfiles.
The local TOML preserves the original baseline model section verbatim.

Completed checks:

- `npm run check`: formatting, dependency/import/lock checks, TypeScript, and browser smoke passed.
- Python regressions: 35 unit tests passed.
- Eight Docker integration cases passed: completion, partial submission after agent failure,
  timeout, extended deadline, disconnect/resume, forced-kill cleanup, TOML configuration,
  and the installed console command with a local mock inference server.
- The mock server received `reasoning_effort=max`, `max_tokens=131072`, `temperature=0.95`,
  `top_p=1.0`, the configured model/key, and no developer-role messages or added
  `chat_template_kwargs`. Its six inference requests were sequential.
- All 113 selected task configurations passed the installed launcher's static preflight.
- `uv pip check` found all 142 installed Python packages compatible.
- The official `abs-module-cache-flags` image contains Python 3, bash, Git, cp, mount,
  umount, and Go. Its Git HEAD is the task's expected base commit, and it has no tracked symlinks.
- Its Docker exec overlay passed private-write, staged-refresh, restart, and cleanup checks.
  The container had no host bind mounts, network mode `none`, and an 8192 MiB memory ceiling.

The pilot image was pulled with digest
`sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1`.
The VPS had approximately 55 GiB free afterward. No swap, Nix, or microVM was installed.

These checks did not call the EPFL inference server or run a real model benchmark.
The remaining images were not pulled or inspected. Connect the EPFL VPN, export
`MODEL_API_KEY`, and run a pilot to verify real server request compatibility and measure
task memory/disk usage before the full corpus. Omit `--all` for the default single-task pilot.

From `/home/ubuntu/zones/paper-pi`, the full run command is:

```sh
.venv/bin/paper-deepswe run --config config.local.toml --all --prune-docker-cache
```

Results go to `packages/evals/.eval/deep-swe`. On inference loss the launcher exits 75 and
prints `.venv/bin/paper-deepswe resume <job-directory>` using the saved model and run settings.

## Comparison with the completed baseline run

Rechecked against `pi-20261008-184910-ccf2f9`'s saved `config.json`, job provenance, and
all 113 trial configurations/provenance files. The complete model settings match, including
the endpoint, GLM-5.3-Flash identity, 400000-token context, 131072-token output limit,
reasoning/max thinking and its map, temperature 0.95, top_p 1.0, compatibility fields,
API key variable name, and unspecified prices. Task selection and order match on the same
clean dataset revision. Attempts, concurrency, retry policy, and resource/timeout overrides
match. Tasks retain 2 CPUs, an 8192 MiB memory ceiling, 20480 MiB requested storage,
a 10800-second agent deadline, and a 1800-second verifier deadline.

The baseline run enabled cache pruning via the CLI flag. The local paper TOML now sets
`prune_docker_cache = true` explicitly to retain that policy even when the flag is omitted.
Dataset paths resolve to the same directory; the paper job output directory is separate.

Runtime versions differ: the baseline recorded stock Pi 1.1.0 with Node 22.19.0, while this
paper checkout identifies its Pi fork as 0.83.0 and uses Node 24.21.0. Both use Pier 0.3.1.
Matching evaluation settings does not make these identical agent builds; record the actual
runtime versions/revisions alongside the zones treatment when reporting the comparison.

## Implementation repairs (2026-10-15)

Source export now omits archive links from the host baseline and records them in
`agent/source-export.json`. Regular source extraction retains the safe path checks and rejects
special files. Both official Helm images passed actual `PaperAgent.setup`, with their original
`internal/chart/v3/loader/testdata/frobnitz_with_dev_null/null -> /dev/null` fixture still visible
inside exec before and after staged refresh. Each export recorded five skipped symlinks.
The verified image digests were:

- Array merge: `sha256:d8b573f9e37303fb1aeb03efbfbecb84be8ea2dabaefb34f09b66bb6f6c13721`.
- Manifest stream: `sha256:b6915c6766cbfd2a26301adcb79bcb49a0c84bbff4039920378c9ff854c48d2c`.

Staged tools now reject root `.git` metadata mutations before they can cause shutdown conflicts.
The harness retains ownership of its disposable Git repository. Shell Git commands and the
exec overlay, privileges, backing paths, refresh behavior and private-write persistence are
unchanged. The existing risk of corrupting a private overlay through direct backing-file
modification remains documented rather than silently changing the experiment's exec treatment.

The runner starts in its own process session. Deterministic tests send terminal-style SIGINT to
the launcher process group during inference and during bash: both preserve finalized runner
records and staged patches, leave no owned containers/volumes, release the lock, and start no
next task. Deadline-based timeouts remain graded attempts; manual cancellations remain retryable.

Recovery and summary share the first-valid-completed-grade policy. A valid reward 0 is retained
even if a later attempt passed; infrastructure/VPN attempts are preserved separately and remain
retryable. Resume records implementation hashes in `resume-history.jsonl`. Existing job settings,
raw grades, archived attempts and provenance are not rewritten by the repair.

The real job was inspected read-only: 78 valid results (48 passes, 30 failures) remained selected.
Both Helm tasks, OPA template reconstruction, and VPN-interrupted pwntools multiplexing still need
valid completed attempts. No real model inference or benchmark resume was launched for validation.

Completed repair checks:

- 42 Python unit tests passed (10 Docker cases skipped in the default unit invocation).
- Eight focused TypeScript staged-tool regressions passed.
- Ten real-Docker integration cases passed, including terminal-style Ctrl+C during inference
  and bash, graded timeout, disconnect/resume, and child-scoped forced-kill cleanup.
- The mock-inference console test rejected a staged `.git/HEAD` write, continued to a source
  submission graded 1, and confirmed that neither Git metadata nor link fixtures entered the
  submitted patch. All requests were local and serial.
- `npm run check` and `git diff --check` passed; installed source runtime imports passed.

Docker tests used the already fetched Helm array-merge image as `PAPER_PIER_TEST_BASE`, which
provides Python, Git, bash and mount utilities without installing packages. Both official Helm
setup checks used temporary environments and private overlays and removed their containers and
volumes afterward. Approximately 54 GiB of host storage remained free after validation.
