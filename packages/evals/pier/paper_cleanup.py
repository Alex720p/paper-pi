"""Reclaim recorded task images and unused build cache only after trial finalization."""

import asyncio
import json
import logging

logger = logging.getLogger(__name__)


async def docker_command(*args):
    process = await asyncio.create_subprocess_exec(
        "docker", *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=300)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    return process.returncode, output.decode(errors="replace")


async def prune_trial_docker_cache(event):
    # Pier awaits END after stopping verification and persisting result.json,
    # before releasing the queue's trial slot. Pruning requires a serial job.
    trial_dir = event.config.trials_dir / event.config.trial_name
    report = {"images": [], "build_cache": None}
    try:
        path = trial_dir / "docker-images.json"
        images = json.loads(path.read_text()) if path.exists() else []
        for image in images:
            code, output = await docker_command(
                "ps", "--all", "--filter", f"ancestor={image}", "--format", "{{.ID}}")
            if code or output.strip():
                report["images"].append({"image": image, "status": "in-use-or-check-failed"})
                continue
            code, _ = await docker_command("image", "inspect", image, "--format", "{{.Id}}")
            if code:
                report["images"].append({"image": image, "status": "already-absent"})
                continue
            code, output = await docker_command("image", "rm", image)
            report["images"].append({"image": image, "exit_code": code, "output": output})
            if code:
                logger.warning("Image cleanup failed for %s: %s", image, output.strip())
        code, output = await docker_command("builder", "prune", "--all", "--force")
        report["build_cache"] = {"exit_code": code, "output": output}
        if code:
            logger.warning("Build-cache cleanup failed: %s", output.strip())
    except Exception as error:
        report["error"] = str(error)
        logger.warning("Docker cleanup failed for %s: %s", event.trial_id, error)
    finally:
        try:
            (trial_dir / "docker-cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
        except OSError as error:
            logger.warning("Could not save cleanup report for %s: %s", event.trial_id, error)
