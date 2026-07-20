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
