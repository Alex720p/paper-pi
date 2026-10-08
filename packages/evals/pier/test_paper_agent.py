"""Deterministic Pier trial: real zones, staged submission, and a separate verifier."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


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

    def _fixture(self, timeout=False, agent_error=False, extended_deadline=False):
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


if __name__ == "__main__":
    unittest.main()
