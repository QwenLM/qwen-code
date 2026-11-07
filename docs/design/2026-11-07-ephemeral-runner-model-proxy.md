# Combining ephemeral runners with a model proxy

[English](2026-11-07-ephemeral-runner-model-proxy.md) | [简体中文](2026-11-07-ephemeral-runner-model-proxy.zh-CN.md)

Date: 2026-11-07. Status: proposal and partial verification complete; the
combined service is neither implemented, deployed nor enabled.

## Goals and scope

When CI for an external PR needs a real model, every ephemeral runner uses its
own short-lived, restricted proxy credential. The real model AK goes only to the
trusted model proxy and never into a runner container. After the runner finishes
one job, the management service reclaims the container and revokes the
credential. Existing keyless jobs need no change.

The existing triage/verify execution model is unchanged, no external PR gains
unrestricted model access by default, and Docker is not claimed to be
virtual-machine isolation from malicious code. This proposal provides neither
release capability, model-output trustworthiness, nor prompt-injection
protection.

## Current code and verification

- `scripts/ci/ephemeral-runner/manager.mjs` creates a single-job JIT runner for
  each fixed slot, gives every container its own bridge, and replenishes after
  reclamation. Model-proxy integration does not exist yet.
- `triage`, `tmux-testing` and `verify` in `.github/workflows/qwen-triage.yml` each embed
  a model proxy: it listens on host loopback, validates requests with a random
  bearer, substitutes the real AK, forwards only `POST .../chat/completions`,
  and supports streaming responses and an idle timeout. These are per-workflow
  temporary processes, not standalone gateways.
- Using the proxy extracted from the existing `verify` workflow plus a fake
  upstream, we verified that a wrong token returns 401, other paths return 403,
  a correct token is forwarded with the upstream receiving only the fake real
  AK, and streamed data is returned. Two correct requests both succeed: the
  current implementation has no per-request revocation.
- Five selected existing triage tests pass, covering authentication and the
  streaming idle timeout for the `tmux-testing` and `verify` lanes; the
  `triage` lane embeds the same proxy pattern and is in the extraction scope
  below.
- On Hangzhou hz4, with a temporary Docker bridge and a single restricted test
  container, we verified that `127.0.0.1` inside the container cannot reach a
  loopback service on the host. Test resources were cleaned up. This does **not
  prove** that a container cannot reach the host bridge address or other host
  services.
- No real model AK was used; an actual proxy deployment, credential issuance
  and revocation, quotas, model jobs for
  external PRs, and production network isolation were not verified.

## Trust boundary

```text
GitHub job queue
    ↓ dispatched to a labelled ephemeral runner
External-CI dedicated ECS                    Trusted proxy service environment
  runner management service ──protected issue/revoke──→ model proxy admin API
       │                                              │
       └─ runner container ──short-lived token──────→ model endpoint ──real AK──→ upstream
```

The model proxy is preferably deployed on a separate trusted host or service;
the real AK does not live on the runner ECS. The host management service holds
the runner-management PAT and the admin credential for the proxy admin API;
neither is mounted, injected into, or exposed to runner containers. The admin
API and the model endpoint are authorized separately and restricted by TLS and
network policy; containers cannot reach the issue/revoke endpoints, the
management service, the Docker socket, sensitive intranets, or ECS metadata.
Runners are allowed to reach only the model endpoint and the CI egress they
need.

Containers have sudo, so isolating the real AK from the container's root/node
users cannot be relied on. Plain Docker shares the host kernel; untrusted code
still needs a dedicated host, with virtual-machine isolation considered
according to risk. Network policy is enforced by the host or external network
devices that the container cannot modify, and is verified in practice.

## Credential and slot lifecycle

The first version issues credentials per **runner instance**, rather than
pretending to issue per PR or per job: the management service does not yet know
which job GitHub will assign when it creates a runner. Model capability needs
its own dedicated runner label and runner group, used only by explicitly
permitted model-test workflows; model tokens must not be injected into the
default keyless runner pool. Runner group permissions on the GitHub side must be
verified: labels or workflow YAML in a PR are not an authorization boundary.

State machine for each instance:

1. Generate a non-reusable instance ID. Request a random token through the
   protected admin API, setting model, request size, concurrency, call rate,
   total volume and an absolute expiry. Store on the proxy only what validation
   needs; persistent state and logs never record the plaintext token.
2. Deliver the proxy address and token to the corresponding new container; the
   management service itself must not hand management credentials or the
   upstream AK to a container. Supply them as `OPENAI_BASE_URL` and
   `OPENAI_API_KEY` for compatible tests. The token is considered public to that
   job; log redaction is not treated as a security boundary.
3. An idle runner still consumes its credential's lifetime. In the first
   version the credential lifetime covers the instance's maximum lifetime, and
   an instance left idle too long is reclaimed together with its runner; no
   fixed remaining time at job start can be promised.
4. Normal exit, failure, cancellation, timeout and restart recovery all revoke
   the token, delete the container and network, and clean up the GitHub
   registration. A new instance gets a new token; old tokens are rejected.
5. When issuance is uncertain, do not create a container that can reach the
   model; when revocation fails, stop replenishing that slot and retry, with the
   absolute expiry as the final backstop. After a management-service or proxy
   restart, reconcile first: the restart must not lose the revocation state or
   reset budgets for already-issued tokens.

Any script in the container can use or leak the token and may incur cost before
revocation; environment variables, container metadata, logs and artifacts are
all untrusted for that job. Credential capability must therefore be limited,
and the whole model pool or proxy endpoint must be switchable off immediately.

## Proxy features and budget

Extract a testable shared implementation from the existing forwarding logic and
preserve the behaviour of the three triage lanes; the new standalone service adds
credential issuance, revocation, persistent state, statistics and limits
separately, without changing the permissions or triggers of the existing
workflows. Allow only configured upstream targets, models and exact API paths;
requests must not control the upstream URL or pass an upstream authorization
header. Bound request body size, timeout and concurrency, keep streamed
disconnect handling, and prevent a client from triggering arbitrary address
access or unbounded resource use.

Set per-instance request counts, rates, concurrency and input/output limits, plus
a shared budget across all instances and a hard quota or alert on the upstream
account. Concurrent debits must be atomic and over-limit requests rejected.
Request-count and output-parameter caps are not an exact cost cap; a streamed
response may still incur cost after disconnect. An exact cost cap depends on the
model provider's metering and quota capability and must be verified once the
upstream is chosen. Do not log plaintext credentials, complete prompts or
responses unless a concrete later requirement and data-handling policy exist.

## Implementation and acceptance

1. Determine which model tests actually need external-PR execution, and which
   upstream model and budget they use; by default open exactly one controlled
   test workflow and do not change the existing `integration_no_ak` or other CI
   routing.
2. Extract and test the HTTP/streaming core of the existing proxy, preserving
   both triage lanes. Implement the standalone proxy's admin API, separate
   credentials, permissions, persistence, expiry, revocation and budget.
3. Add optional model-pool lifecycle to the management service; fail closed when
   issuance or cleanup is uncertain. Cover token injection, log redaction,
   abnormal recovery and old-token invalidation in tests.
4. In an isolated test environment with a fake upstream, one slot and a
   controlled private repository, verify two consecutive jobs: the two tokens
   differ; normal and streamed calls succeed; wrong, old, revoked and expired
   tokens are rejected; over-limit requests, concurrency races, upstream
   failures, and management-service/proxy restarts do not bypass the limits.
5. From inside a job, verify that the real AK, the runner-management PAT and the proxy
   admin credential are unreadable, and that metadata, the Docker socket, other
   containers and host management services are unreachable; verify that the
   proxy can reach only the permitted upstream. Both container-cleanup and
   credential-revocation failures must stop slot replenishment.
6. Prepare isolated dedicated ECS capacity and proxy services, and measure the
   network and GitHub authorization, then run a one-slot trial with a low-budget
   real model credential. Only after it passes does a maintainer decide whether
   to enable the corresponding model-test routing.

The existing runner design is described in
[the ephemeral runner design](2026-11-07-ephemeral-container-runners.md).
