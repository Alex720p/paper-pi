#!/usr/bin/env python3
"""Install the pinned host runtime and the paper-pi DeepSWE entry point."""

import base64
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

NODE_VERSION = "24.21.0"
UV_VERSION = "0.12.23"
PYTHON_VERSION = "3.12.15"
UV_URL = "https://files.pythonhosted.org/packages/e5/83/85a6c63c24905af4924fddb11a499b934913f59a134248367a1ef1a4716f/uv-0.12.23-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
UV_SHA256 = "565c6e2874dbeae86c02f3dea97255e878fec672659a73d4930c6b93fcab2fff"
PI_AI_VERSION = "0.83.0"
PI_AI_URL = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.83.0.tgz"
PI_AI_SHA512 = "m3IZD4g3er0V8TC9+Vpgw/sjTKqcJlkcIBy/JvsgRubuuik3tAVzyugUg4rVrShIkkOT69mEd34NEqKUIsl6JQ=="


def download(url):
    print(f"Downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def hydrate_models(root, tools, env):
    # Use the matching published data instead of regenerating from mutable live catalogs.
    package = root / "packages/ai"
    if json.loads((package / "package.json").read_text())["version"] != PI_AI_VERSION:
        sys.exit("Update the pinned model-data artifact for this Pi version before bootstrapping")
    artifact = tools / f"pi-ai-{PI_AI_VERSION}.tgz"
    raw = artifact.read_bytes() if artifact.exists() else download(PI_AI_URL)
    if hashlib.sha512(raw).digest() != base64.b64decode(PI_AI_SHA512):
        sys.exit("Pi model-data artifact checksum mismatch")
    artifact.write_bytes(raw)
    data_dir = package / "src/providers/data"
    data_dir.mkdir(exist_ok=True)
    prefix = "package/dist/providers/data/"
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            if not member.name.startswith(prefix) or not member.isfile():
                continue
            name = member.name.removeprefix(prefix)
            if Path(name).name != name or not name.endswith(".json"):
                sys.exit("Invalid provider-data path in Pi artifact")
            (data_dir / name).write_bytes(archive.extractfile(member).read())
    # Retain this fork's provider/model additions using their actual generated metadata.
    supplement = json.loads((Path(__file__).parent / "model-data-supplement.json").read_text())
    for provider, models in supplement.items():
        path = data_dir / f"{provider}.json"
        grouped = json.loads(path.read_text()) if path.exists() else {}
        for model_id, model in models.items():
            for existing in grouped.values():
                existing.pop(model_id, None)
            grouped.setdefault(model["api"], {})[model_id] = model
        path.write_text(json.dumps(grouped, separators=(",", ":")) + "\n")
    expected = set(re.findall(r'from "\./providers/([^"/]+)\.models\.ts"',
                              (package / "src/models.generated.ts").read_text()))
    actual = {path.stem for path in data_dir.glob("*.json") if path.name != ".manifest.json"}
    if expected != actual:
        sys.exit("The pinned provider-data snapshot does not match this checkout's provider set")
    structure = {}
    hashes = {}
    for provider in sorted(expected):
        path = data_dir / f"{provider}.json"
        structure[provider] = {model_id: api for api, models in json.loads(path.read_text()).items()
                               for model_id in models}
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = json.loads((data_dir / ".manifest.json").read_text())
    normalized = json.dumps(structure, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    manifest.update(structureHash=hashlib.sha256(normalized.encode()).hexdigest(), files=hashes,
                    supplements={"providers": sorted(supplement),
                                 "generatorCommits": {
                                     "baseten": "c1019d9202b648143d123b7e6fb76543a6b82de6",
                                     "github-copilot": "720f0e8eeb1295a8030c50e165bc283f3d5fa6ff",
                                 },
                                 "capturedAt": "2026-10-12"})
    (data_dir / ".manifest.json").write_text(json.dumps(manifest) + "\n")
    subprocess.run([str(tools / f"node-v{NODE_VERSION}-linux-x64/bin/node"),
                    "scripts/check-model-data.ts"], cwd=package, env=env, check=True)


def main():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        sys.exit("This VPS bootstrap requires Linux x86_64")
    root = Path(__file__).resolve().parents[3]
    api = root.parent / "paper-api"
    if not (api / "package.json").is_file():
        sys.exit("Check out paper-api alongside paper-pi before bootstrapping")
    tools = root.parent / ".tools"
    tools.mkdir(exist_ok=True)
    node_dir = tools / f"node-v{NODE_VERSION}-linux-x64"
    if not (node_dir / "bin/node").is_file():
        filename = f"{node_dir.name}.tar.xz"
        base = f"https://nodejs.org/dist/v{NODE_VERSION}"
        checksums = download(f"{base}/SHASUMS256.txt").decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == filename)
        archive_bytes = download(f"{base}/{filename}")
        if hashlib.sha256(archive_bytes).hexdigest() != expected:
            sys.exit("Node archive checksum mismatch")
        with tempfile.TemporaryDirectory(dir=tools) as temporary:
            with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:xz") as archive:
                archive.extractall(temporary, filter="data")
            shutil.move(str(Path(temporary) / node_dir.name), node_dir)
    if subprocess.check_output([str(node_dir / "bin/node"), "--version"], text=True).strip() != f"v{NODE_VERSION}":
        sys.exit("The local Node installation does not match the pinned version")
    baseline = root.parent.parent / "pi-deepswe"
    uv = baseline / ".tools/bin/uv"
    if not uv.is_file():
        uv = tools / "bin/uv"
        if not uv.is_file():
            raw = download(UV_URL)
            if hashlib.sha256(raw).hexdigest() != UV_SHA256:
                sys.exit("uv wheel checksum mismatch")
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entry = next(name for name in archive.namelist() if name.endswith("/scripts/uv"))
                uv.parent.mkdir(exist_ok=True)
                uv.write_bytes(archive.read(entry))
                uv.chmod(0o755)
    if subprocess.check_output([str(uv), "--version"], text=True).split()[1] != UV_VERSION:
        sys.exit(f"Expected uv {UV_VERSION}")
    env = {**os.environ, "PATH": str(node_dir / "bin") + os.pathsep + os.environ.get("PATH", ""),
           "UV_PYTHON_INSTALL_DIR": str(tools / "python"), "UV_CACHE_DIR": str(tools / "uv-cache")}
    python = baseline / ".tools/python" / f"cpython-{PYTHON_VERSION}-linux-x86_64-gnu/bin/python3.12"
    if not python.is_file():
        subprocess.run([str(uv), "python", "install", "--no-bin", PYTHON_VERSION], env=env, check=True)
        python = tools / "python" / f"cpython-{PYTHON_VERSION}-linux-x86_64-gnu/bin/python3.12"
    venv = root / ".venv"
    if not (venv / "bin/python").is_file():
        subprocess.run([str(uv), "venv", "--python", str(python), str(venv)], env=env, check=True)
    actual_python = subprocess.check_output([str(venv / "bin/python"), "--version"], text=True).strip()
    if actual_python != f"Python {PYTHON_VERSION}":
        sys.exit(f"Expected Python {PYTHON_VERSION} in {venv}, found {actual_python}")
    env["UV_PROJECT_ENVIRONMENT"] = str(venv)
    subprocess.run([str(uv), "sync", "--locked", "--no-dev", "--python", str(python),
                    "--project", str(Path(__file__).parent)], env=env, check=True)
    npm = str(node_dir / "bin/npm")
    for project in (api, root, root / "packages/coding-agent/examples/extensions/paper"):
        subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=project, env=env, check=True)
        if project == api:
            subprocess.run([str(api / "node_modules/.bin/tsup")], cwd=api, env=env, check=True)
        if project == root:
            hydrate_models(root, tools, env)
    config = root / "config.local.toml"
    if not config.exists():
        source = baseline / "config.local.toml"
        if source.is_file():
            text = source.read_text()
            model, separator, _run = text.partition("[run]")
            if not separator:
                sys.exit("The baseline configuration is missing [run]")
            config.write_text(model + '[run]\ntasks_dir = "' + str(baseline / "datasets/deep-swe/tasks") +
                              '"\njobs_dir = "packages/evals/.eval/deep-swe"\nconcurrency = 1\n')
        else:
            shutil.copyfile(Path(__file__).parent / "config.example.toml", config)
    print("Ready. From paper-pi, export your model API key and run:", flush=True)
    print(".venv/bin/paper-deepswe check --config config.local.toml")
    print(".venv/bin/paper-deepswe run --config config.local.toml --all --prune-docker-cache")


if __name__ == "__main__":
    main()
