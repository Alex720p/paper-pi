"""Host-side paper-pi agent for Pier 0.3.1's local Docker environment."""

import asyncio
import json
import os
from pathlib import Path
import shlex
import signal
import tarfile
import tempfile
import time
import uuid

from pier.agents.base import BaseAgent
from pier.agents.installed.base import NonZeroAgentExitCodeError
from pier.environments.base import BaseEnvironment
from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext


class HostCommandError(RuntimeError):
    """A completed host process failed; infrastructure callers retain RuntimeError semantics."""


CANCELLATION_GRACE_SECONDS = 15


async def host_command(argv, *, cwd=None, env=None, output=None, error_output=None,
                       cancellation_signal=signal.SIGTERM, on_start=None, on_force_kill=None):
    process = await asyncio.create_subprocess_exec(
        *map(str, argv), cwd=cwd, env=env,
        stdout=output if output is not None else asyncio.subprocess.PIPE,
        stderr=error_output if error_output is not None else asyncio.subprocess.PIPE,
    )
    try:
        if on_start is not None:
            on_start(process.pid)
        stdout, stderr = await process.communicate()
    except asyncio.CancelledError:
        if process.returncode is None:
            try:
                process.send_signal(cancellation_signal)
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), CANCELLATION_GRACE_SECONDS)
        except asyncio.TimeoutError:
            try:
                if on_force_kill is not None:
                    on_force_kill()
            finally:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
        raise
    except BaseException:
        # A PID-artifact write can fail too; resource cleanup must still run after child exit.
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        raise
    if process.returncode:
        detail = (stderr or b"").decode(errors="replace")
        if error_output is not None:
            detail = f"see {error_output.name}"
        raise HostCommandError(f"{argv[0]} exited {process.returncode}: {detail}")
    return (stdout or b"").decode()


async def cleanup_runner_resources(pid):
    """Called only after this child exits; never reap another trial's resources."""
    filters = ["--filter", "label=paper-api.managed=true",
               "--filter", f"label=paper-api.owner-pid={pid}"]
    containers = (await host_command(["docker", "ps", "-aq", *filters])).split()
    if containers:
        await host_command(["docker", "rm", "--force", *containers])
    volumes = (await host_command(["docker", "volume", "ls", "-q", *filters,
                                  "--filter", "label=paper-api.zone=exec"])).split()
    if volumes:
        await host_command(["docker", "volume", "rm", *volumes])


async def stage_host_files(workspace):
    """Explicit paths in a disposable repository; never stage a developer checkout."""
    paths = [str(path.relative_to(workspace)) for path in workspace.rglob("*")
             if ".git" not in path.relative_to(workspace).parts
             and (path.is_file() or path.is_symlink())]
    for offset in range(0, len(paths), 100):
        await host_command(["git", "--literal-pathspecs", "add", "--force", "--", *paths[offset:offset+100]], cwd=workspace)
    # Explicitly record deleted tracked paths too.
    deleted = await host_command(["git", "ls-files", "--deleted", "-z"], cwd=workspace)
    paths = [path for path in deleted.split("\0") if path]
    for offset in range(0, len(paths), 100):
        await host_command(["git", "--literal-pathspecs", "add", "--", *paths[offset:offset+100]], cwd=workspace)


class PaperAgent(BaseAgent):
    def __init__(self, *args, pi_root=None, fake_steps=None, thinking_level=None, max_output_tokens=None, **kwargs):
        self.extra_env = kwargs.pop("extra_env", {})
        super().__init__(*args, **kwargs)
        self.pi_root = Path(pi_root).resolve() if pi_root else Path(__file__).resolve().parents[3]
        self.fake_steps = fake_steps
        if thinking_level is not None and thinking_level not in ("off", "minimal", "low", "medium", "high", "xhigh", "max"):
            raise ValueError("Invalid thinking_level")
        if max_output_tokens is not None and (type(max_output_tokens) is not int or max_output_tokens < 1):
            raise ValueError("max_output_tokens must be a positive integer")
        self.thinking_level = thinking_level
        self.max_output_tokens = max_output_tokens
        self._temporary = None
        self._workspace = None
        self._image = None
        self._setup_ms = 0

    @staticmethod
    def name():
        return "paper-pi"

    def version(self):
        return "docker-v1"

    async def setup(self, environment: BaseEnvironment):
        if not isinstance(environment, DockerEnvironment) or str(environment.task_env_config.os) not in ("linux", "TaskOS.LINUX"):
            raise ValueError("paper-pi currently requires Pier's local Linux Docker environment")
        if self.mcp_servers or self.skills_dir:
            raise ValueError("paper-pi evaluation does not load external MCP servers or skills")
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Select --model provider/model-id")
        started = time.monotonic()
        # Isolate the one version-specific Pier access here, rather than duplicating image building.
        result = await environment._run_docker_compose_command(["ps", "-q", "main"])
        container_id = (result.stdout or "").strip()
        if not container_id or "\n" in container_id:
            raise RuntimeError("Expected exactly one Pier main container")
        self._image = (await host_command(["docker", "inspect", "--format", "{{.Image}}", container_id])).strip()
        self._temporary = tempfile.TemporaryDirectory(prefix="paper-pier-")
        root = Path(self._temporary.name)
        self._workspace = root / "workspace"
        self._workspace.mkdir()
        try:
            archive_path = f"/tmp/paper-source-{uuid.uuid4().hex}.tar"
            result = await environment.exec(
                f"cd /app && git -c safe.directory=/app archive --format=tar HEAD --output={archive_path}")
            if result.return_code:
                raise RuntimeError(f"Task repository export failed: {result.stderr}")
            await environment.download_file(archive_path, root / "source.tar")
            with tarfile.open(root / "source.tar") as archive:
                archive.extractall(self._workspace, filter="data")
            await host_command(["git", "init", "--quiet"], cwd=self._workspace)
            await stage_host_files(self._workspace)
            await host_command(["git", "-c", "user.name=paper-eval", "-c", "user.email=paper-eval@localhost",
                                "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "task base"], cwd=self._workspace)
            self._setup_ms = (time.monotonic()-started)*1000
        except BaseException:
            self._temporary.cleanup()
            raise

    async def _submit(self, environment):
        await stage_host_files(self._workspace)
        patch_path = self.logs_dir / "model.patch"
        with patch_path.open("wb") as output:
            await host_command(["git", "diff", "--cached", "--binary", "HEAD", "--"], cwd=self._workspace, output=output)
        if not patch_path.stat().st_size:
            return
        remote_patch = f"/tmp/paper-submit-{uuid.uuid4().hex}.patch"
        await environment.upload_file(patch_path, remote_patch)
        result = await environment.exec(
            "cd /app && (git -c safe.directory=/app update-index --refresh || true) && "
            f"git -c safe.directory=/app apply --index --binary {remote_patch} && "
            "git -c safe.directory=/app -c user.name=paper-eval -c user.email=paper-eval@localhost "
            "-c core.hooksPath=/dev/null commit -m 'paper staged solution'")
        if result.return_code:
            raise RuntimeError(f"Staged submission failed: {result.stdout} {result.stderr}")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext):
        try:
            await self._run_trial(instruction, environment, context)
        finally:
            if self._temporary is not None:
                self._temporary.cleanup()

    async def _run_trial(self, instruction: str, environment: BaseEnvironment, context: AgentContext):
        if self._workspace is None:
            raise RuntimeError("paper-pi setup did not complete")
        root = Path(self._temporary.name)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        provider, model = self.model_name.split("/", 1)
        env_keys = list(environment.task_env_config.env)
        task_env = {}
        if env_keys:
            code = "import os,json; print(json.dumps({k:os.environ[k] for k in " + repr(env_keys) + " if k in os.environ}))"
            result = await environment.exec("python3 -c " + shlex.quote(code))
            if result.return_code:
                raise RuntimeError("Could not resolve task environment variables")
            task_env = json.loads(result.stdout)
        input_path = root / "input.json"
        host_agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")).expanduser()
        input_path.write_text(json.dumps({
            "workspace": str(self._workspace), "agentDir": str(root / "agent"),
            "logsDir": str(self.logs_dir.resolve()), "image": self._image,
            "instruction": instruction, "provider": provider, "model": model,
            "memoryBytes": environment.task_env_config.memory_mb*1024*1024,
            "cpus": environment.task_env_config.cpus,
            "allowInternet": environment.task_env_config.allow_internet, "env": task_env,
            "authPath": str(host_agent_dir / "auth.json"), "modelsPath": str(host_agent_dir / "models.json"),
            **({"thinkingLevel": self.thinking_level} if self.thinking_level is not None else {}),
            **({"maxOutputTokens": self.max_output_tokens} if self.max_output_tokens is not None else {}),
            **({"fakeSteps": self.fake_steps} if self.fake_steps is not None else {}),
        }))
        env = dict(os.environ)
        env.update(self.extra_env)
        env["PI_CODING_AGENT_DIR"] = str(root / "agent")
        env["TSX_TSCONFIG_PATH"] = str(self.pi_root / "tsconfig.json")
        runner = self.pi_root / "packages/evals/src/paper-pier.ts"
        error = None
        runner_pid = None
        forced_kill = False

        def record_process(pid):
            nonlocal runner_pid
            runner_pid = pid
            (self.logs_dir / "runner-process.json").write_text(json.dumps({"pid": pid, "forcedKill": False}))

        def record_forced_kill():
            nonlocal forced_kill
            forced_kill = True
            (self.logs_dir / "runner-process.json").write_text(json.dumps({"pid": runner_pid, "forcedKill": True}))

        try:
            with (self.logs_dir / "runner-stdout.txt").open("wb") as output, (self.logs_dir / "runner-stderr.txt").open("wb") as diagnostics:
                await host_command(["node", "--import", "tsx", runner, input_path],
                                   cwd=self.pi_root, env=env, output=output, error_output=diagnostics,
                                   cancellation_signal=signal.SIGUSR1,
                                   on_start=record_process, on_force_kill=record_forced_kill)
        except BaseException as cause:
            error = cause
        finally:
            if runner_pid is not None:
                try:
                    await cleanup_runner_resources(runner_pid)
                except Exception as cause:
                    error = RuntimeError(f"Runner resource cleanup failed: {cause}")

        result_path = self.logs_dir / "paper-result.json"
        try:
            result = json.loads(result_path.read_text())
            if not isinstance(result, dict):
                raise ValueError("Expected a result object")
        except (OSError, ValueError) as cause:
            result = {"status": "error", "failureKind": "infrastructure", "submissionReady": False,
                      "error": f"Missing or invalid runner result: {cause}", "processId": runner_pid}
        if forced_kill or (error is not None and not isinstance(error, (HostCommandError, asyncio.CancelledError))):
            result.update(status="error", failureKind="infrastructure", submissionReady=False,
                          error="Runner required forced termination" if forced_kill else str(error))
        if result.get("submissionReady") is not True or result.get("failureKind") == "infrastructure":
            result.update(status="error", failureKind="infrastructure", submissionReady=False)
            error = RuntimeError(result.get("error") or "Runner did not finalize a submission")
        else:
            try:
                await self._submit(environment)
            except Exception as cause:
                result.update(status="error", failureKind="infrastructure", submissionReady=False, error=str(cause))
                error = RuntimeError(f"Submission infrastructure failed: {cause}")
            else:
                if isinstance(error, HostCommandError) or result.get("failureKind") == "agent":
                    if not isinstance(error, asyncio.CancelledError):
                        error = NonZeroAgentExitCodeError(result.get("error") or str(error))
        result_path.write_text(json.dumps(result, indent=2))
        stats = result.get("stats") or {}
        tokens = stats.get("tokens") or {}
        context.n_input_tokens = tokens.get("input", 0)+tokens.get("cacheRead", 0)+tokens.get("cacheWrite", 0)
        context.n_cache_tokens = tokens.get("cacheRead", 0)
        context.n_output_tokens = tokens.get("output", 0)
        context.cost_usd = stats.get("cost") if result.get("costAvailable") else None
        api_root = (self.pi_root / "packages/coding-agent/examples/extensions/paper/node_modules/paper-api").resolve()
        revisions = {}
        for name, repository in (("paperPi", self.pi_root), ("paperApi", api_root), ("dataset", environment.environment_dir.parent)):
            try:
                revisions[name] = {
                    "commit": (await host_command(["git", "rev-parse", "HEAD"], cwd=repository)).strip(),
                    "dirty": bool((await host_command(["git", "status", "--porcelain"], cwd=repository)).strip()),
                }
            except RuntimeError:
                revisions[name] = {"commit": None, "dirty": None}
        context.metadata = {"paper": result, "adapterSetupMs": self._setup_ms,
                            "pierVersion": "0.3.1", "revisions": revisions,
                            "storageMbRequested": environment.task_env_config.storage_mb,
                            "storageLimitEnforced": False}
        if error is not None:
            raise error
