# Release Benchmark Server

This service receives authenticated release benchmark requests from GitHub
Actions, queues Harbor jobs in SQLite, and exposes public status and Harbor
report pages.

## Deployment

The production deployment currently uses:

- Ubuntu 24.04 and Docker
- Harbor `0.18.0` in `/home/ecs-user/qwen-benchmark/.venv`
- `qwen-release-benchmark.service` on `127.0.0.1:8000`
- `qwen-harbor-viewer.service` on `127.0.0.1:8080`
- Caddy for public HTTPS and read-only access to the Harbor viewer

Copy this directory to `/home/ecs-user/qwen-benchmark`, then install the pinned
Harbor version:

```bash
cd /home/ecs-user/qwen-benchmark
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Install the systemd units and Caddy configuration from this directory.

Create `/home/ecs-user/qwen-benchmark/.env` with mode `0600`:

```dotenv
BENCHMARK_ROOT=/home/ecs-user/qwen-benchmark
PUBLIC_BASE_URL=https://eval.example.com
VIEWER_BASE_URL=https://harbor.example.com
HARBOR_BIN=/home/ecs-user/qwen-benchmark/.venv/bin/harbor
RELEASE_BENCHMARK_OIDC_AUDIENCE=qwen-release-benchmark
OPENAI_MODEL=qwen3.7-max
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=<server-side secret>
PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
GITHUB_RELEASE_CACHE_DIR=/home/ecs-user/qwen-benchmark/cache/github
```

Do not put the API key in a Harbor config, systemd unit, repository variable,
or GitHub Actions secret. The service passes it directly from the protected
environment file to the installed Qwen Code agent.

Both public hostnames require inbound TCP 80 and 443 so Caddy can obtain and
renew certificates.

The bundled Harbor viewer also exposes write endpoints. Keep the Caddy method
restriction in place so the public viewer cannot run or delete jobs.

`PYPI_INDEX_URL` is passed to benchmark containers as both the pip and uv
package index. It avoids spending most of a run downloading verifier
dependencies over the server's slow default PyPI route.

Terminal-Bench's verifier installs a pinned `uv` release from GitHub. Cache the
official archive at
`cache/github/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz`.
Its expected SHA-256 is
`2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66`.
The cache is mounted read-only and selected through uv's official
`UV_INSTALLER_GITHUB_BASE_URL` override.
Managed Python builds use Astral's official release mirror through
`UV_PYTHON_INSTALL_MIRROR`.

```bash
cache=cache/github/astral-sh/uv/releases/download/0.9.5
mkdir -p "$cache"
curl --fail --location \
  https://releases.astral.sh/github/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz \
  --output "$cache/uv-x86_64-unknown-linux-gnu.tar.gz"
printf '%s  %s\n' \
  2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66 \
  "$cache/uv-x86_64-unknown-linux-gnu.tar.gz" | sha256sum --check
```

The `qwen_coder_mirror.py` agent only changes Qwen Code's setup transport: it
downloads the three pinned NVM runtime files from the Gitee mirror and verifies
their official SHA-256 values before loading them. Agent behavior, release
version, model configuration, and scoring remain unchanged.

## Suites

`release-smoke-v1` contains one pinned task from each benchmark and is used for
deployment verification.

`release-full-v1` contains all 500 SWE-bench Verified tasks and all 89
Terminal-Bench 2.1 tasks. It runs one trial at a time on the current
eight-core, 14 GiB host.

Dataset package revisions are pinned by SHA-256 in `suites.json`.

## Verification

Run the service tests inside the Harbor virtual environment:

```bash
cd /home/ecs-user/qwen-benchmark
PYTHONPATH=. .venv/bin/python -m unittest -v test_app.py
```

Check the services:

```bash
systemctl status qwen-release-benchmark qwen-harbor-viewer caddy
curl http://127.0.0.1:8000/
curl http://127.0.0.1:8080/
```
