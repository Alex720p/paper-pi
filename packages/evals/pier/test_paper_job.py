"""Recovery, pruning, and launcher policy without Docker or inference."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from pier.models.job.config import JobConfig
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig

import paper_cleanup
from paper_environment import PaperDockerEnvironment, DockerEnvironment
from paper_job import build_config, launch, parser, resume, validate_config
from paper_recovery import StopForDisconnect, archive_unfinished_trials, job_lock, run_job


def make_config(root, **kwargs):
    return JobConfig(
        jobs_dir=root, job_name="fixture", n_concurrent_trials=1,
        agents=[AgentConfig(import_path="paper_agent:PaperAgent", model_name="fixture/model")],
        environment=EnvironmentConfig(import_path="paper_environment:PaperDockerEnvironment"), **kwargs,
    )


class PaperJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def trial(self, name, error=None, reward=True, result=True, metadata=None):
        trial = self.root / name
        trial.mkdir()
        (trial / "config.json").write_text("{}")
        (trial / "agent").mkdir()
        (trial / "agent/model.patch").write_text("saved partial patch")
        if result:
            (trial / "result.json").write_text(json.dumps({
                "exception_info": {"exception_type": error} if error else None,
                "agent_result": {"metadata": metadata},
            }))
        if reward:
            (trial / "verifier").mkdir()
            (trial / "verifier/reward.json").write_text('{"reward": 0}')
        return trial

    def test_archive_preserves_graded_attempts_and_every_interrupted_artifact(self):
        retained = [self.trial("completed"), self.trial("timeout", error="AgentTimeoutError"),
                    self.trial("agent-error", error="NonZeroAgentExitCodeError")]
        interrupted = [self.trial("disconnected", error="InferenceUnavailableError"),
                       self.trial("incomplete", result=False), self.trial("ungraded", reward=False),
                       self.trial("infrastructure", error="RuntimeError"),
                       self.trial("disconnect-cleanup", error="RuntimeError", metadata={"paper": {"inferenceUnavailable": True}})]
        early = self.root / "early-start"
        early.mkdir()
        (early / "agent").mkdir()
        (self.root / "unrelated").mkdir()
        archived = archive_unfinished_trials(self.root)
        self.assertEqual(len(archived), 6)
        self.assertTrue(all(path.exists() for path in retained))
        self.assertTrue(all(not path.exists() for path in interrupted + [early]))
        self.assertEqual(sum((path / "agent/model.patch").exists() for path in archived), 5)
        self.assertTrue((self.root / "unrelated").exists())
        self.assertEqual(archive_unfinished_trials(self.root), [])

    def test_malformed_result_prevents_partial_archiving(self):
        first = self.trial("a-incomplete", result=False)
        corrupt = self.trial("z-corrupt")
        (corrupt / "result.json").write_text("{")
        with self.assertRaises(ValueError):
            archive_unfinished_trials(self.root)
        self.assertTrue(first.exists())

    def test_lock_rejects_concurrent_resume_and_releases_after_error(self):
        with self.assertRaises(RuntimeError):
            with job_lock(self.root):
                with self.assertRaisesRegex(ValueError, "already running"):
                    with job_lock(self.root):
                        self.fail("Concurrent lock acquired")
                raise RuntimeError("crash")
        with job_lock(self.root):
            pass

    def test_pruning_is_opt_in_and_requires_serial_deleted_environments(self):
        config = make_config(self.root)
        validate_config(config)
        self.assertFalse(config.environment.kwargs.get("prune_docker_cache", False))
        config.environment.kwargs["prune_docker_cache"] = True
        for concurrent, delete in ((2, True), (1, False)):
            config.n_concurrent_trials = concurrent
            config.environment.delete = delete
            with self.assertRaisesRegex(ValueError, "concurrency=1"):
                validate_config(config)

    async def test_pause_happens_after_result_persistence_and_cleanup(self):
        callbacks = []
        start = []
        event = SimpleNamespace(trial_id="trial", result=SimpleNamespace(
            exception_info=SimpleNamespace(exception_type="InferenceUnavailableError"), agent_result=None))

        async def execute():
            trial = self.trial("trial", error="InferenceUnavailableError")
            async def end():
                await callbacks[0](event)
            async with asyncio.TaskGroup() as group:
                group.create_task(end())
            self.fail("Must pause")

        async def cleanup(_event):
            self.assertTrue((self.root / "trial/result.json").exists())
            self.assertTrue((self.root / "trial/verifier/reward.json").exists())

        job = SimpleNamespace(job_dir=self.root, add_hook=lambda event, callback: start.append(callback),
                              on_trial_ended=callbacks.append, run=execute)
        cleaner = AsyncMock(side_effect=cleanup)
        with patch("paper_recovery.prune_trial_docker_cache", cleaner):
            self.assertEqual(await run_job(job, prune=True), 75)
        cleaner.assert_awaited_once()
        with self.assertRaises(StopForDisconnect):
            await start[0](None)
        self.assertEqual(json.loads((self.root / "run-state.json").read_text())["status"], "paused")

    async def test_disconnect_metadata_pauses_even_when_cleanup_overrides_exception(self):
        callbacks = []
        async def execute():
            event = SimpleNamespace(result=SimpleNamespace(
                exception_info=SimpleNamespace(exception_type="RuntimeError"),
                agent_result=SimpleNamespace(metadata={"paper": {"inferenceUnavailable": True}})))
            async with asyncio.TaskGroup() as group:
                group.create_task(callbacks[0](event))
        job = SimpleNamespace(job_dir=self.root, add_hook=Mock(), on_trial_ended=callbacks.append, run=execute)
        self.assertEqual(await run_job(job, prune=False), 75)

    async def test_unrelated_job_error_is_propagated_and_state_is_stopped(self):
        job = SimpleNamespace(job_dir=self.root, add_hook=Mock(), on_trial_ended=Mock(),
                              run=AsyncMock(side_effect=RuntimeError("disk full")))
        with self.assertRaisesRegex(RuntimeError, "disk full"):
            await run_job(job, prune=False)
        self.assertEqual(json.loads((self.root / "run-state.json").read_text())["status"], "stopped")

    async def test_launch_locks_and_saves_config_before_job_creation(self):
        config = make_config(self.root)
        async def create(saved):
            directory = saved.jobs_dir / saved.job_name
            self.assertEqual(JobConfig.model_validate_json((directory / "config.json").read_text()), saved)
            with self.assertRaises(ValueError):
                with job_lock(directory):
                    self.fail("Lock missing")
            return SimpleNamespace(job_dir=directory)
        with patch("paper_job.Job.create", AsyncMock(side_effect=create)), patch("paper_job.run_job", AsyncMock(return_value=75)):
            self.assertEqual(await launch(config), 75)
        with self.assertRaises(FileExistsError):
            await launch(config)

    async def test_invalid_resume_does_not_archive_attempts(self):
        config = make_config(self.root)
        (self.root / "config.json").write_text(config.model_dump_json())
        trial = self.trial("interrupted", result=False)
        with self.assertRaisesRegex(ValueError, "original job directory"):
            await resume(self.root)
        self.assertTrue(trial.exists())

    async def test_resume_uses_unchanged_saved_settings_after_archiving(self):
        config = make_config(self.root.parent, tasks=[TaskConfig(path=self.root / "task")])
        config.job_name = self.root.name
        (self.root / "config.json").write_text(config.model_dump_json())
        completed = self.trial("completed")
        interrupted = self.trial("interrupted", result=False)
        async def create(saved):
            self.assertEqual(saved, config)
            self.assertTrue(completed.exists())
            self.assertFalse(interrupted.exists())
            self.assertEqual(len(list((self.root / ".interrupted").iterdir())), 1)
            return SimpleNamespace(job_dir=self.root)
        with patch("paper_job.validate_tasks", AsyncMock()), patch("paper_job.Job.create", AsyncMock(side_effect=create)), \
             patch("paper_job.run_job", AsyncMock(return_value=75)):
            self.assertEqual(await resume(self.root), 75)

    async def test_cli_freezes_selection_and_preserves_native_budgets(self):
        paths = [self.root / name for name in ("task-a", "task-b", "task-c")]
        for path in paths:
            path.mkdir()
            (path / "task.toml").touch()
            (path / "instruction.md").touch()
            (path / "environment").mkdir()
            (path / "tests").mkdir()
            (path / "tests/test.sh").touch()
        config = make_config(self.root, agent_timeout_multiplier=2)
        saved = self.root / "input.json"
        saved.write_text(config.model_dump_json())
        args = parser().parse_args(["run", "--config", str(saved), "-p", str(self.root),
                                    "--n-tasks", "2", "--sample-seed", "42", "--ak", "thinking_level=high",
                                    "--prune-docker-cache"])
        with patch("paper_job.validate_tasks", AsyncMock()):
            built = await build_config(args)
        self.assertEqual(len(built.tasks), 2)
        self.assertEqual(built.datasets, [])
        self.assertTrue(all(task.path.is_absolute() for task in built.tasks))
        self.assertEqual(built.agent_timeout_multiplier, 2)
        self.assertEqual(built.agents[0].kwargs["thinking_level"], "high")
        self.assertTrue(built.environment.kwargs["prune_docker_cache"])


class PaperCleanupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    async def test_manifests_merge_agent_and_verifier_even_after_failed_builds(self):
        def environment(session, prebuilt=None):
            env = object.__new__(PaperDockerEnvironment)
            env.prune_docker_cache = True
            env.session_id = session
            env.task_env_config = SimpleNamespace(docker_image=prebuilt)
            env.agent_install_spec = None
            env.network_allowlist = SimpleNamespace(domains=[])
            env.trial_paths = SimpleNamespace(trial_dir=self.root)
            return env
        with patch.object(DockerEnvironment, "start", AsyncMock(side_effect=RuntimeError("build failed"))):
            for env, force in ((environment("agent", "registry/task:pinned"), True),
                               (environment("verifier"), False)):
                with self.assertRaises(RuntimeError):
                    await env.start(force)
        self.assertEqual(json.loads((self.root / "docker-images.json").read_text()),
                         ["agent-main:latest", "registry/task:pinned", "verifier-main:latest"])

    async def test_prune_skips_referenced_absent_and_check_failed_images(self):
        trial = self.root / "trial"
        trial.mkdir()
        (trial / "result.json").write_text("saved score")
        (trial / "docker-images.json").write_text(json.dumps(["in-use", "gone", "check-failed", "trial-tag"]))
        async def command(*args):
            if args[0] == "ps":
                return (1, "daemon error") if "ancestor=check-failed" in args else (0, "container" if "ancestor=in-use" in args else "")
            if args[:2] == ("image", "inspect"):
                return (1, "missing") if args[2] == "gone" else (0, "sha256:fixture")
            return 0, "reclaimed"
        docker = AsyncMock(side_effect=command)
        event = SimpleNamespace(trial_id="trial", config=SimpleNamespace(trials_dir=self.root, trial_name="trial"))
        with patch("paper_cleanup.docker_command", docker):
            await paper_cleanup.prune_trial_docker_cache(event)
        removals = [call.args for call in docker.call_args_list if call.args[:2] == ("image", "rm")]
        self.assertEqual(removals, [("image", "rm", "trial-tag")])
        self.assertEqual(docker.call_args_list[-1].args, ("builder", "prune", "--all", "--force"))
        self.assertEqual((trial / "result.json").read_text(), "saved score")
        self.assertEqual(json.loads((trial / "docker-cleanup.json").read_text())["build_cache"]["exit_code"], 0)

    async def test_pruning_failure_preserves_saved_result(self):
        (self.root / "result.json").write_text("saved score")
        event = SimpleNamespace(trial_id="trial", config=SimpleNamespace(trials_dir=self.root.parent, trial_name=self.root.name))
        with patch("paper_cleanup.docker_command", AsyncMock(side_effect=OSError("Docker unavailable"))):
            await paper_cleanup.prune_trial_docker_cache(event)
        self.assertEqual((self.root / "result.json").read_text(), "saved score")
        self.assertEqual(json.loads((self.root / "docker-cleanup.json").read_text())["error"], "Docker unavailable")


if __name__ == "__main__":
    unittest.main()
