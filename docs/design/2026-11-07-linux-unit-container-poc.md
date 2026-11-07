# Linux unit-test container PoC

[English](2026-11-07-linux-unit-container-poc.md) | [简体中文](2026-11-07-linux-unit-container-poc.zh-CN.md)

## Problem and current state

External-contributor pull requests currently use GitHub-hosted Linux runners for the unit-test build and its eight shards. The existing ECS pool has spare capacity, but a persistent self-hosted runner must not execute unisolated code from an unknown fork. The hosted queue then delays the whole CI chain even though the unit tests already run successfully on ECS for trusted inputs.

The goal of this change is a minimal runnable proof of container execution, not an automatic change to external-PR routing.

## Scope

In scope:

- Extend the existing `workflow_dispatch` entry in `.github/workflows/ci.yml` with an opt-in Linux unit container mode.
- Allow that manually dispatched run to select a public source repository and an exact 40-character commit SHA independently of the workflow revision.
- Put `test_build` and every `test` matrix shard into `node:22-bookworm` when, and only when, this mode is selected.
- Reuse the existing checkout, dependency installation, build-cache archive, artifact transfer, and `run-unit-test-lanes.sh` test paths.
- Add workflow-local source validation, container-isolation probes, and explicit cleanup for the PoC.
- Add regression coverage to the existing workflow-routing meta-test.

Out of scope:

- Enabling container mode for `pull_request`, `push`, `merge_group`, or scheduled runs.
- Changing the default runner policy for external-contributor PRs.
- A disposable self-hosted-runner autoscaler.
- A claim that a GitHub Actions job container alone is a complete hostile-code security boundary.
- Privileged containers, Docker-socket access, host-network access, or a `pull_request_target` checkout of untrusted code.

## Execution model

The workflow definition and container settings are selected by the trusted manual-dispatch revision before the source tree is checked out. The tested repository and commit are data inputs; they do not supply the dispatch workflow definition.

When `linux_unit_container` is false (the default), both jobs emit their existing `null` container value and follow the unchanged host/ECS execution path. When it is true:

1. Validate the source repository as a GitHub `owner/repository` name and `branch_ref` as a full commit SHA.
2. Select `node:22-bookworm` with init and `no-new-privileges` for `test_build` and all eight `test` shards.
3. Check out the selected source revision without persisting checkout credentials and verify the resulting `HEAD` exactly.
4. Prove the steps are inside a container and check the limited PoC invariants: no Docker socket, no effective `SYS_ADMIN`, `SYS_PTRACE`, or `NET_ADMIN` capabilities, `NoNewPrivs=1`, and unreachable or explicitly denied AWS/Alibaba Cloud metadata endpoints.
5. Reuse the existing build-tree archive and all eight unit-test shards unchanged.
6. Remove checkout contents after all result uploads. Normal GitHub runner container teardown supplies the final container-removal evidence in the live validation report.

The source validator, isolation probes, and cleanup remain inline in the trusted workflow. Loading them from the tested checkout would allow that checkout to weaken its own checks.

## Security boundary and known limits

This PoC deliberately tests a narrow boundary. It does not introduce `pull_request_target` or another privileged event. The manual run uses public source code and disables checkout credential persistence; it does not add repository secrets.

The following remain production concerns, not properties asserted by this PoC:

- Self-hosted runner state and runner-managed bind mounts outside the cleaned checkout.
- Unexpected container escapes, kernel vulnerabilities, and denial-of-service beyond the normal job limits.
- Internal-network egress other than the explicit metadata probes.
- Untrusted build-archive contents crossing into other containers.
- Cleanup after a hard job cancellation or a lost runner.
- Enforcing container configuration when an external PR can modify its own `pull_request` workflow YAML.

A production rollout therefore still needs a trusted, PR-independent admission path, an untrusted-only execution pool, bounded egress, and preferably one-job ephemeral runners with clean execution environments. Official GitHub guidance recommends Just-in-Time runners with automation that guarantees a clean environment; reusing hardware without that guarantee is insufficient.

## Files

- `.github/workflows/ci.yml`: opt-in mode, source inputs, container selection, validation/probes, and cleanup.
- `.github/scripts/ci-runner-routing.test.mjs`: structural and executable regression guards for the opt-in behavior.
- `docs/design/2026-11-07-linux-unit-container-poc.md` and `.zh-CN.md`: this design and its verification boundary.
- `.qwen/e2e-tests/linux-unit-container-poc.md`: working validation plan and observed results; not a tracked deliverable.

## Validation and acceptance

Static checks must prove that ordinary events get no container, the PoC is restricted to manual dispatch, both execution jobs use the same trusted configuration, and external-PR routing is unchanged.

A real dispatched run must use an exact public source SHA and demonstrate:

- all isolation probes pass;
- the build tree is built once and consumed by all eight shards;
- every unit-test shard succeeds;
- PoC workspaces are empty after their cleanup steps;
- action-runner logs show container teardown;
- timings and any remaining warnings are recorded against the run URL.

The PoC is not accepted as evidence for automatic external-PR routing unless every remaining security limitation is either closed or explicitly accepted in a subsequent design decision.
