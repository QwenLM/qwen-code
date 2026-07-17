# Release Benchmark Workflow

## Goal

Run a reproducible Harbor evaluation on an external evaluation server after
each stable Qwen Code release, without putting model credentials or
long-running benchmark work on GitHub-hosted runners.

## Scope

The first version only dispatches a versioned benchmark suite:

- Automatic dispatch is limited to published stable releases in
  `QwenLM/qwen-code`.
- Maintainers can dispatch an existing stable release manually from `main`.
- GitHub authenticates to the evaluation server with an OIDC token.
- The evaluation server owns the queue, Harbor installation, model
  credentials, raw results, and report hosting.
- The workflow submits work asynchronously and does not wait for the benchmark
  to finish.

Changing the legacy Terminal Bench workflow is outside this repository change.

## Workflow

1. A stable GitHub Release is published, or a maintainer selects an existing
   stable tag with `workflow_dispatch`.
2. The workflow resolves the release through the GitHub API and rejects drafts,
   prereleases, and tags that are not exact three-part stable semver tags.
3. The workflow requests a GitHub OIDC token with the configured audience.
4. It sends the release metadata and suite name to the evaluation server with
   an idempotency key.
5. The server returns a job ID and HTTPS status URL.
6. The workflow links the status page from its job summary and exits.
7. The server runs Harbor and updates the public status page with the final
   summary and a direct link to the read-only Harbor report.

Automatic dispatch is disabled until the repository variable
`RELEASE_BENCHMARK_ENABLED` is set to `true`. Manual dispatch remains available
for setup and verification.

## Repository Configuration

Configuration variables:

| Variable                          | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `RELEASE_BENCHMARK_API_URL`       | Public HTTPS base URL of the evaluation service                  |
| `RELEASE_BENCHMARK_ENABLED`       | Repository variable; set to `true` after end-to-end verification |
| `RELEASE_BENCHMARK_OIDC_AUDIENCE` | Optional OIDC audience; defaults to `qwen-release-benchmark`     |
| `RELEASE_BENCHMARK_SUITE`         | Optional automatic suite; defaults to `release-full-v1`          |

The workflow uses the `release-benchmark` GitHub environment so the server can
bind OIDC trust to that environment. It does not consume a static API secret.
The other variables can be configured at repository level or on that
environment.

The server should pin these OIDC claims rather than trusting repository names
alone:

| Claim                 | Required value                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| `iss`                 | `https://token.actions.githubusercontent.com`                           |
| `aud`                 | Configured audience, default `qwen-release-benchmark`                   |
| `sub`                 | `repo:QwenLM/qwen-code:environment:release-benchmark`                   |
| `repository_id`       | `1008713177`                                                            |
| `repository_owner_id` | `141221163`                                                             |
| `workflow_ref`        | Starts with `QwenLM/qwen-code/.github/workflows/release-benchmark.yml@` |
| `run_id`              | Equals `trigger.run_id`                                                 |
| `run_attempt`         | Equals `trigger.run_attempt`                                            |

For `workflow_dispatch`, the token's `event_name` and `ref` claims must be
`workflow_dispatch` and `refs/heads/main`. For a `release` event, they must be
`release` and `refs/tags/<release.tag>`. The request's `trigger.event_name` and
`trigger.workflow_ref` must equal the authenticated claims.

## Server API Contract

The server exposes:

```text
POST {RELEASE_BENCHMARK_API_URL}/v1/release-benchmarks
Authorization: Bearer <GitHub OIDC JWT>
Idempotency-Key: QwenLM/qwen-code:<tag>:<suite>
Content-Type: application/json
```

Request:

```json
{
  "schema_version": 1,
  "idempotency_key": "QwenLM/qwen-code:v0.20.0:release-smoke-v1",
  "release": {
    "repository": "QwenLM/qwen-code",
    "tag": "v0.20.0",
    "version": "0.20.0",
    "url": "https://github.com/QwenLM/qwen-code/releases/tag/v0.20.0",
    "commit_sha": "<40-character SHA>"
  },
  "suite": "release-smoke-v1",
  "trigger": {
    "event_name": "release",
    "actor": "<GitHub login>",
    "run_id": "<GitHub Actions run ID>",
    "run_attempt": "<GitHub Actions attempt>",
    "workflow_ref": "QwenLM/qwen-code/.github/workflows/release-benchmark.yml@..."
  },
  "callback": {
    "repository": "QwenLM/qwen-code",
    "commit_sha": "<40-character SHA>",
    "actions_run_url": "https://github.com/QwenLM/qwen-code/actions/runs/..."
  }
}
```

Successful response:

```json
{
  "job_id": "qwen-code-v0.20.0-release-smoke-v1",
  "state": "queued",
  "status_url": "https://eval.example.com/jobs/qwen-code-v0.20.0-release-smoke-v1"
}
```

`state` is one of `queued`, `running`, or `already_exists`. Repeating the same
idempotency key must return the existing job rather than starting another run.

## Server Responsibilities

The server must:

1. Validate the JWT signature, issuer, expiry, audience, immutable repository
   identity, `release-benchmark` environment subject, and workflow identity.
2. Fetch the GitHub Release independently and verify that the tag is a
   published stable release whose commit matches the request.
3. Queue jobs durably and enforce idempotency and a server-side concurrency
   limit.
4. Keep the Harbor version, dataset revisions, task list, model configuration,
   and number of attempts pinned in a versioned suite definition.
5. Install exactly `@qwen-code/qwen-code@<release.version>` and record the
   output of `qwen --version` before running trials.
6. Keep model credentials on the server and redact them from logs and reports.
7. Persist Harbor job directories and expose the returned HTTPS status URL.
8. Expose the Harbor viewer as read-only when it is publicly reachable.

## Activation

1. Implement the endpoint and OIDC validation.
2. Create the versioned `release-smoke-v1` and `release-full-v1` suites on the
   server.
3. Configure the public report/status page.
4. Set `RELEASE_BENCHMARK_API_URL` and, if needed,
   `RELEASE_BENCHMARK_OIDC_AUDIENCE`.
5. From `main`, manually dispatch `release-smoke-v1` for a recent stable tag and
   verify the status page, Harbor results, and idempotent rerun.
6. Set `RELEASE_BENCHMARK_ENABLED=true`.
