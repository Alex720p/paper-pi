"""Preserve interrupted attempts and stop the queue when inference access disappears."""

import fcntl
import json
import shlex
import sys
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pier.trial.hooks import TrialEvent

from paper_cleanup import prune_trial_docker_cache


class StopForDisconnect(Exception):
    pass


@contextmanager
def job_lock(job_dir):
    with (job_dir / ".paper-pier-run.lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"A benchmark process is already running in {job_dir}") from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def archive_unfinished_trials(job_dir):
    # Classify every attempt before moving any, so malformed artifacts cannot
    # leave a partially archived job. Include result-less starts that lack config.
    unfinished = []
    for trial in sorted(job_dir.iterdir()):
        if not trial.is_dir() or trial.name.startswith("."):
            continue
        if not any((trial / name).exists() for name in ("config.json", "result.json", "trial.log", "agent", "verifier", "artifacts")):
            continue
        result_path = trial / "result.json"
        retry = not result_path.exists()
        if result_path.exists():
            result = json.loads(result_path.read_text())
            error = result.get("exception_info")
            metadata = (result.get("agent_result") or {}).get("metadata") or {}
            paper = metadata.get("paper") or {}
            retry = (
                paper.get("inferenceUnavailable") is True
                or (error is not None and error.get("exception_type") not in
                    ("AgentTimeoutError", "TimeoutError", "NonZeroAgentExitCodeError"))
                or not (trial / "verifier/reward.json").is_file()
            )
        if retry:
            unfinished.append(trial)
    archived = []
    for trial in unfinished:
        archive = job_dir / ".interrupted"
        archive.mkdir(exist_ok=True)
        destination = archive / f"{trial.name}-{uuid4().hex[:8]}"
        trial.rename(destination)
        archived.append(destination)
    return archived


async def run_job(job, *, prune):
    stopping = False

    async def guard_start(_event):
        if stopping:
            raise StopForDisconnect("Inference access was lost")

    async def ended(event):
        nonlocal stopping
        result = event.result
        info = result.exception_info if result is not None else None
        metadata = result.agent_result.metadata if result is not None and result.agent_result is not None else {}
        disconnected = (
            info is not None and info.exception_type == "InferenceUnavailableError"
        ) or ((metadata or {}).get("paper") or {}).get("inferenceUnavailable") is True
        stopping = stopping or disconnected
        if prune:
            await prune_trial_docker_cache(event)
        if disconnected:
            raise StopForDisconnect("Inference access was lost")

    job.add_hook(TrialEvent.START, guard_start)
    job.on_trial_ended(ended)
    state_path = job.job_dir / "run-state.json"
    state = {"status": "running", "started_at": datetime.now(UTC).isoformat()}
    state_path.write_text(json.dumps(state, indent=2) + "\n")
    disconnected = False
    try:
        try:
            await job.run()
        except* StopForDisconnect:
            disconnected = True
    finally:
        state.update(status="paused" if stopping else "stopped", updated_at=datetime.now(UTC).isoformat())
        state_path.write_text(json.dumps(state, indent=2) + "\n")
    if disconnected:
        command = f"{shlex.quote(sys.executable)} -m paper_job resume {shlex.quote(str(job.job_dir))}"
        print(f"Inference access was lost. Results and partial work are saved.\n"
              f"Reconnect the VPN/SSH session, restore host credentials, then run:\n  {command}", file=sys.stderr)
        return 75
    state["status"] = "finished"
    state_path.write_text(json.dumps(state, indent=2) + "\n")
    return 0
