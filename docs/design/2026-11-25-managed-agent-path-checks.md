# Managed Agent checks by changed path

[English](2026-11-25-managed-agent-path-checks.md) | [简体中文](2026-11-25-managed-agent-path-checks.zh-CN.md)

## Problem

The fast tier in the [original gate design](2026-10-16-managed-agent-gate.md)
ran both Java and daemon checks for every matched change. A legacy GitHub
channel change in #18281 triggered both. The PR merged before the advisory
gate finished. In #18307 the Java daemon tests on main all failed at session
creation because the daemon rejected new sessions under the runner's load.

## Routing

The workflow reports `Managed Agent gate` on every PR to main, main push, and
merge group. It selects jobs inside the workflow using the changed paths.

| Change                                                                                   | Fast checks     | Full suite on maintainer approval |
| ---------------------------------------------------------------------------------------- | --------------- | --------------------------------- |
| SDK or Managed Agent Server Java packages and Java CI helpers                            | Java            | Yes                               |
| Daemon and CLI serve code, ACP bridge, managed runtime, or daemon E2E fixtures           | Daemon          | Yes                               |
| Java daemon SDK client, shared gate or SDK Java workflows, or both Java and daemon paths | Java and daemon | Yes                               |
| Managed channel adapters or Hosted integration fixtures                                  | None            | Yes                               |
| Documentation and unrelated paths, including the legacy GitHub adapter                   | None            | No                                |

Java runs the Linux Java 21 SDK unit tests, compiles the server reactor through
verification, and checks the class-size ratchet, SDK and server Checkstyle,
and Flyway migration versions. The full suite retains the complete server and
Hosted coverage. The daemon lane runs the Java 11 client against the real
daemon with a fake model. The fixture opts out of host-load admission so the
session contract tests can run under shared CI load. Production admission is
covered by its dedicated tests.

The first maintainer approval of an eligible head still starts the full suite.
It publishes `Managed Agent full suite`. The nightly, manual, and release
checks retain their full coverage. PR reviews that do not start the suite use
a separate no-op check name, so another review cannot replace a full result.

## Rollout and acceptance

- Verify that a documentation or legacy GitHub adapter change reports the gate
  without starting the SDK Java workflow.
- Verify that Java-only, daemon-only, and combined changes run the matching
  checks and report failures through `Managed Agent gate`.
- Verify that the first eligible maintainer approval reports the background
  result separately and that a duplicate approval does not replace it.
- Observe representative fast runs on GitHub Actions before requiring
  `Managed Agent gate` in the main ruleset. Scope-check failures and cancellations
  must fail the gate. Nightly coverage remains the backstop for dependencies
  outside the selected paths.
