"""Deterministic Pier trial: real zones, staged submission, and a separate verifier."""
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from pier.models.job.config import JobConfig
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig
from paper_agent import InferenceUnavailableError, PaperAgent
from paper_config import Config, ModelConfig, RunConfig
from paper_deepswe import build_job_config
import paper_cleanup
from paper_job import launch, resume
from paper_recovery import is_infrastructure_failure, job_lock


class PaperPierIntegration(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_staged_submission_and_private_shell_changes(self):
        self._fixture()

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_toml_model_config_runs_through_real_docker_zones(self):
        self._fixture(toml=True)

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_legacy_console_command_forwards_toml_settings_to_mock_inference(self):
        self._fixture(mock_inference=True)

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

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_ctrl_c_during_inference_finalizes_and_does_not_start_next_task(self):
        self._fixture(interrupt="inference")

    @unittest.skipUnless(os.environ.get("PAPER_PIER_INTEGRATION") == "1", "requires Docker")
    def test_ctrl_c_during_bash_finalizes_and_does_not_start_next_task(self):
        self._fixture(interrupt="bash")

    def _fixture(self, timeout=False, agent_error=False, extended_deadline=False, recovery=False,
                 toml=False, mock_inference=False, interrupt=None):
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
                "ln -s /dev/null null-fixture && git init -q && git add answer.txt obsolete.txt .pi/paper.json null-fixture && "
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
                'test "$(readlink null-fixture)" = /dev/null\n'
                'mkdir -p /logs/verifier\nprintf \'{"reward": 1}\\n\' > /logs/verifier/reward.json\n'
            )
            steps = [
                {"name": "bash", "arguments": {"command": "test \"$(readlink null-fixture)\" = /dev/null && echo shell > answer.txt; echo private > private.txt"}},
                {"name": "write", "arguments": {"path": "/app/answer.txt", "content": "staged\n"}},
                {"name": "delete_file", "arguments": {"path": "/app/obsolete.txt"}},
                {"name": "bash", "arguments": {"command": "test \"$(cat answer.txt)\" = shell; test -e private.txt; test ! -e obsolete.txt"}},
                {"name": "read", "arguments": {"path": "/app/answer.txt"}},
            ]
            if timeout:
                steps[3]["arguments"]["command"] += "; sleep 60"
            if extended_deadline:
                steps[3]["arguments"]["command"] += "; sleep 4"
            if interrupt == "bash":
                steps[3]["arguments"]["command"] += "; sleep 60"
            if agent_error:
                steps.append({"name": "read", "arguments": {"path": "/app/missing.txt"}})
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).parent)
            env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
            if recovery:
                self._recovery_fixture(root, task, image, steps)
                return
            if interrupt:
                shutil.copytree(task, root / "task-z")
                self._mock_inference_fixture(root, steps, env, interrupt=interrupt)
                return
            if mock_inference:
                self._mock_inference_fixture(root, [
                    {"name": "write", "arguments": {"path": "/app/.git/HEAD", "content": "ref: refs/heads/task\n"}},
                    *steps,
                ], env)
                diagnostics = "Legacy CLI + mock OpenAI-compatible server"
                results = list((root / "jobs").glob("*/*/result.json"))
                self.assertEqual(len(results), 1)
                self.assertTrue((results[0].parent.parent / "pi-deepswe-provenance.json").is_file())
            elif toml:
                config = Config(model=ModelConfig(base_url="http://localhost:1/v1", model_id="fixture", max_tokens=8192),
                                run=RunConfig(tasks_dir=root, jobs_dir=root / "jobs"))
                job = build_job_config(config, [task], "fixture")
                job.agents[0].kwargs["fake_steps"] = steps
                with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}):
                    self.assertEqual(asyncio.run(launch(job, provenance={"deterministic": True})), 0)
                diagnostics = "TOML configuration fixture"
                self.assertTrue((root / "jobs/fixture/pi-deepswe-provenance.json").is_file())
            else:
                completed = subprocess.run([
                    "pier", "run", "-p", task, "--agent-import-path", "paper_agent:PaperAgent",
                    "--model", "faux/faux-1", "--ak", "fake_steps="+json.dumps(steps),
                    "--ak", "max_output_tokens=8192",
                    "--env", "docker", "--n-concurrent", "1", "--jobs-dir", root / "jobs",
                    "--job-name", "fixture", "--max-retries", "0",
                    *(["--agent-timeout-multiplier", str(10/120)] if timeout else []),
                    *(["--agent-timeout-multiplier", "10"] if extended_deadline else []),
                ], env=env, capture_output=True, text=True, timeout=180)
                diagnostics = completed.stdout + completed.stderr
            if not mock_inference:
                results = list((root / "jobs").glob("fixture/*/result.json"))
            self.assertEqual(len(results), 1, diagnostics)
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
            exported = json.loads((results[0].parent / "agent/source-export.json").read_text())
            self.assertIn({"path": "null-fixture", "target": "/dev/null", "type": "symlink"}, exported["skipped_links"])
            patch_path = results[0].parent / "agent/model.patch"
            self.assertNotIn("private.txt", patch_path.read_text())
            self.assertNotIn("null-fixture", patch_path.read_text())
            self.assertNotIn("diff --git a/.git/", patch_path.read_text())
            self.assertIn("+staged", patch_path.read_text())
            self.assertIn("deleted file mode", patch_path.read_text())
            self.assertIn("obsolete.txt", patch_path.read_text())
            paper = json.loads((results[0].parent / "agent/paper-result.json").read_text())
            self.assertTrue(paper["submissionReady"])
            if agent_error:
                self.assertEqual(paper["failureKind"], "agent")
            self.assertEqual(paper["generation"],
                             {"thinkingLevel": "max", "maxOutputTokens": 131072} if mock_inference else
                             {"thinkingLevel": "off", "maxOutputTokens": 8192})
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

    def _mock_inference_fixture(self, root, steps, env, interrupt=None):
        requests = []
        failures = []
        active = 0
        maximum_active = 0
        guard = threading.Lock()
        inference_waiting = threading.Event()
        release = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"object":"list","data":[{"id":"fixture","object":"model"}]}')

            def do_POST(self):
                nonlocal active, maximum_active
                with guard:
                    active += 1
                    maximum_active = max(maximum_active, active)
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    index = len(requests)
                    requests.append({"body": body, "authorization": self.headers.get("Authorization"),
                                     "path": self.path})
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if interrupt == "inference" and index == len(steps):
                        self.wfile.write(b'data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Waiting"},"finish_reason":null}]}\n\n')
                        self.wfile.flush()
                        inference_waiting.set()
                        release.wait(45)
                        return
                    if index < len(steps):
                        step = steps[index]
                        delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{index}",
                                 "type": "function", "function": {"name": step["name"],
                                 "arguments": json.dumps(step["arguments"])}}]}
                        reason = "tool_calls"
                    else:
                        delta = {"role": "assistant", "content": "Infrastructure validation complete."}
                        reason = "stop"
                    for payload in (
                        {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                        {"choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
                         "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
                    ):
                        chunk = {"id": f"chatcmpl-{index}", "object": "chat.completion.chunk", "created": 1,
                                 "model": "fixture", **payload}
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    failures.append(str(error))
                finally:
                    with guard:
                        active -= 1

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = root / "config.toml"
        config.write_text(
            '[model]\nbase_url = "http://127.0.0.1:'+str(server.server_port)+'/v1"\n'
            'model_id = "fixture"\napi_key_env = "PAPER_FIXTURE_API_KEY"\n'
            'context_window = 400000\nmax_tokens = 131072\nreasoning = true\nthinking = "max"\n'
            '[model.thinking_level_map]\nlow = "low"\nhigh = "high"\nmax = "max"\n'
            '[model.sampling]\ntemperature = 0.95\ntop_p = 1.0\n'
            '[model.compat]\nsupportsDeveloperRole = false\nmaxTokensField = "max_tokens"\n'
            '[run]\ntasks_dir = "'+str(root)+'"\njobs_dir = "'+str(root / "jobs")+'"\nconcurrency = 1\n'
        )
        pi_root = Path(__file__).resolve().parents[3]
        process = None
        try:
            command = [pi_root / ".venv/bin/pi-deepswe", "run", "--config", config, "--all"]
            supplied_env = {**env, "PAPER_FIXTURE_API_KEY": "fixture-key"}
            if interrupt:
                process = subprocess.Popen(command, cwd=pi_root, env=supplied_env, start_new_session=True,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                deadline = time.monotonic() + 90
                ready = False
                while process.poll() is None and time.monotonic() < deadline:
                    outputs = list((root / "jobs").glob("*/*/agent/runner-stdout.txt"))
                    ready = inference_waiting.is_set() if interrupt == "inference" else any(
                        'Tool start: bash' in output.read_text() and 'sleep 60' in output.read_text() for output in outputs)
                    if ready:
                        break
                    time.sleep(0.05)
                self.assertTrue(ready, "Runner did not reach interruption point")
                os.killpg(process.pid, signal.SIGINT)
                stdout, stderr = process.communicate(timeout=45)
                self.assertEqual(process.returncode, 130, stdout + stderr)
                results = list((root / "jobs").glob("*/*/result.json"))
                self.assertEqual(len(results), 1, stdout + stderr)
                result = json.loads(results[0].read_text())
                self.assertTrue(is_infrastructure_failure(result, results[0].parent))
                paper = json.loads((results[0].parent / "agent/paper-result.json").read_text())
                self.assertTrue(paper["submissionReady"])
                self.assertFalse(json.loads((results[0].parent / "agent/runner-process.json").read_text())["forcedKill"])
                self.assertIn("+staged", (results[0].parent / "agent/model.patch").read_text())
                self.assertEqual(json.loads((results[0].parent.parent / "run-state.json").read_text())["status"], "stopped")
                with job_lock(results[0].parent.parent):
                    pass
                for resource in ("ps", "volume"):
                    args = ["docker", "ps", "-aq"] if resource == "ps" else ["docker", "volume", "ls", "-q"]
                    remaining = subprocess.run([*args, "--filter", "label=paper-api.managed=true", "--filter",
                                                f"label=paper-api.owner-pid={paper['processId']}"],
                                               check=True, capture_output=True, text=True)
                    self.assertFalse(remaining.stdout.strip(), "Interrupted runner leaked resources")
                return
            completed = subprocess.run(command, cwd=pi_root, env=supplied_env,
                                       capture_output=True, text=True, timeout=180)
        finally:
            release.set()
            if process is not None and process.poll() is None:
                process.send_signal(signal.SIGINT)
                process.communicate(timeout=45)
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(failures, [])
        self.assertEqual(len(requests), len(steps) + 1)
        self.assertEqual(maximum_active, 1)
        if steps[0]["arguments"].get("path") == "/app/.git/HEAD":
            self.assertTrue(any(message.get("role") == "tool" and "Git metadata" in message.get("content", "")
                                for message in requests[1]["body"]["messages"]))
        for request in requests:
            self.assertEqual(request["path"], "/v1/chat/completions")
            self.assertEqual(request["authorization"], "Bearer fixture-key")
            payload = request["body"]
            self.assertEqual(payload["model"], "fixture")
            self.assertEqual(payload["max_tokens"], 131072)
            self.assertEqual(payload["reasoning_effort"], "max")
            self.assertEqual(payload["temperature"], 0.95)
            self.assertEqual(payload["top_p"], 1.0)
            self.assertFalse(any(message["role"] == "developer" for message in payload["messages"]))
            self.assertNotIn("chat_template_kwargs", payload)

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
