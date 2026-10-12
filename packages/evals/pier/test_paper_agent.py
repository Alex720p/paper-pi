"""Deterministic Pier trial: real zones, staged submission, and a separate verifier."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

from pier.models.job.config import JobConfig
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig
from paper_agent import InferenceUnavailableError, PaperAgent
import paper_cleanup
from paper_job import launch, resume


class PaperPierIntegration(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_staged_submission_and_private_shell_changes(self):
        self._fixture()

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_timeout_submits_staged_changes_and_cleans_zones(self):
        self._fixture(timeout=True)

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_agent_failure_still_verifies_staged_changes(self):
        self._fixture(agent_error=True)

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_pier_deadline_multiplier_can_extend_the_task_deadline(self):
        self._fixture(extended_deadline=True)

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_disconnect_resume_preserves_completed_tasks_and_prunes_after_verification(self):
        self._fixture(recovery=True)

    def _fixture(self, timeout=False, agent_error=False, extended_deadline=False, recovery=False):
        with tempfile.TemporaryDirectory(prefix="paper-pier-fixture-") as directory:
            root = Path(directory)
            task = root / "task"
            (task / "environment").mkdir(parents=True)
            (task / "tests").mkdir()
            base = os.environ.get("PAPER_PIER_TEST_BASE", "python:3.12-slim")
            image = f"paper-pier-regression:{os.getpid()}"
            install = "RUN apt-get update && apt-get install -y --no-install-recommends git procps && rm -rf /var/lib/apt/lists/*\n" if base == "python:3.12-slim" else ""
            (task / "environment/Dockerfile").write_text(
                f"FROM {base}\n{install}WORKDIR /app\n"
                "RUN rm -rf .git && echo base > answer.txt && echo remove > obsolete.txt && mkdir -p .pi && "
                "echo '{\"zone\":{\"backend\":\"nix\"},\"runtime\":\"missing-runtime\"}' > .pi/paper.json && "
                "git init -q && git add answer.txt obsolete.txt .pi/paper.json && "
                "git -c user.name=fixture -c user.email=fixture@localhost commit -qm base && git tag fixture-base\n"
            )
            subprocess.run(["docker", "build", "-t", image, task / "environment"], check=True, capture_output=True)
            self.addCleanup(lambda: subprocess.run(["docker", "image", "rm", image], capture_output=True))
            (task / "instruction.md").write_text("Replace answer.txt with staged, using write. Shell edits must stay private.")
            (task / "tests/Dockerfile").write_text(f"FROM {image}\nCOPY test.sh /tests/test.sh\nRUN chmod +x /tests/test.sh\n")
            (task / "task.toml").write_text(
                'schema_version = "1.3"\nartifacts = ["/logs/artifacts/model.patch"]\n'
                '[agent]\nnetwork_mode = "no-network"\ntimeout_sec = '+str(3 if extended_deadline else 120)+'\n'
                '[environment]\ndocker_image = "'+image+'"\ncpus = 1\nmemory_mb = 1024\n'
                '[verifier]\nenvironment_mode = "separate"\nnetwork_mode = "no-network"\ntimeout_sec = 30\n'
                '[verifier.environment]\ncpus = 1\nmemory_mb = 1024\n'
                '[[verifier.collect]]\ncommand = "cd /app && mkdir -p /logs/artifacts && git diff --binary fixture-base HEAD > /logs/artifacts/model.patch"\n'
            )
            (task / "tests/test.sh").write_text(
                '#!/bin/bash\nset -eu\ncd /app\n'
                'git apply --binary /logs/artifacts/model.patch\n'
                'test "$(cat answer.txt)" = staged\n'
                'test ! -e private.txt\n'
                'test ! -e obsolete.txt\n'
                'mkdir -p /logs/verifier\nprintf \'{"reward": 1}\\n\' > /logs/verifier/reward.json\n'
            )
            steps = [
                {"name": "bash", "arguments": {"command": "echo shell > answer.txt; echo private > private.txt"}},
                {"name": "write", "arguments": {"path": "/app/answer.txt", "content": "staged\n"}},
                {"name": "delete_file", "arguments": {"path": "/app/obsolete.txt"}},
                {"name": "bash", "arguments": {"command": "test \"$(cat answer.txt)\" = shell; test -e private.txt; test ! -e obsolete.txt"}},
                {"name": "read", "arguments": {"path": "/app/answer.txt"}},
            ]
            if timeout:
                steps[3]["arguments"]["command"] += "; sleep 60"
            if extended_deadline:
                steps[3]["arguments"]["command"] += "; sleep 4"
            if agent_error:
                steps.append({"name": "read", "arguments": {"path": "/app/missing.txt"}})
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).parent)
            env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
            if recovery:
                self._recovery_fixture(root, task, image, steps)
                return
            completed = subprocess.run([
                "pier", "run", "-p", task, "--agent-import-path", "paper_agent:PaperAgent",
                "--model", "faux/faux-1", "--ak", "fake_steps="+json.dumps(steps),
                "--ak", "max_output_tokens=8192",
                "--env", "docker", "--n-concurrent", "1", "--jobs-dir", root / "jobs",
                "--job-name", "fixture", "--max-retries", "0",
                *(["--agent-timeout-multiplier", str(10/120)] if timeout else []),
                *(["--agent-timeout-multiplier", "10"] if extended_deadline else []),
            ], env=env, capture_output=True, text=True, timeout=180)
            results = list((root / "jobs").glob("fixture/*/result.json"))
            self.assertEqual(len(results), 1, completed.stdout + completed.stderr)
            result = json.loads(results[0].read_text())
            verifier_output = results[0].parent / "verifier/test-stdout.txt"
            diagnostics = verifier_output.read_text() if verifier_output.exists() else ""
            if timeout:
                self.assertIn(result["exception_info"]["exception_type"], ("AgentTimeoutError", "TimeoutError"), diagnostics + json.dumps(result, indent=2))
            elif agent_error:
                self.assertEqual(result["exception_info"]["exception_type"], "NonZeroAgentExitCodeError", json.dumps(result, indent=2))
            else:
                self.assertIsNone(result.get("exception_info"), diagnostics + json.dumps(result, indent=2))
            self.assertEqual(result["verifier_result"]["rewards"]["reward"], 1)
            patch = results[0].parent / "agent/model.patch"
            self.assertNotIn("private.txt", patch.read_text())
            self.assertIn("+staged", patch.read_text())
            self.assertIn("deleted file mode", patch.read_text())
            self.assertIn("obsolete.txt", patch.read_text())
            paper = json.loads((results[0].parent / "agent/paper-result.json").read_text())
            self.assertTrue(paper["submissionReady"])
            if agent_error:
                self.assertEqual(paper["failureKind"], "agent")
            self.assertEqual(paper["generation"], {"thinkingLevel": "off", "maxOutputTokens": 8192})
            transcripts = list((results[0].parent / "agent/transcripts").glob("*.jsonl"))
            self.assertEqual(len(transcripts), 1)
            transcript = [json.loads(line) for line in transcripts[0].read_text().splitlines()]
            self.assertTrue(any(event.get("type") == "tool_call" and event.get("name") == "write" for event in transcript))
            self.assertTrue(any(event.get("type") == "tool_result" and "Exec changes are private and are never submitted" in json.dumps(event) for event in transcript))
            live_output = (results[0].parent / "agent/runner-stdout.txt").read_text()
            self.assertIn("Sending task prompt", live_output)
            self.assertIn("Tool start: write", live_output)
            self.assertIn("Tool end: write; isError=false", live_output)
            if not timeout and not agent_error:
                self.assertIn("Infrastructure validation complete.", live_output)
                self.assertIn("Trial ended: completed", live_output)
            filters = ["--filter", "label=paper-api.managed=true", "--filter", f"label=paper-api.owner-pid={paper['processId']}"]
            remaining = subprocess.run(["docker", "ps", "-aq", *filters], check=True, capture_output=True, text=True)
            self.assertFalse(remaining.stdout.strip(), "paper containers leaked")
            remaining = subprocess.run(["docker", "volume", "ls", "-q", *filters], check=True, capture_output=True, text=True)
            self.assertFalse(remaining.stdout.strip(), "private exec volume leaked")
            print(f"Pier fixture (timeout={timeout}, agent_error={agent_error}, extended_deadline={extended_deadline}): staged patch graded 1; shell edits excluded; zones cleaned.")

    def _recovery_fixture(self, root, task, image, steps):
        # Provider disconnect is injected after a real staged submission. No paid
        # inference and no builder-wide cache mutation are needed for this test.
        tasks = []
        images = []
        for index in range(3):
            selected = root / f"task-{index}"
            shutil.copytree(task, selected)
            tag = f"{image}-task-{index}"
            subprocess.run(["docker", "tag", image, tag], check=True)
            images.append(tag)
            for path in (selected / "task.toml", selected / "tests/Dockerfile"):
                path.write_text(path.read_text().replace(image, tag))
            tasks.append(TaskConfig(path=selected))
            self.addCleanup(lambda tag=tag: subprocess.run(["docker", "image", "rm", tag], capture_output=True))
        config = JobConfig(
            jobs_dir=root / "jobs", job_name="recovery", n_concurrent_trials=1, tasks=tasks,
            agents=[AgentConfig(import_path="paper_agent:PaperAgent", model_name="faux/faux-1",
                                kwargs={"fake_steps": steps})],
            environment=EnvironmentConfig(import_path="paper_environment:PaperDockerEnvironment",
                                          kwargs={"prune_docker_cache": True}),
        )
        original_run = PaperAgent.run
        original_command = paper_cleanup.docker_command
        builder_calls = []

        async def disconnect(agent, instruction, environment, context):
            await original_run(agent, instruction, environment, context)
            if environment.environment_dir.parent.name == "task-1":
                context.metadata["paper"]["inferenceUnavailable"] = True
                result = agent.logs_dir / "paper-result.json"
                result.write_text(json.dumps(context.metadata["paper"]))
                raise InferenceUnavailableError("Injected VPN expiry")

        async def docker(*args):
            if args[:2] == ("builder", "prune"):
                builder_calls.append(args)
                return 0, "builder prune mocked in integration test"
            return await original_command(*args)

        async def exercise():
            with patch.object(PaperAgent, "run", disconnect):
                self.assertEqual(await launch(config), 75)
            job_dir = config.jobs_dir / config.job_name
            results = sorted(job_dir.glob("*/result.json"))
            self.assertEqual(len(results), 2)
            completed = next(path for path in results if json.loads(path.read_text())["exception_info"] is None)
            saved_completed = completed.read_bytes()
            interrupted = next(path for path in results if path != completed)
            self.assertEqual(json.loads(interrupted.read_text())["exception_info"]["exception_type"], "InferenceUnavailableError")
            self.assertTrue((interrupted.parent / "agent/model.patch").exists())
            self.assertEqual(len(builder_calls), 2)
            for path in results:
                self.assertEqual(json.loads(path.read_text())["verifier_result"]["rewards"]["reward"], 1)
                self.assertTrue((path.parent / "docker-cleanup.json").exists())
            # Recreate the interrupted fixture's pruned prebuilt tag, standing in
            # for pulling the benchmark's image from its registry on resume.
            subprocess.run(["docker", "tag", image, images[1]], check=True)
            self.assertEqual(await resume(job_dir), 0)
            self.assertEqual(completed.read_bytes(), saved_completed)
            current = list(job_dir.glob("*/result.json"))
            self.assertEqual(len(current), 3)
            self.assertEqual(len(builder_calls), 4)
            archived = list((job_dir / ".interrupted").glob("*/result.json"))
            self.assertEqual(len(archived), 1)
            self.assertTrue((archived[0].parent / "agent/model.patch").exists())
            self.assertEqual(json.loads((job_dir / "run-state.json").read_text())["status"], "finished")
            for path in current + archived:
                paper = json.loads((path.parent / "agent/paper-result.json").read_text())
                filters = ["--filter", "label=paper-api.managed=true", "--filter", f"label=paper-api.owner-pid={paper['processId']}"]
                for args in (["docker", "ps", "-aq", *filters], ["docker", "volume", "ls", "-q", *filters]):
                    output = subprocess.run(args, check=True, capture_output=True, text=True)
                    self.assertFalse(output.stdout.strip(), "paper resources leaked")
        with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}), patch("paper_cleanup.docker_command", docker):
            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
