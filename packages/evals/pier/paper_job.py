"""Run and resume paper-pi jobs using Pier's persisted configuration and results."""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import yaml
from pier.job import Job
from pier.models.job.config import DatasetConfig, JobConfig
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig
from pier.models.task.task import Task

from paper_environment import PaperDockerEnvironment
from paper_recovery import archive_unfinished_trials, job_lock, run_job


def validate_config(config):
    if importlib.metadata.version("datacurve-pier") != "0.3.1":
        raise ValueError("The paper adapter requires datacurve-pier==0.3.1")
    if len(config.agents) != 1 or config.agents[0].import_path != "paper_agent:PaperAgent":
        raise ValueError("Only jobs using paper_agent:PaperAgent can be launched or resumed")
    if config.environment.import_path not in (None, "paper_environment:PaperDockerEnvironment"):
        raise ValueError("The paper adapter requires its local Docker environment")
    if config.environment.import_path is None and config.environment.type.value != "docker":
        raise ValueError("The paper adapter requires a Docker environment")
    pruning = config.environment.kwargs.get("prune_docker_cache", False)
    if type(pruning) is not bool:
        raise ValueError("prune_docker_cache must be a boolean")
    if config.n_concurrent_trials < 1 or config.n_attempts < 1:
        raise ValueError("Concurrency and attempts must be positive")
    if config.retry.max_retries != 0:
        raise ValueError("VPN-only retry policy requires max_retries=0")
    if pruning and (config.n_concurrent_trials != 1 or not config.environment.delete):
        raise ValueError("prune_docker_cache requires concurrency=1 and environment.delete=true")
    if pruning and config.environment.import_path != "paper_environment:PaperDockerEnvironment":
        raise ValueError("Pruning requires the paper Docker environment")
    model = config.agents[0].model_name
    if not model or "/" not in model:
        raise ValueError("Select --model provider/model-id")


async def validate_tasks(config):
    paths = [task.get_local_path() for task in config.tasks]
    for dataset in config.datasets:
        paths.extend(task.get_local_path() for task in await dataset.get_task_configs(config.verifier.disable))
    if not paths:
        raise ValueError("No tasks selected; provide --path or a job config with tasks")
    for path in paths:
        task = Task(path)
        if task.has_steps or task.config.environment.os.value != "linux":
            raise ValueError("The paper adapter supports single-step Linux tasks")
    PaperDockerEnvironment.preflight()
    subprocess.run(["docker", "compose", "version"], check=True, capture_output=True)


async def build_config(args):
    config = (JobConfig.model_validate(yaml.safe_load(args.config.read_text())) if args.config else
              JobConfig(n_concurrent_trials=1, agents=[AgentConfig(import_path="paper_agent:PaperAgent")]))
    if args.path is not None:
        path = args.path.expanduser().resolve()
        config.datasets = []
        config.tasks = []
        if (path / "task.toml").is_file():
            if args.n_tasks is not None or args.sample_seed is not None:
                raise ValueError("Sampling options require a tasks directory")
            config.tasks = [TaskConfig(path=path)]
        else:
            if args.n_tasks is not None and args.n_tasks < 1:
                raise ValueError("--n-tasks must be positive")
            config.datasets = [DatasetConfig(path=path, n_tasks=args.n_tasks, sample_seed=args.sample_seed)]
    elif args.n_tasks is not None or args.sample_seed is not None:
        raise ValueError("Sampling options require --path")
    if len(config.agents) != 1:
        raise ValueError("Select exactly one paper agent")
    agent = config.agents[0]
    if args.model is not None:
        agent.model_name = args.model
    for value in args.agent_kwarg:
        key, separator, raw = value.partition("=")
        if not key or not separator:
            raise ValueError("--ak expects key=value")
        try:
            agent.kwargs[key] = json.loads(raw)
        except json.JSONDecodeError:
            agent.kwargs[key] = raw
    agent.kwargs.setdefault("pi_root", str(Path(__file__).resolve().parents[3]))
    if args.jobs_dir is not None:
        config.jobs_dir = args.jobs_dir
    config.jobs_dir = config.jobs_dir.expanduser().resolve()
    if args.job_name is not None:
        config.job_name = args.job_name
    elif not args.config:
        config.job_name = datetime.now(UTC).strftime("paper-%Y%m%d-%H%M%S-") + uuid4().hex[:6]
    if Path(config.job_name).name != config.job_name or config.job_name in ("", ".", ".."):
        raise ValueError("--job-name must be a directory name")
    if args.n_concurrent is not None:
        config.n_concurrent_trials = args.n_concurrent
    if args.max_retries is not None:
        config.retry.max_retries = args.max_retries
    if config.retry.max_retries != 0:
        raise ValueError("Use --max-retries 0; resume preserves interrupted attempts instead of deleting retries")
    # Retain all native resource/timeout options while selecting our manifest environment.
    if config.environment.import_path is None and config.environment.type.value == "docker":
        config.environment = EnvironmentConfig.model_validate({
            **config.environment.model_dump(), "type": None,
            "import_path": "paper_environment:PaperDockerEnvironment",
        })
    if args.prune_docker_cache:
        config.environment.kwargs["prune_docker_cache"] = True
    validate_config(config)
    # Freeze dataset selection as absolute local paths; resume cannot resample a changed corpus.
    selected = list(config.tasks)
    for dataset in config.datasets:
        selected.extend(await dataset.get_task_configs(config.verifier.disable))
    config.tasks = [task.model_copy(update={"path": task.get_local_path().resolve()}) for task in selected]
    config.datasets = []
    await validate_tasks(config)
    return config


def exit_status(job_dir, status):
    if status:
        return status
    results = [json.loads(path.read_text()) for path in job_dir.glob("*/result.json")]
    # Ordinary graded agent failures and timeouts remain completed benchmark attempts.
    return int(not results or any(result.get("verifier_result") is None for result in results))


async def launch(config, *, provenance=None):
    job_dir = config.jobs_dir / config.job_name
    job_dir.mkdir(parents=True, exist_ok=False)
    with job_lock(job_dir):
        (job_dir / "config.json").write_text(config.model_dump_json(indent=2) + "\n")
        if provenance is not None:
            (job_dir / "pi-deepswe-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        job = await Job.create(config)
        print(f"Job directory: {job_dir}", flush=True)
        status = await run_job(job, prune=config.environment.kwargs.get("prune_docker_cache", False))
    return exit_status(job_dir, status)


async def resume(job_dir):
    job_dir = job_dir.expanduser().resolve()
    with job_lock(job_dir):
        saved = JobConfig.model_validate_json((job_dir / "config.json").read_text())
        if (saved.jobs_dir / saved.job_name).resolve() != job_dir:
            raise ValueError("Resume from the original job directory; saved paths must still exist")
        validate_config(saved)
        if saved.retry.max_retries != 0:
            raise ValueError("Only jobs with max_retries=0 can be resumed without deleting attempt artifacts")
        await validate_tasks(saved)
        pi_root = Path(saved.agents[0].kwargs.get("pi_root", Path(__file__).resolve().parents[3]))
        sources = [*Path(__file__).parent.glob("paper_*.py"),
                   pi_root / "packages/evals/src/paper-pier.ts",
                   *sorted((pi_root / "packages/coding-agent/examples/extensions/paper").glob("*.ts"))]
        revision = subprocess.run(["git", "-C", str(pi_root), "rev-parse", "HEAD"], capture_output=True, text=True)
        entry = {"started_at": datetime.now(UTC).isoformat(),
                 "selection_policy": "first_non_vpn_attempt" if saved.n_attempts == 1 else "native_multiple_attempts_vpn_retries_only",
                 "commit": revision.stdout.strip() if revision.returncode == 0 else None,
                 "source_sha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}}
        archived = archive_unfinished_trials(job_dir, first_attempt_only=saved.n_attempts == 1)
        entry["archived_attempts"] = [str(path.relative_to(job_dir)) for path in archived]
        with (job_dir / "resume-history.jsonl").open("a") as history:
            history.write(json.dumps(entry, sort_keys=True) + "\n")
        print(f"Resuming {job_dir}; archived {len(archived)} disconnected or superseded attempts.", flush=True)
        job = await Job.create(saved)
        status = await run_job(job, prune=saved.environment.kwargs.get("prune_docker_cache", False))
    return exit_status(job_dir, status)


def parser():
    result = argparse.ArgumentParser(description="Run paper-pi with resumable Pier jobs")
    commands = result.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Launch a new job; defaults to serial execution")
    run.add_argument("--config", type=Path, help="Native Pier JSON/YAML job configuration")
    run.add_argument("-p", "--path", type=Path, help="Task directory or corpus tasks directory")
    run.add_argument("--model", help="Pi provider/model-id")
    run.add_argument("--jobs-dir", type=Path)
    run.add_argument("--job-name")
    run.add_argument("--n-tasks", type=int)
    run.add_argument("--sample-seed", type=int)
    run.add_argument("--n-concurrent", type=int)
    run.add_argument("--max-retries", type=int)
    run.add_argument("--ak", dest="agent_kwarg", action="append", default=[])
    run.add_argument("--prune-docker-cache", action="store_true",
                     help="Remove unused trial image tags and builder-wide cache; requires concurrency=1")
    restart = commands.add_parser("resume", help="Retry confirmed inference disconnections using saved job settings")
    restart.add_argument("job_dir", type=Path)
    return result


def main():
    args = parser().parse_args()
    try:
        if args.command == "resume":
            status = asyncio.run(resume(args.job_dir))
        else:
            status = asyncio.run(launch(asyncio.run(build_config(args))))
    except (ValueError, OSError, subprocess.CalledProcessError, yaml.YAMLError) as error:
        print(f"paper_job: {error}", file=sys.stderr)
        status = 2
    except KeyboardInterrupt:
        status = 130
    sys.exit(status)


if __name__ == "__main__":
    main()
