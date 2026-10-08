"""Adapter failures and cleanup, without Docker or model requests."""
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from pier.models.agent.context import AgentContext
from pier.agents.installed.base import NonZeroAgentExitCodeError
from paper_agent import HostCommandError, PaperAgent, cleanup_runner_resources, host_command


class PaperAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_pid_record_failure_still_waits_for_child_exit(self):
        pid = []

        def record(value):
            pid.append(value)
            raise OSError("artifact unavailable")

        with self.assertRaisesRegex(OSError, "artifact unavailable"):
            await host_command([sys.executable, "-c", "import time; time.sleep(60)"], on_start=record)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid[0], 0)

    async def test_cleanup_is_scoped_to_the_child_pid(self):
        command = AsyncMock(side_effect=["owned-container\n", "", "owned-volume\n", ""])
        with patch("paper_agent.host_command", command):
            await cleanup_runner_resources(12345)
        calls = [call.args[0] for call in command.call_args_list]
        self.assertIn("label=paper-api.owner-pid=12345", calls[0])
        self.assertIn("label=paper-api.managed=true", calls[0])
        self.assertEqual(calls[1], ["docker", "rm", "--force", "owned-container"])
        self.assertIn("label=paper-api.owner-pid=12345", calls[2])
        self.assertEqual(calls[3], ["docker", "volume", "rm", "owned-volume"])

    async def test_forced_kill_waits_for_child_exit_and_preserves_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            pid = []
            forced = []
            task = asyncio.create_task(host_command([
                sys.executable, "-c",
                "import signal,time,pathlib; signal.signal(signal.SIGUSR1, signal.SIG_IGN); "
                f"pathlib.Path({str(ready)!r}).touch(); time.sleep(60)",
            ], cancellation_signal=signal.SIGUSR1, on_start=pid.append, on_force_kill=lambda: forced.append(True)))
            for _ in range(100):
                if ready.exists():
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(ready.exists())
            with patch("paper_agent.CANCELLATION_GRACE_SECONDS", 0.01):
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(forced, [True])
            with self.assertRaises(ProcessLookupError):
                os.kill(pid[0], 0)

    async def _trial(self, result, runner_error=None, submission_error=None, forced=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        agent = PaperAgent(logs_dir=root / "logs", model_name="faux/faux-1")
        agent._temporary = temporary
        agent._workspace = root / "workspace"
        agent._workspace.mkdir()
        agent._image = "fixture"
        agent._submit = AsyncMock(side_effect=submission_error)
        environment = SimpleNamespace(environment_dir=root / "task/environment", task_env_config=SimpleNamespace(
            env={}, memory_mb=1024, cpus=1, allow_internet=False, storage_mb=1024))
        context = AgentContext()

        async def command(argv, **kwargs):
            if argv[0] == "node":
                kwargs["on_start"](12345)
                self.assertNotIn("timeoutMs", json.loads(Path(argv[-1]).read_text()))
                if result is not None:
                    (agent.logs_dir / "paper-result.json").write_text(json.dumps(result))
                if forced:
                    kwargs["on_force_kill"]()
                if runner_error:
                    raise runner_error
            return ""

        with patch("paper_agent.host_command", command), patch("paper_agent.cleanup_runner_resources", AsyncMock()) as cleanup:
            caught = None
            try:
                await agent._run_trial("task", environment, context)
            except BaseException as error:
                caught = error
            cleanup.assert_awaited_once_with(12345)
        return agent, context, caught

    async def test_agent_error_submits_and_uses_pier_verifiable_exception(self):
        agent, context, error = await self._trial({"status": "error", "failureKind": "agent", "submissionReady": True}, HostCommandError("model failed"))
        agent._submit.assert_awaited_once()
        self.assertIsInstance(error, NonZeroAgentExitCodeError)
        self.assertTrue(context.metadata["paper"]["submissionReady"])

    async def test_timeout_submits_and_preserves_asyncio_cancellation(self):
        agent, _, error = await self._trial({"status": "timeout", "submissionReady": True}, asyncio.CancelledError())
        agent._submit.assert_awaited_once()
        self.assertIsInstance(error, asyncio.CancelledError)

    async def test_infrastructure_failure_is_not_submitted(self):
        for result, forced in ((None, False), ({"status": "error", "failureKind": "infrastructure", "submissionReady": False}, False),
                               ({"status": "completed", "submissionReady": True}, True)):
            with self.subTest(result=result, forced=forced):
                agent, context, error = await self._trial(result, asyncio.CancelledError(), forced=forced)
                agent._submit.assert_not_awaited()
                self.assertIsInstance(error, RuntimeError)
                self.assertNotIsInstance(error, NonZeroAgentExitCodeError)
                self.assertEqual(context.metadata["paper"]["failureKind"], "infrastructure")

    async def test_submission_failure_is_infrastructure(self):
        _, context, error = await self._trial({"status": "completed", "submissionReady": True}, submission_error=RuntimeError("patch failed"))
        self.assertIsInstance(error, RuntimeError)
        self.assertNotIsInstance(error, NonZeroAgentExitCodeError)
        self.assertFalse(context.metadata["paper"]["submissionReady"])


class PaperForcedKillIntegration(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    async def test_force_kill_removes_only_child_owned_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            pid = []
            forced = []
            child = asyncio.create_task(host_command([
                sys.executable, "-c", "import signal,time,pathlib; signal.signal(signal.SIGUSR1, signal.SIG_IGN); "
                f"pathlib.Path({str(ready)!r}).touch(); time.sleep(60)",
            ], cancellation_signal=signal.SIGUSR1, on_start=pid.append, on_force_kill=lambda: forced.append(True)))
            containers = []
            volumes = []
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(ready.exists())
                for role, owner in (("owned", pid[0]), ("foreign", os.getpid())):
                    name = f"paper-force-kill-test-{pid[0]}-{role}"
                    labels = ["--label", "paper-api.managed=true", "--label", "paper-api.zone=exec",
                              "--label", f"paper-api.owner-pid={owner}"]
                    await host_command(["docker", "volume", "create", *labels, name])
                    volumes.append(name)
                    container = (await host_command(["docker", "create", "--name", name, *labels,
                                                     "--mount", f"type=volume,source={name},target=/paper-state",
                                                     "busybox:stable-musl", "tail", "-f", "/dev/null"])).strip()
                    containers.append(container)
                    await host_command(["docker", "start", container])
                with patch("paper_agent.CANCELLATION_GRACE_SECONDS", 0.01):
                    child.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await child
                self.assertEqual(forced, [True])
                await cleanup_runner_resources(pid[0])
                with self.assertRaises(HostCommandError):
                    await host_command(["docker", "inspect", containers[0]])
                with self.assertRaises(HostCommandError):
                    await host_command(["docker", "volume", "inspect", volumes[0]])
                await host_command(["docker", "inspect", containers[1]])
                await host_command(["docker", "volume", "inspect", volumes[1]])
            finally:
                if not child.done():
                    child.cancel()
                    with suppress(asyncio.CancelledError):
                        await child
                for container in containers:
                    with suppress(HostCommandError):
                        await host_command(["docker", "rm", "--force", container])
                for volume in volumes:
                    with suppress(HostCommandError):
                        await host_command(["docker", "volume", "rm", volume])


if __name__ == "__main__":
    unittest.main()
