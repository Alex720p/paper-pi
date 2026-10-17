"""paper-deepswe, with pi-deepswe's command interface and Docker zones."""

import argparse
import asyncio
import fcntl
import importlib.metadata
import json
import os
import random
import subprocess
import sys
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pier.models.job.config import JobConfig, RetryConfig
from pier.models.task.task import Task
from pier.models.task.verifier_mode import resolve_effective_verifier_env_config
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig

from paper_config import Config, ModelConfig
from paper_job import launch, resume, validate_tasks
from paper_recovery import first_valid_attempts, read_attempts, trial_rewards

PI_ROOT = Path(__file__).resolve().parents[3]
DEEPSWE_COMMIT = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea"
NODE_VERSION = "24.21.0"


def prepare_runtime(pi_root=PI_ROOT):
    node_bin = pi_root.parent / ".tools" / f"node-v{NODE_VERSION}-linux-x64" / "bin"
    os.environ["PATH"] = os.pathsep.join([
        str(Path(sys.executable).parent), str(node_bin), os.environ.get("PATH", ""),
    ])
    os.environ["TSX_TSCONFIG_PATH"] = str(pi_root / "tsconfig.json")


@contextmanager
def inference_lock(pi_root=PI_ROOT):
    with (pi_root.parent / ".deepswe-inference.lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another zones benchmark is using inference; wait for it to finish") from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def select_tasks(root, *, task, n_tasks, seed):
    root = root.expanduser()
    if not root.is_dir():
        raise ValueError(f"Tasks directory {root} is missing")
    if task:
        path = (root / task).resolve()
        if not path.is_relative_to(root.resolve()) or not (path / "task.toml").is_file():
            raise ValueError(f"Unknown task: {task}")
        return [path]
    paths = sorted(p.resolve() for p in root.iterdir() if (p / "task.toml").is_file())
    if not paths:
        raise ValueError(f"No tasks found in {root}")
    if n_tasks is not None:
        if n_tasks < 1 or n_tasks > len(paths):
            raise ValueError(f"n-tasks must be between 1 and {len(paths)}")
        random.Random(seed).shuffle(paths)
        paths = paths[:n_tasks]
    return paths


def build_job_config(config, paths, job_name, pi_root=PI_ROOT):
    return JobConfig(
        job_name=job_name, jobs_dir=config.run.jobs_dir.expanduser().resolve(),
        n_attempts=1, n_concurrent_trials=1, retry=RetryConfig(max_retries=0),
        agents=[AgentConfig(
            import_path="paper_agent:PaperAgent", model_name=config.model.identity,
            kwargs={"pi_root": str(pi_root), "model_config": config.model.model_dump(mode="json")},
        )],
        environment=EnvironmentConfig(
            import_path="paper_environment:PaperDockerEnvironment",
            kwargs={"prune_docker_cache": config.run.prune_docker_cache},
        ),
        tasks=[TaskConfig(path=p) for p in paths],
    )


def check_model_credentials(model):
    if model.api_key_env and not os.environ.get(model.api_key_env):
        raise ValueError(f"Set {model.api_key_env}, or omit api_key_env for an unauthenticated server")


def check_runtime(pi_root=PI_ROOT):
    version = subprocess.check_output(["node", "--version"], text=True).strip()
    if int(version.lstrip("v").split(".")[0]) < 24:
        raise ValueError("Install Node 24+ using python3 packages/evals/pier/bootstrap.py")
    for required in (
        pi_root / "node_modules/tsx/package.json",
        pi_root / "packages/coding-agent/examples/extensions/paper/node_modules/paper-api/dist/index.js",
    ):
        if not required.is_file():
            raise ValueError(f"Missing {required}; run python3 packages/evals/pier/bootstrap.py")
    probe = subprocess.run([
        "node", "--import", "tsx", "--input-type=module", "-e",
        "import '@earendil-works/pi-coding-agent'; "
        "import './packages/coding-agent/examples/extensions/paper/node_modules/paper-api/dist/index.js';",
    ], cwd=pi_root, capture_output=True, text=True)
    if probe.returncode:
        raise ValueError(f"Node source runtime is not ready; run the bootstrap.\n{probe.stderr}")


async def check_prerequisites(config, job):
    check_model_credentials(config.model)
    check_runtime(Path(job.agents[0].kwargs["pi_root"]))
    await validate_tasks(job)
    for selected in job.tasks:
        task = Task(selected.path)
        verifier = resolve_effective_verifier_env_config(task.config, None)
        if task.config.environment.allow_internet or verifier is None or verifier.allow_internet:
            raise ValueError(f"Task {task.name} must use a no-network agent and separate no-network verifier")
        if task.config.environment.mcp_servers or task.config.environment.skills_dir:
            raise ValueError(f"Task {task.name} requires unsupported MCP/skills")


def repository_state(path):
    commit = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True)
    dirty = subprocess.run(["git", "-C", str(path), "status", "--porcelain"], capture_output=True, text=True)
    return {"commit": commit.stdout.strip() if commit.returncode == 0 else None,
            "dirty": bool(dirty.stdout.strip()) if dirty.returncode == 0 else None}


def provenance(config, job):
    return {
        "label": "paper-pi Docker zones + model on DeepSWE", "adapter_version": "0.1.0",
        "pier_version": importlib.metadata.version("datacurve-pier"),
        "node_version": subprocess.check_output(["node", "--version"], text=True).strip(),
        "python_version": sys.version.split()[0],
        "python_packages": dict(sorted((dist.metadata["Name"], dist.version)
                                       for dist in importlib.metadata.distributions())),
        "provider_data": json.loads((PI_ROOT / "packages/ai/src/providers/data/.manifest.json").read_text()),
        "revisions": {"paperPi": repository_state(PI_ROOT),
                      "paperApi": repository_state(PI_ROOT.parent / "paper-api"),
                      "dataset": repository_state(config.run.tasks_dir.expanduser())},
        "pinned_deepswe_commit": DEEPSWE_COMMIT,
        "model": config.model.model_dump(mode="json"), "tasks": [p.path.name for p in job.tasks],
        "attempts": 1, "concurrency": 1, "whole_trial_retries": 0, "budgets": "task defaults",
        "prune_docker_cache": config.run.prune_docker_cache,
        "zone_profile": {"backend": "docker", "runtime": "runc", "submission": "staged source only"},
    }


def summarize(job_dir):
    job_dir = job_dir.expanduser().resolve()
    attempts = read_attempts(job_dir)
    selected = first_valid_attempts(attempts)
    # For tasks still lacking a valid grade, report the latest infrastructure outcome.
    latest = {attempt["key"]: attempt for attempt in attempts}
    trials = []
    history = []
    for attempt in attempts:
        result = attempt["result"]
        paper = ((result.get("agent_result") or {}).get("metadata") or {}).get("paper") or {}
        entry = {"task": result.get("task_name"), "rewards": trial_rewards(result, attempt["path"]),
                 "exception": result.get("exception_info"), "path": str(attempt["path"]),
                 "usage": result.get("agent_result"),
                 "interrupted": paper.get("inferenceUnavailable", False),
                 "infrastructure_error": attempt["infrastructure_error"]}
        chosen = selected.get(attempt["key"], latest[attempt["key"]])
        history.append({**entry, "selected": chosen is attempt})
        if chosen is attempt:
            trials.append(entry)
    return {"job_dir": str(job_dir), "trials": trials,
            "selection_policy": "first_valid_completed_grade", "attempts": history,
            "verified_trials": sum(not t["infrastructure_error"] for t in trials),
            "infrastructure_errors": sum(t["infrastructure_error"] for t in trials),
            "infrastructure_attempts": sum(t["infrastructure_error"] for t in history)}


def parser():
    result = argparse.ArgumentParser(description="paper-pi Docker zones on DeepSWE via Pier")
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("run", "check"):
        command = commands.add_parser(name)
        command.add_argument("--config", type=Path, required=True)
        selection = command.add_mutually_exclusive_group()
        selection.add_argument("--task")
        selection.add_argument("--n-tasks", type=int)
        selection.add_argument("--all", action="store_true")
        command.add_argument("--seed", type=int, default=0)
        command.add_argument("--prune-docker-cache", action="store_true")
    for name in ("summary", "resume"):
        commands.add_parser(name).add_argument("job_dir", type=Path)
    return result


async def execute(args):
    if args.command == "summary":
        print(json.dumps(summarize(args.job_dir), indent=2))
        return 0
    prepare_runtime()
    if args.command == "resume":
        saved = JobConfig.model_validate_json((args.job_dir / "config.json").read_text())
        if saved.n_concurrent_trials != 1 or saved.n_attempts != 1:
            raise ValueError("Resume requires concurrency=1 and one attempt per task")
        raw_model = saved.agents[0].kwargs.get("model_config")
        if raw_model is None:
            raise ValueError("Resume this native Pier job with python -m paper_job resume instead")
        model = ModelConfig.model_validate(raw_model)
        check_model_credentials(model)
        check_runtime(Path(saved.agents[0].kwargs["pi_root"]))
        with inference_lock():
            status = await resume(args.job_dir)
        print(json.dumps(summarize(args.job_dir), indent=2))
        return status
    config = Config.load(args.config)
    if args.prune_docker_cache:
        config.run.prune_docker_cache = True
    task = args.task
    if task is None and args.n_tasks is None and not args.all:
        task = "abs-module-cache-flags"
    paths = select_tasks(config.run.tasks_dir, task=task, n_tasks=args.n_tasks, seed=args.seed)
    name = datetime.now(UTC).strftime("paper-%Y%m%d-%H%M%S-") + uuid4().hex[:6]
    job = build_job_config(config, paths, name)
    await check_prerequisites(config, job)
    print(json.dumps({"tasks": [p.name for p in paths], "model": config.model.identity,
                      "endpoint": config.model.base_url, "concurrency": 1,
                      "prune_docker_cache": config.run.prune_docker_cache}, indent=2))
    if args.command == "check":
        print("Configuration/prerequisite checks passed. Inference and image tools are checked during trials.")
        return 0
    with inference_lock():
        status = await launch(job, provenance=provenance(config, job))
    print(json.dumps(summarize(job.jobs_dir / job.job_name), indent=2))
    return status


def main():
    try:
        status = asyncio.run(execute(parser().parse_args()))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"{Path(sys.argv[0]).name}: {error}", file=sys.stderr)
        status = 2
    except KeyboardInterrupt:
        status = 130
    sys.exit(status)


if __name__ == "__main__":
    main()
