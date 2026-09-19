# Real Linux bwrap integration CI

[English](2026-09-16-bwrap-integration-ci.md) | [简体中文](2026-09-16-bwrap-integration-ci.zh-CN.md)

## Problem and scope

PR #11614 delivered the opt-in bwrap backend, but its Linux integration lane was deferred. Mocked process tests cannot establish mount enforcement, network isolation, or host-visible process ownership. This follow-up adds deterministic integration coverage against the built CLI and system bubblewrap. It changes no sandbox policy, backend defaults, or production code.

## Design

An explicit `npm run test:integration:sandbox:bwrap` command uses a dedicated Vitest configuration and suite under `integration-tests/sandbox-bwrap/`. The ordinary integration configuration excludes this suite. The explicit command fails on non-Linux hosts, unavailable bubblewrap, or a failed namespace probe; unsupported infrastructure must not produce a green skipped suite. Tests run serially, without retries, with bounded process waits and cleanup.

Each test owns separate workspace, HOME, Qwen state, cache, and temporary directories. Child environments contain only required executable/system paths and fixture configuration, never inherited model credentials or sandbox markers. An outside-write target is a disposable sibling of the granted directories, not inside the sandbox's writable temporary directory. The test first proves the target is writable without confinement, then requires `EROFS` inside confinement and checks its contents remain unchanged.

Reuse the existing fake OpenAI server to drive an actual headless CLI tool round trip. Only model responses are scripted; the CLI, tools, bubblewrap, kernel, Git, sockets, and child processes execute normally. A local proxy fixture checks proxied traffic and cleanup without external services or API keys. Network tests separately prove open connectivity and closed refusal to the same live host endpoint; interface enumeration alone is insufficient.

Session ownership uses the production `SessionWriterLease` service in real processes, one launched through the sandbox command and one on the host. It verifies a live-owner conflict and takeover after that exact owner dies. This is service-level cross-boundary integration, not an ACP UI or daemon end-to-end claim: ordinary headless CLI runs do not enable writer leases.

## Acceptance

| Area                   | Required observation                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry and verification | Real bwrap selected; runtime markers and host PID namespace preserved; complete verification battery passes in open and closed modes.                                  |
| Filesystem             | Workspace write succeeds; an otherwise writable outside fixture fails with EROFS and remains unchanged.                                                                |
| Git                    | A linked worktree can stage and commit while its common repository remains outside the workspace and other writable roots.                                             |
| Model and network      | Fake-model tool call writes a workspace file through the normal CLI hop; open host connectivity succeeds and closed connectivity fails; configured proxy sees traffic. |
| Ownership              | Host-side contender cannot steal from a live confined owner; it can acquire after owner death.                                                                         |
| Lifecycle              | Normal exit and SIGINT/SIGTERM stop the fixture payload/proxy processes; tests assert disappearance before cleanup, rather than making cleanup the evidence.           |
| Fail closed            | Explicit bwrap selection cannot silently run the payload when the executable is unavailable.                                                                           |

## CI and affected files

A dedicated workflow runs on pull requests, main pushes, merge groups, and manual dispatch using an ephemeral GitHub-hosted Ubuntu 22.04 runner. It installs bubblewrap, Git, and curl, uses the pinned Node version, installs/builds the repository, typechecks integration tests, and runs the explicit suite. It uses read-only repository permissions, no credentials, and a job timeout. Kernel-wide policy changes on shared runners are unnecessary. Test reports are uploaded even on failure.

The change is confined to integration tests/configuration, the npm script, workflow, and synchronized design documentation. Existing no-sandbox and container suites keep their behavior.

## Limits and follow-up

These are regression checks for declared P0 behavior, not a complete sandbox security audit. Shared PID/procfs, host Unix sockets, writable Git/Qwen state, and advisory proxy routing remain the documented policy. SIGTSTP/SIGHUP lifecycle changes, Landlock, seccomp, and default enablement stay separate. CI itself is only verified after an actual hosted run; local Linux results are reported separately. No open product-policy decision is required for this test-only change.
