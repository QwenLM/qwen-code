# Qwen Code benchmark service

Single-node control plane for the SWE-bench Verified POC. It accepts an
allowlisted suite, persists the run in SQLite, evaluates it asynchronously, and
writes the run evidence to the configured artifact root.

## Local development

```bash
cd benchmark-service
python3.12 -m venv .venv
.venv/bin/pip install -e '.[test]'

export BENCHMARK_ROOT="$PWD/.state"
export BENCHMARK_DATABASE_PATH="$PWD/.state/benchmark.db"
export BENCHMARK_WORK_ROOT="$PWD/.work"
export BENCHMARK_ARTIFACT_ROOT="$PWD/.artifacts"
export BENCHMARK_QWEN_REPO="$(git rev-parse --show-toplevel)"
export BENCHMARK_SWEBENCH_PYTHON="$PWD/.venv/bin/python"
export BENCHMARK_AUTH_MODE=token
export BENCHMARK_SHARED_TOKEN=development-only

qwen-benchmark-api
qwen-benchmark-worker
```

Submit the infrastructure smoke suite:

```bash
curl --fail-with-body \
  -X POST http://127.0.0.1:8000/api/v1/runs \
  -H 'Authorization: Bearer development-only' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-gold-smoke-1' \
  -d '{
    "repository": "QwenLM/qwen-code",
    "qwen_ref": "HEAD",
    "suite": "swebench_verified_gold_smoke",
    "trigger": "manual"
  }'
```

The gold suite validates the service, Docker, official dataset, grader, SQLite,
and OSS without consuming model tokens. The Qwen suite additionally requires
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`.

The production-shaped smoke suite is `swebench_verified_harbor_smoke`. It uses
the open-source Harbor Framework, pins the Qwen Code npm version from `qwen_ref`
(for example `v0.19.7`), and rejects a trial when Harbor reports a different
agent version. The release request should include the immutable 40-character
`qwen_commit` so the ECS does not need to fetch GitHub to resolve the tag.

## Outbound-only GitHub Release pipeline

No public API endpoint, domain, or inbound security-group rule is needed for the
single-node ECS POC. `qwen-benchmark-release-poller --once` retrieves the
latest non-draft, non-prerelease Release from `QwenLM/qwen-code` and creates an
idempotent run keyed by its GitHub `release.id`. The worker passes the Release
tag to Harbor, which waits for and installs the matching published
`@qwen-code/qwen-code` npm version. It rejects a trial that reports a different
Qwen Code version.

Install `deploy/qwen-benchmark-release-poller.service` and
`deploy/qwen-benchmark-release-poller.timer` on ECS. The timer runs every five
minutes. On first enable it queues only the current newest stable Release, not
the repository's historical releases.

Set `BENCHMARK_GITHUB_TOKEN` in the ECS-only secret file. Prefer a GitHub App
installation token limited to `QwenLM/qwen-code`; it needs Contents read/write
to read and update Releases and Checks write to create the completion Check
Run. On success, the worker updates the triggering Release body with only the
suite, version, commit, aggregate result, and run ID. Raw trajectories and
private artifacts remain on ECS/OSS.

## Target deployment

Install this package into `/mnt/workspace/qwen-benchmark/venv`, copy an edited
`deploy/benchmark.env.example` to
`/mnt/workspace/qwen-benchmark/config/benchmark.env`, install Supervisor, and
start it with:

```bash
supervisord -c /mnt/workspace/qwen-benchmark/service/deploy/supervisord.conf
```

Use shared-token mode only for a private POC route. The GitHub workflow expects
OIDC mode for a public HTTPS endpoint.

### Alibaba Cloud ECS

On a regular Ubuntu ECS host, install `deploy/benchmark.ecs.env` as
`/srv/qwen-benchmark/config/benchmark.env`, store the shared token separately in
`benchmark.secret.env` with mode `0600`, and install the two units from
`deploy/systemd/` under `/etc/systemd/system/`. The API binds only to loopback;
Nginx or an SSH-based dispatcher is the external entry point.

If the host cannot reach Docker Hub directly, install
`deploy/docker-daemon.ecs.json` as `/etc/docker/daemon.json` and restart Docker.
Treat public mirrors as a POC dependency; use ACR replication for stable runs.

## Reverse proxy

`deploy/nginx-http.conf` is an HTTP-only connectivity configuration. It keeps
FastAPI on `127.0.0.1:8000`, proxies `/healthz` and `/api/`, and rejects other
paths. Do not send credentials or GitHub OIDC tokens over this listener.

For production, copy `deploy/nginx-https.conf.template`, replace
`BENCHMARK_DOMAIN`, and install a trusted TLS certificate at the paths in the
template. Only TCP 443 should be public; TCP 8000 remains loopback-only.

The DSW runtime already has a Supervisor instance. Install
`deploy/nginx-supervisor.conf` under
`/etc/dsw/sys_configs/supervisor/conf.d/`, then use that runtime's
`supervisorctl reread` and `supervisorctl update` commands to manage Nginx.
