# SWE-bench Verified Service POC

## Goal

Run a reproducible Qwen Code benchmark after a GitHub release using one PAI
DSW instance and its mounted OSS bucket. The release workflow submits a small,
allowlisted request. The service records the request before returning, runs
Qwen Code and the official SWE-bench grader asynchronously, stores recoverable
artifacts in OSS, and optionally reports the result to GitHub.

The POC uses `princeton-nlp/SWE-bench_Verified`. The smoke suite contains the
single instance `sympy__sympy-20590`; the full suite uses the frozen 500-instance
dataset revision configured on the worker.

## Constraints

- The DSW container has no systemd.
- Docker runs inside the privileged DSW container. Active Docker data stays on
  local NVMe, not OSSFS.
- The DSW HTTP port may not have a stable public route. The API is still useful
  for a direct route or gateway; an OSS inbox can be added without changing the
  run protocol.
- GitHub requests select an allowlisted suite. They cannot submit shell
  commands, arbitrary datasets, credentials, or unbounded concurrency.
- SQLite is sufficient for one coordinator and one active run. Multi-host
  scheduling is outside this POC.

## Components

```text
benchmark-dispatch.yml
  -> POST /api/v1/runs
  -> SQLite runs, instances, events
  -> benchmark-worker
     -> checkout requested Qwen Code ref
     -> create predictions.jsonl
     -> swebench.harness.run_evaluation
     -> OSS runs/<run_id>
  -> optional GitHub Check update
```

The service is a separate Python package under `benchmark-service/`. It uses
the standard-library SQLite driver instead of an ORM, FastAPI for HTTP, and the
official SWE-bench Python package for dataset and grader integration.

## Authentication

Production requests use a GitHub Actions OIDC bearer token. The API validates
the GitHub issuer and signature, audience `qwen-benchmark`, repository and
repository ID, workflow reference, and event name. A constant-time shared-token
mode exists only for the POC deployment and local tests.

An `Idempotency-Key` is required. The database also has a unique key over the
resolved Qwen commit, suite, and dataset revision so delivery retries cannot
start a second official run.

## Run states

```text
QUEUED -> PREPARING -> RUNNING_AGENT -> GRADING -> UPLOADING -> SUCCEEDED
                                                    \-> FAILED
```

Instances end as `RESOLVED`, `UNRESOLVED`, `AGENT_FAILED`, `INFRA_FAILED`,
`TIMEOUT`, or `CANCELED`. A heartbeat makes abandoned work detectable after a
process or node restart.

The `gold` runner mode is restricted to the `swebench_verified_gold_smoke`
suite and validates infrastructure only. Publishable suites always use the
`qwen` runner mode.

## Storage

```text
/mnt/workspace/qwen-benchmark/state/benchmark.db
/tmp/qwen-benchmark/docker
/tmp/qwen-benchmark/workspaces/<run_id>
/mnt/data/qwen-benchmark/runs/<run_id>/
```

Each run stores its immutable request and manifest, current status, prediction,
patch, agent output, grader output, summary, and SHA-256 checksums. Status and
per-instance evidence are copied after each stage rather than only at the end.

## Completion rule

A run succeeds only when every manifest instance has one terminal state, the
counts match, the grader report parses, required OSS artifacts exist, and no
run-owned Docker container remains. Model failure and a valid unresolved result
are benchmark outcomes, not infrastructure retries.

Infrastructure failures may retry once. Examples are Docker pull errors,
temporary model 5xx responses, OSS upload failure, and a lost worker. Normal
agent timeout, empty patch, and failed tests are not retried.

## POC deployment

The target DSW instance runs `dockerd`, `benchmark-api`, and
`benchmark-worker` under Supervisor. The API listens on port 8000. Secrets are
environment variables or mounted files and are never written into run
artifacts.

The first acceptance run submits `swebench_verified_gold_smoke`, waits for a
terminal state, verifies `sympy__sympy-20590` resolves, and checks the OSS
report. A second run with the `swebench_verified_qwen_smoke` suite is enabled
after a model profile is configured.
