"""Retry confirmed inference disconnections and retain every other outcome."""

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


def trial_rewards(result, trial_dir):
    rewards = (result.get("verifier_result") or {}).get("rewards")
    reward_path = trial_dir / "verifier/reward.json"
    if rewards is None and reward_path.is_file():
        rewards = json.loads(reward_path.read_text())
    return rewards


def is_infrastructure_failure(result, trial_dir):
    if result is None:
        return True
    paper = ((result.get("agent_result") or {}).get("metadata") or {}).get("paper") or {}
    error = result.get("exception_info")
    return (
        trial_rewards(result, trial_dir) is None
        or paper.get("inferenceUnavailable") is True
        or paper.get("failureKind") == "infrastructure"
        or paper.get("submissionReady") is False
        or (error is not None and error.get("exception_type") not in
            ("AgentTimeoutError", "TimeoutError", "NonZeroAgentExitCodeError"))
    )


def is_inference_disconnect(result):
    paper = ((result.get("agent_result") or {}).get("metadata") or {}).get("paper") or {}
    error = result.get("exception_info") or {}
    return paper.get("inferenceUnavailable") is True or error.get("exception_type") == "InferenceUnavailableError"


def read_attempts(job_dir):
    attempts = []
    for path in [*job_dir.glob("*/result.json"), *job_dir.glob(".interrupted/*/result.json")]:
        result = json.loads(path.read_text())
        task_path = ((result.get("config") or {}).get("task") or {}).get("path")
        key = result.get("task_name") or task_path or result.get("trial_name") or path.parent.name
        started = result.get("started_at")
        started = datetime.fromisoformat(started.replace("Z", "+00:00")) if started else datetime.fromtimestamp(path.stat().st_mtime, UTC)
        if started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
        attempts.append({"path": path.parent, "result": result, "key": str(key),
                         "started": started, "infrastructure_error": is_infrastructure_failure(result, path.parent),
                         "retryable": is_inference_disconnect(result)})
    return sorted(attempts, key=lambda attempt: (attempt["started"], str(attempt["path"])))


def first_non_vpn_attempts(attempts):
    selected = {}
    for attempt in attempts:
        if not attempt["retryable"]:
            selected.setdefault(attempt["key"], attempt)
    return selected


def is_unstarted_queue_record(trial, job_dir, attempts):
    # Pier writes config.json before START hooks. When the disconnect guard
    # rejects the next serial task, only this empty layout remains on disk.
    config = trial / "config.json"
    log = trial / "trial.log"
    saved = job_dir / "config.json"
    if trial.is_symlink() or not saved.is_file() or config.is_symlink() or not config.is_file():
        return False
    if log.is_symlink() or not log.is_file() or log.stat().st_size:
        return False
    if json.loads(saved.read_text()).get("n_concurrent_trials") != 1:
        return False
    for entry in trial.iterdir():
        if entry.name in ("config.json", "trial.log"):
            continue
        if entry.name not in ("agent", "verifier", "artifacts") or entry.is_symlink() or not entry.is_dir() or any(entry.iterdir()):
            return False
    for attempt in attempts:
        finished = attempt["result"].get("finished_at")
        if not attempt["retryable"] or not finished:
            continue
        finished = datetime.fromisoformat(finished.replace("Z", "+00:00"))
        if finished.tzinfo is None:
            finished = finished.replace(tzinfo=UTC)
        if config.stat().st_mtime >= finished.timestamp():
            return True
    return False


def archive_unfinished_trials(job_dir, *, first_attempt_only=True):
    # Classify every attempt before moving any, so malformed artifacts cannot
    # leave a partially archived job. Include result-less starts that lack config.
    attempts = read_attempts(job_dir)
    by_path = {attempt["path"]: attempt for attempt in attempts}
    selected = first_non_vpn_attempts(attempts)
    unfinished = []
    trials = [path for path in job_dir.iterdir() if path.is_dir() and not path.name.startswith(".")]
    archive = job_dir / ".interrupted"
    if archive.is_dir():
        trials.extend(path for path in archive.iterdir() if path.is_dir())
    for trial in sorted(trials):
        if not any((trial / name).exists() for name in ("config.json", "result.json", "trial.log", "agent", "verifier", "artifacts")):
            continue
        attempt = by_path.get(trial)
        if attempt is None:
            if is_unstarted_queue_record(trial, job_dir, attempts):
                if trial.parent == job_dir:
                    unfinished.append(trial)
                continue
            raise ValueError(f"Cannot resume: {trial} has no result proving an inference disconnection; "
                             "VPN-only retry policy preserves this attempt for inspection")
        if trial.parent != job_dir:
            continue
        if attempt["retryable"] or (first_attempt_only and selected[attempt["key"]]["path"] != trial):
            unfinished.append(trial)
    restorations = []
    for attempt in selected.values() if first_attempt_only else []:
        if attempt["path"].parent != job_dir / ".interrupted":
            continue
        result = attempt["result"]
        name = result.get("trial_name") or (result.get("config") or {}).get("trial_name")
        if not name or Path(name).name != name or name in (".", ".."):
            raise ValueError(f"Archived non-VPN attempt lacks a safe trial_name: {attempt['path']}")
        target = job_dir / name
        if target.exists() and target not in unfinished:
            raise ValueError(f"Cannot restore non-VPN attempt over {target}")
        restorations.append((attempt["path"], target))
    archived = []
    for trial in unfinished:
        archive = job_dir / ".interrupted"
        archive.mkdir(exist_ok=True)
        destination = archive / f"{trial.name}-{uuid4().hex[:8]}"
        trial.rename(destination)
        archived.append(destination)
    for source, destination in restorations:
        source.rename(destination)
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
        if any(agent.kwargs.get("model_config") is not None for agent in job.config.agents):
            executable = Path(sys.executable).parent / "paper-deepswe"
            command = f"{shlex.quote(str(executable))} resume {shlex.quote(str(job.job_dir))}"
        print(f"Inference access was lost. Results and partial work are saved.\n"
              f"Reconnect the VPN/SSH session, restore host credentials, then run:\n  {command}", file=sys.stderr)
        return 75
    state["status"] = "finished"
    state_path.write_text(json.dumps(state, indent=2) + "\n")
    return 0
