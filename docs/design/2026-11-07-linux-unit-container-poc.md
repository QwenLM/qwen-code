# Linux unit-test container PoC

[English](2026-11-07-linux-unit-container-poc.md) | [简体中文](2026-11-07-linux-unit-container-poc.zh-CN.md)

## Problem and current state

External-contributor pull requests currently use GitHub-hosted Linux runners for the unit-test build and its eight shards. The ECS pool has spare capacity, but an unknown fork must not get host filesystem or credential access through a persistent self-hosted runner. This creates a capacity-isolation trade-off.

This change is limited to a minimal, manually dispatched proof that an independently selected public SHA can be built and fully tested inside a disposable Docker container on ECS. It does not change external-PR routing.

## Runtime finding that changed the approach

The first attempt put the existing build and shard jobs into a GitHub Actions job `container:`. Run [`42340903564`](https://github.com/QwenLM/qwen-code/actions/runs/42340903564) initialized that container and checked out `2SinceJuly/qwen-code@2905dccbe45ed2917b28c7de6a935d031546ee43`, but the runner's `Starting job container` log included:

```text
-v "/var/run/docker.sock":"/var/run/docker.sock"
```

That mount appears automatically for this runner version together with `/__w`, `/__e` and runner-temp directories, despite no socket volume being requested in YAML. Code inside such a job container can control the Docker daemon and therefore the host. A job `container:` is consequently not an acceptable untrusted-code boundary here.

That attempt stopped at its isolation probe; **it did not run the dependency install, build, or unit tests**. Its checkout cleanup and runner-driven container removal did succeed. Ordinary `test_build`, `test`, and `lint_and_static` have now returned to their exact pre-PoC shape.

The follow-up [`42354027932`](https://github.com/QwenLM/qwen-code/actions/runs/42354027932) removed the socket but showed `HTTP 200` from Alibaba Cloud metadata at `100.100.100.200`, refusing to run source scripts before installation. This stopped again before dependency installation, build, or unit tests. It proved that container UID/capability restrictions alone are insufficient here.

With authorization for this PoC only, the driver therefore creates a dedicated Docker bridge and inserts two `REJECT` rules into the host's `DOCKER-USER` chain, scoped to that bridge, for `169.254.169.254` and `100.100.100.200`. The same `EXIT` trap deletes the container, bridge, and exact rules. Successful cleanup is verified by absence checks for the rules and network; missing sudo or chain support fails before untrusted scripts, not into a weaker boundary.

## Scope

In scope:

- An opt-in `linux_unit_container` input on the existing trusted `workflow_dispatch` entry.
- A public `owner/repository` and lowercase full 40-character commit SHA as the independently tested source.
- One new `linux_unit_poc` job, with no `container:` key and only `contents: read`.
- A dedicated checkout using a pinned actions checkout SHA, `persist-credentials: false`, and an exact local `HEAD` verification.
- A trusted inline driver that creates a disposable container explicitly instead of asking the runner for a job container.
- A single build plus the complete `run-unit-test-lanes.sh` test payload in that one container, avoiding an untrusted build archive crossing between containers.
- Regression guards for the opt-in behavior, unchanged existing jobs, source validation, isolation checks, and cleanup.

Out of scope:

- Automatic use by `pull_request`, `push`, `merge_group`, or scheduled runs.
- A new default route for external PRs or any change to the existing eight-shard path outside the opt-in run.
- `pull_request_target`, privileged containers, host networking, Docker socket access, or shared credentials/cache mounts.
- A disposable-runner autoscaler, a production admission service, or a claim that Docker alone proves full isolation against kernel escapes and all denial-of-service attacks.
- Production sharding. The initial closed loop deliberately keeps one container so archive provenance and trust boundaries cannot be mistaken for harmless transport.

## Execution model

The dispatch revision supplies the workflow definition before the tested checkout exists. Repository and SHA are data inputs and cannot rewrite that definition or its isolation probes.

When `linux_unit_container=true`:

1. The trusted classifier selects `docs_only` for the ordinary full-CI payload, so the unrelated existing jobs do not execute their full test bodies.
2. `linux_unit_poc` validates the repository format and exact SHA, checks out into a unique run/attempt subdirectory, disables credential persistence, and verifies the actual checked-out commit and absence of a local GitHub authentication header.
3. A trusted inline Dockerfile extends `node:22-bookworm` with the required tmux/zip/util-linux tools. It does not read any context or instructions from the tested checkout.
4. The driver uses `docker create` with `--init`, `--user node`, `--cap-drop ALL`, `--security-opt=no-new-privileges`, and a single read-only source mount. It supplies no privileged mode, no host network, no Docker socket, no base workspace mount, and no secret-bearing environment.
5. Before executing source scripts, the container checks `NoNewPrivs=1`, absence of effective `SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, and `DAC_OVERRIDE`, absence of the Docker socket, Node 22, and blocked or explicitly denied AWS/Alibaba Cloud metadata endpoints.
6. The source is copied from `/source:ro` to `/tmp/repository`. Frozen pnpm installation, `npm run build`, `npm run bundle`, and the complete test-lane script execute as UID 1000 with a fresh HOME/Corepack cache and empty model credentials. Only the expected SHA is forwarded explicitly to the test container.
7. An `EXIT` trap force-removes the container and its volumes. A subsequent `docker ps --all` check proves it is gone, and a guarded final step removes the dedicated checkout.

The probe script, driver, Dockerfile and cleanup are inline in the trusted dispatch workflow. The tested repository cannot replace them with a safer-looking implementation of its own.

## Security boundary and known limits

This proof tests concrete isolation mechanisms; it is not an unconditional claim that Docker is a sandbox for all hostile inputs.

- The ECS host kernel is shared. Container escapes, kernel vulnerabilities, and malicious resource consumption remain possible. Resource ceilings beyond the job timeout require a production decision.
- The metadata checks cover only `169.254.169.254` and `100.100.100.200`. Other internal-network egress is unproven.
- The image uses the same mutable `node:22-bookworm` tag already used by this repository's container jobs. A production boundary needs a pinned trusted image digest and a supply-chain review.
- Reused runner state outside the dedicated checkout is not sanitized by this PoC. No claim is made for other runner mounts, credentials or co-resident jobs.
- Normal returns, probe failures and test failures remove the container and checkout. A hard job cancellation or host failure may leave residue and needs watchdog cleanup.
- The PoC removes the cross-container build archive; it does not yet provide a production-scale sharded design with that same provenance guarantee.
- The opt-in profile deliberately suppresses unrelated full CI bodies during the manual run. The new job's success is the evidence; a green aggregate job that skipped its own tests is not.

Production rollout therefore still requires a trusted PR-independent admission path, an untrusted-only execution pool, bounded egress, per-job resource limits, cleanup/watchdog behavior, and preferably one-job ephemeral runners with guaranteed-clean execution environments. Official GitHub guidance recommends Just-in-Time runners plus automation guaranteeing a clean environment; recycled hardware alone is insufficient.

## Files

- `.github/workflows/ci.yml`: opt-in mode, source validation, explicit container driver, isolation probes, and cleanup.
- `.github/scripts/ci-runner-routing.test.mjs`: regression coverage for scope, inputs and unchanged existing routes.
- `docs/design/2026-11-07-linux-unit-container-poc.md` and `.zh-CN.md`: design, observed runtime constraint, and limits.
- `.qwen/e2e-tests/linux-unit-container-poc.md`: validation plan and observed results; not a tracked deliverable.

## Validation and acceptance

Static checks must prove that ordinary events retain their existing paths, the new job runs only for the opt-in dispatch, no job `container:` is used, and raw container creation cannot grant Docker socket or privilege-escalation access.

A real dispatched run must bind its workflow head and independently tested public SHA to the same run and demonstrate:

- the initial source and isolation probes succeed;
- the source is installed, built, and completely tested as UID 1000 inside the explicit container;
- the normal eight-shard path remains untouched outside the opt-in run;
- the container and its volumes are removed, and the dedicated source checkout is removed;
- any remaining network, runtime and security warnings are preserved in the report.
- input validation rejects malformed repositories, branch names, short SHA values, and credential persistence.

No green run may be reported if metadata access is open, the socket is present, any unit-test command fails, or cleanup is unproven. This PoC is not sufficient authorization for automatic external-PR routing without a later review of the remaining threats and production architecture.
