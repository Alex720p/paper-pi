"""Legacy TOML/CLI compatibility and host-only model configuration."""

import io
import json
import os
import random
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from pier.models.agent.context import AgentContext

from paper_agent import PaperAgent
from paper_config import Config, ModelConfig, RunConfig
from paper_deepswe import build_job_config, execute, inference_lock, parser, select_tasks, summarize
from paper_job import launch
from paper_recovery import run_job


class PaperConfigTests(unittest.TestCase):
    def test_legacy_model_settings_are_forwarded_without_added_compatibility_options(self):
        raw = tomllib.loads((Path(__file__).parent / "config.example.toml").read_text())["model"]
        model = ModelConfig.model_validate(raw)
        provider = model.pi_models()["providers"]["benchmark"]
        selected = provider["models"][0]
        self.assertEqual(provider["baseUrl"], raw["base_url"].rstrip("/"))
        self.assertEqual(provider["apiKey"], "${MODEL_API_KEY}")
        self.assertEqual(selected["contextWindow"], 400000)
        self.assertEqual(selected["maxTokens"], 131072)
        self.assertEqual(selected["thinkingLevelMap"], raw["thinking_level_map"])
        self.assertEqual(selected["samplingParams"], raw["sampling"])
        self.assertEqual(selected["compat"], raw["compat"])
        self.assertEqual(model.thinking, "max")

    def test_host_localhost_is_not_rewritten_for_docker(self):
        model = ModelConfig(base_url="http://localhost:8080/v1/", model_id="local/model")
        self.assertEqual(model.pi_models()["providers"]["benchmark"]["baseUrl"], "http://localhost:8080/v1")
        self.assertEqual(model.identity, "benchmark/local/model")

    def test_parallelism_and_invalid_generation_settings_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "concurrency=1"):
            RunConfig(concurrency=2)
        for options in ({"max_tokens": 32768}, {"thinking": "high"},
                        {"reasoning": True, "thinking": "max"},
                        {"reasoning": True, "thinking": "high", "thinking_level_map": {"high": None}},
                        {"api_key_env": "actual secret"}, {"base_url": "https://user:secret@example.com/v1"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                ModelConfig.model_validate({"base_url": "http://localhost:8080/v1", "model_id": "fixture", **options})


class PaperDeepSweTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.tasks = self.root / "tasks"
        self.tasks.mkdir()
        for name in ("z-task", "abs-module-cache-flags", "b-task"):
            task = self.tasks / name
            task.mkdir()
            (task / "task.toml").touch()
        self.config = Config(model=ModelConfig(base_url="http://localhost:8080/v1", model_id="fixture"),
                             run=RunConfig(tasks_dir=self.tasks, jobs_dir=self.root / "jobs"))

    def test_sampling_matches_sorted_then_seeded_legacy_selection(self):
        expected = sorted(self.tasks.iterdir())
        random.Random(42).shuffle(expected)
        actual = select_tasks(self.tasks, task=None, n_tasks=2, seed=42)
        self.assertEqual(actual, expected[:2])
        self.assertEqual(select_tasks(self.tasks, task=None, n_tasks=None, seed=99), sorted(self.tasks.iterdir()))
        for task, count in (("../../etc", None), (None, 0), (None, 4)):
            with self.subTest(task=task, count=count), self.assertRaises(ValueError):
                select_tasks(self.tasks, task=task, n_tasks=count, seed=0)

    def test_inference_lock_rejects_another_job_and_releases_after_failure(self):
        checkout = self.root / "paper-pi"
        with self.assertRaises(RuntimeError):
            with inference_lock(checkout):
                with self.assertRaisesRegex(ValueError, "Another zones benchmark"):
                    with inference_lock(checkout):
                        self.fail("Second inference process acquired the lock")
                raise RuntimeError("interrupted")
        with inference_lock(checkout):
            pass

    async def test_legacy_run_command_builds_serial_job_without_budget_overrides(self):
        args = parser().parse_args(["run", "--config", "config.local.toml", "--all", "--prune-docker-cache"])
        launched = AsyncMock(return_value=75)
        with patch("paper_deepswe.Config.load", return_value=self.config), \
             patch("paper_deepswe.prepare_runtime"), patch("paper_deepswe.check_prerequisites", AsyncMock()), \
             patch("paper_deepswe.inference_lock", side_effect=lambda: inference_lock(self.root / "paper-pi")), \
             patch("paper_deepswe.provenance", return_value={"fixture": True}), \
             patch("paper_deepswe.launch", launched), redirect_stdout(io.StringIO()):
            self.assertEqual(await execute(args), 75)
        saved = launched.call_args.args[0]
        self.assertEqual([task.path for task in saved.tasks], sorted(self.tasks.iterdir()))
        self.assertEqual(saved.n_concurrent_trials, 1)
        self.assertEqual(saved.n_attempts, 1)
        self.assertEqual(saved.retry.max_retries, 0)
        self.assertIsNone(saved.agent_timeout_multiplier)
        self.assertIsNone(saved.environment.override_memory_mb)
        self.assertTrue(saved.environment.kwargs["prune_docker_cache"])
        self.assertEqual(saved.agents[0].kwargs["model_config"], self.config.model.model_dump(mode="json"))

    async def test_default_check_selects_only_smoke_task_and_does_not_launch(self):
        checked = AsyncMock()
        launched = AsyncMock()
        with patch("paper_deepswe.Config.load", return_value=self.config), patch("paper_deepswe.prepare_runtime"), \
             patch("paper_deepswe.check_prerequisites", checked), patch("paper_deepswe.launch", launched), \
             redirect_stdout(io.StringIO()):
            self.assertEqual(await execute(parser().parse_args(["check", "--config", "fixture.toml"])), 0)
        self.assertEqual([t.path.name for t in checked.call_args.args[1].tasks], ["abs-module-cache-flags"])
        launched.assert_not_awaited()

    async def test_resume_uses_saved_model_settings_without_original_toml(self):
        saved = build_job_config(self.config, [self.tasks / "b-task"], "fixture")
        job_dir = saved.jobs_dir / saved.job_name
        job_dir.mkdir(parents=True)
        (job_dir / "config.json").write_text(saved.model_dump_json())
        resumed = AsyncMock(return_value=0)
        with patch("paper_deepswe.prepare_runtime"), patch("paper_deepswe.check_runtime"), \
             patch("paper_deepswe.Config.load", side_effect=AssertionError("Must not read changed TOML")), \
             patch("paper_deepswe.inference_lock", side_effect=lambda: inference_lock(self.root / "paper-pi")), \
             patch("paper_deepswe.resume", resumed), redirect_stdout(io.StringIO()):
            self.assertEqual(await execute(parser().parse_args(["resume", str(job_dir)])), 0)
        resumed.assert_awaited_once_with(job_dir)
        saved.n_concurrent_trials = 2
        (job_dir / "config.json").write_text(saved.model_dump_json())
        with patch("paper_deepswe.prepare_runtime"), self.assertRaisesRegex(ValueError, "concurrency=1"):
            await execute(parser().parse_args(["resume", str(job_dir)]))

    async def test_provenance_is_saved_before_job_creation(self):
        config = build_job_config(self.config, [self.tasks / "b-task"], "fixture")
        async def create(saved):
            self.assertEqual(json.loads((saved.jobs_dir / saved.job_name / "pi-deepswe-provenance.json").read_text()),
                             {"model": "fixture", "tasks": ["b-task"]})
            return Mock()
        with patch("paper_job.Job.create", AsyncMock(side_effect=create)), \
             patch("paper_job.run_job", AsyncMock(return_value=75)):
            self.assertEqual(await launch(config, provenance={"model": "fixture", "tasks": ["b-task"]}), 75)

    def test_summary_distinguishes_graded_zero_and_timeout_from_infrastructure_failures(self):
        for name, reward, error, disconnected in (
            ("zero", 0, None, False), ("timeout", 0, "AgentTimeoutError", False),
            ("agent-error", 1, "NonZeroAgentExitCodeError", False),
            ("setup-error", None, "RuntimeError", False), ("disconnect", 1, None, True),
            ("cleanup-error", 1, "RuntimeError", False),
        ):
            trial = self.root / name
            trial.mkdir()
            (trial / "result.json").write_text(json.dumps({
                "task_name": name, "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
                "exception_info": {"exception_type": error} if error else None,
                "agent_result": {"metadata": {"paper": {"inferenceUnavailable": disconnected}}},
            }))
        result = summarize(self.root)
        self.assertEqual(result["verified_trials"], 3)
        self.assertEqual(result["infrastructure_errors"], 3)

    def test_summary_selects_first_valid_grade_across_archived_and_current_attempts(self):
        for name, task, reward, error, started in (
            (".interrupted/disconnected", "retry", 1, "InferenceUnavailableError", "2026-10-12T09:00:00Z"),
            ("completed", "retry", 0, None, "2026-10-12T10:00:00Z"),
            ("later-pass", "retry", 1, None, "2026-10-12T11:00:00Z"),
            (".interrupted/first-zero", "zero", 0, None, "2026-10-12T09:00:00Z"),
            ("second-pass", "zero", 1, None, "2026-10-12T10:00:00Z"),
            (".interrupted/setup", "unresolved", None, "AbsoluteLinkError", "2026-10-12T09:00:00Z"),
        ):
            trial = self.root / name
            trial.mkdir(parents=True)
            (trial / "result.json").write_text(json.dumps({
                "task_name": task, "started_at": started,
                "exception_info": {"exception_type": error} if error else None,
                "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
            }))
        summary = summarize(self.root)
        selected = {trial["task"]: trial for trial in summary["trials"]}
        self.assertEqual(selected["retry"]["rewards"]["reward"], 0)
        self.assertEqual(selected["zero"]["rewards"]["reward"], 0)
        self.assertTrue(selected["unresolved"]["infrastructure_error"])
        self.assertEqual(summary["verified_trials"], 2)
        self.assertEqual(summary["infrastructure_errors"], 1)
        self.assertEqual(summary["infrastructure_attempts"], 2)
        self.assertEqual(len(summary["attempts"]), 6)

    async def test_pause_prints_the_same_console_resume_interface(self):
        callbacks = []
        config = build_job_config(self.config, [self.tasks / "b-task"], "fixture")
        async def run():
            event = SimpleNamespace(result=SimpleNamespace(agent_result=None,
                                    exception_info=SimpleNamespace(exception_type="InferenceUnavailableError")))
            await callbacks[0](event)
        job = SimpleNamespace(config=config, job_dir=self.root, add_hook=Mock(), on_trial_ended=callbacks.append, run=run)
        output = io.StringIO()
        with redirect_stderr(output):
            self.assertEqual(await run_job(job, prune=False), 75)
        self.assertIn(str(Path(sys.executable).parent / "paper-deepswe") + " resume", output.getvalue())
        self.assertNotIn("-m paper_job", output.getvalue())

    async def test_adapter_generates_private_host_model_config_without_mounting_credentials(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        model = Config.load(Path(__file__).parent / "config.example.toml").model
        agent = PaperAgent(logs_dir=root / "logs", model_name=model.identity, model_config=model.model_dump())
        agent._temporary = temporary
        agent._workspace = root / "workspace"
        agent._workspace.mkdir()
        agent._image = "fixture"
        agent._submit = AsyncMock()
        environment = SimpleNamespace(environment_dir=root / "task/environment", task_env_config=SimpleNamespace(
            env={}, memory_mb=8192, cpus=2, allow_internet=False, storage_mb=20480))
        async def command(argv, **kwargs):
            if argv[0] == "node":
                supplied = json.loads(Path(argv[-1]).read_text())
                self.assertEqual(supplied["env"], {})
                self.assertEqual(supplied["thinkingLevel"], "max")
                self.assertEqual(supplied["maxOutputTokens"], 131072)
                self.assertEqual(json.loads(Path(supplied["authPath"]).read_text()), {})
                catalog = Path(supplied["modelsPath"]).read_text()
                self.assertIn("${MODEL_API_KEY}", catalog)
                self.assertNotIn("test-secret-value", catalog)
                self.assertEqual(json.loads(catalog), model.pi_models())
                self.assertEqual(kwargs["env"]["MODEL_API_KEY"], "test-secret-value")
                kwargs["on_start"](12345)
                (agent.logs_dir / "paper-result.json").write_text('{"status":"completed","submissionReady":true}')
            return ""
        with patch.dict(os.environ, {"MODEL_API_KEY": "test-secret-value"}), \
             patch("paper_agent.host_command", command), patch("paper_agent.cleanup_runner_resources", AsyncMock()):
            await agent._run_trial("fixture task", environment, AgentContext())
        agent._submit.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
