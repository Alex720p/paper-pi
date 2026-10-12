"""Record trial images before Pier builds either the agent or verifier environment."""

import json

from pier.environments.agent_setup import EGRESS_PROXY_SERVICE
from pier.environments.docker.docker import DockerEnvironment, _sanitize_docker_compose_project_name


class PaperDockerEnvironment(DockerEnvironment):
    def __init__(self, *args, prune_docker_cache=False, **kwargs):
        self.prune_docker_cache = prune_docker_cache
        super().__init__(*args, **kwargs)

    async def start(self, force_build):
        if self.prune_docker_cache:
            project = _sanitize_docker_compose_project_name(self.session_id)
            prebuilt = self.task_env_config.docker_image
            images = {prebuilt} if prebuilt else set()
            if force_build or not prebuilt or self.agent_install_spec is not None:
                images.add(f"{project}-main:latest")
            if self.network_allowlist.domains:
                images.add(f"{project}-{EGRESS_PROXY_SERVICE}:latest")
            path = self.trial_paths.trial_dir / "docker-images.json"
            recorded = set(json.loads(path.read_text())) if path.exists() else set()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(sorted(recorded | images), indent=2) + "\n")
        await super().start(force_build=force_build)
