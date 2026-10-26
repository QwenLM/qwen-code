# Credential-free Release Fanout on ECS

[English](2026-10-25-release-fanout-lane1.md) | [简体中文](2026-10-25-release-fanout-lane1.zh-CN.md)

## Problem and scope

[#15465](https://github.com/QwenLM/qwen-code/issues/15465) records release metadata jobs waiting 37–42 minutes for GitHub-hosted capacity. This implements only Lane 1 of that issue, following the credential boundary in [Release Jobs Off the Hosted Pool](2026-10-16-release-jobs-off-hosted-pool.md). It does not complete the issue or activate Lane 2.

The inspected jobs have no `secrets` references or deployment environment. Their token permission is `contents: read`; “credential-free” here means no publishing, signing, model API, or OSS credentials, not absence of the ephemeral GitHub token.

| Workflow / job                 | Entry points                                                   | Tools and work                                                                                       |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Desktop / `prepare`            | Published release, dispatch, reusable call from Desktop Checks | Bash, Git, gh, jq, curl; resolve version/ref and read public release feeds                           |
| Live Host / `prepare`          | Dispatch, pull request                                         | Bash builtins; validate version and emit metadata                                                    |
| DSW benchmark / `release_gate` | Published release, dispatch                                    | Bash builtins; select benchmark inputs                                                               |
| Managed runtime / `prepare`    | Published release, dispatch                                    | Bash, gh, jq, Git, Node; validate release and read package version without executing repository code |

## Routing and trust boundary

Use the existing `repo-hygiene.yml` repository check and `MAINTAINER_ECS_RUNNER_DISABLED != 'true'` condition, selecting `[self-hosted, linux, x64, ecs-qwen]` in the official repository and `[ubuntu-latest]` elsewhere or when disabled. With the variable unset the shared pool is selected immediately; this corrects the issue's contradictory “both switches unset leaves every job unchanged” acceptance wording. No variable or runner label is changed by this PR.

Live Host also accepts `pull_request`. Its ECS condition additionally requires `github.event_name != 'pull_request'`, retaining hosted execution for every PR, including maintainer PRs. No author allowlist is added. The other three workflows have no PR event; Desktop's existing reusable caller is schedule/dispatch only. Tests pin those entry points. The existing trigger, step, permission, timeout, output, and downstream dependency definitions stay unchanged.

Lane 2 still needs operations to provision isolated release hosts and enable `ECS_RELEASE_HOST_RUNNER_ENABLED`. The Managed runtime `release` job holds OSS/signing credentials and remains hosted. VS Code Companion's `prepare` references `OPENAI_*` secrets, so it is excluded despite the original issue listing it in Lane 1. Publishing, OSS sync, platform builds, failure reporting, and all remaining jobs retain their routes.

## Tooling and persistent workspaces

The existing shared-pool `repo-hygiene` job invokes gh directly, and SDK Java's shared-pool jobs use preinstalled Node rather than downloading it through the ECS egress proxy. Git, Bash, jq and curl are also used by existing shared-pool workflows. These metadata jobs do not install dependencies or build artifacts. Managed runtime uses only Node's built-in filesystem/JSON support; no new Node setup or tool installer is needed. Existing setup actions in downstream jobs remain unchanged. This is a source-level prerequisite audit, not a fresh probe of every runner image.

Live Host and DSW do not read a checkout. Desktop and Managed runtime retain `actions/checkout`'s default `clean: true` (`git clean -ffdx` and reset); their inline steps inspect metadata and do not execute scripts from the checked-out release. No dependencies are installed and no build artifacts or merged artifact directories are written. The full release build's disk-floor gate would add overhead rather than protect a correctness boundary here, so this bounded change does not copy its wipe/disk-floor machinery. If any of these jobs later gains installs or heavy steps, it must adopt #15465's `restore_release_workspace` wipe anchor and disk-floor gate. Checkout cleanup failures remain failures; a runner/tool outage can be routed back to hosted by the existing kill-switch. The shared machine remains a lower-isolation environment than a dedicated publishing host, which is why no publishing credentials move with these jobs.

## Verification and acceptance

Extend the existing runner-expression evaluator with cases for all four jobs: official release/dispatch uses ECS; the kill-switch and nonofficial repository use hosted; both maintainer and external Live Host PRs stay hosted. Pin no deployment secrets/environment, read-only contents permission, and the absence of PR triggers in the unguarded workflows. The new routing cases fail against the old hosted-only definitions.

Run all six existing script meta-test suites that reference the changed workflows, the runner-routing suite, formatting, lint, and diff checks. Two source-review passes compare the complete diff and confirm other jobs are unchanged. No product/UI behavior changes, so interactive UI verification is not applicable. No workflow dispatch or production release is part of this change.

Acceptance is the tested routing and credential boundary. Actual queue latency and availability still depend on ECS capacity and must be observed on a subsequent authorized run; the PR does not claim a measured release speedup.
