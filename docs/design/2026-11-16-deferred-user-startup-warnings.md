# Deferred interactive user startup warnings

[English](2026-11-16-deferred-user-startup-warnings.md) | [简体中文](2026-11-16-deferred-user-startup-warnings.zh-CN.md)

## Problem and scope

Checking the working directory and ripgrep availability can take time. Interactive users should be able to see and use the interface while these noncritical checks finish, with their warnings still delivered afterward. This change does not disable checks, hide failures, extend readiness deadlines or change permissions.

Only interactive user-warning checks are deferred. Safe-mode, file, settings, configuration, authentication and interrupted-workflow handling retain their existing startup paths. Headless and ACP execution retain the original awaited warning checks and stderr ordering. Late warnings never write into an already painted terminal through stderr.

## Request and display

Bootstrap creates one promise and AbortController for the captured Config, working directory and check options. It observes rejection immediately, before either UI subscribes. The same request is passed through the actual Ink and Native entry points, including a renderer fallback; React rendering never starts another check.

A small shared hook exposes results only to the matching Config/request/working-directory selection. Ink merges those strings into existing Notifications without storing a foreign request's result in initial-warning state. Native adds warning transcript events and deduplicates their text. A rejected request produces a visible warning rather than disappearing silently.

## Ownership and clear

The request belongs to an application boot, not a conversation ID. Same-workspace clear preserves displayed warnings without rerunning checks. Native transcript reset reconstructs current owned warnings; Config replacement and StrictMode replay replace old warning projection before replaying Mod notifications. The initial fresh empty-history path retains its existing behavior.

Each effect subscription becomes inactive on cleanup. Config or request replacement, working-directory drift, unmount and aborted requests reject late callbacks; returning from A to B to A cannot revive an old subscription. Owner mismatch returns no old result on the first render. Unknown or foreign ownership never falls back to another Config.

StrictMode unsubscription does not abort the shared request. The next subscription may receive the same settled result, while duplicate strings are displayed once.

## Exit and limitations

Actual exit registers abort-and-settle cleanup with the existing first-priority cleanup option. Ripgrep receives the existing public AbortSignal and waits for the supported child close. No Core implementation or new runtime option is added. The original no-signal call remains in noninteractive execution.

Filesystem realpath cannot be physically cancelled here. Its late result is discarded after revocation, and cleanup may reach its existing two-second per-function or five-second total ceiling. This change does not guarantee all underlying filesystem work has disappeared, and it does not change process-restart or signal policy. Clear is not exit cleanup.

## Validation and acceptance

The bootstrap regression must hold the noncritical check unresolved and require UI entry before settlement, while critical file warnings are still supplied. Headless and ACP tests must retain the original awaited checks and stderr ordering. Cancellation tests must verify the public signal is forwarded, cleanup aborts once and awaits supported close, and a late realpath result is discarded without claiming physical cancellation.

Renderer tests must inspect actual Ink Notifications output and the Native warning transcript, not only forwarded props. Cover late success, visible rejection, string deduplication, clear/reset reconstruction, owner replacement, old callbacks after A-to-B-to-A changes, unmount and StrictMode resubscription. The request must not run again because a conversation is cleared or an effect resubscribes.

A real PTY test must demonstrate that the prompt is usable while a controlled noncritical check is pending, that the resulting warning later appears once, and that clear preserves it. It must separately cover exiting while supported work is pending and reject stale-owner results wherever the actual UI allows owner replacement. Use owned configuration/workspace/runtime fixtures, preserve permission defaults and original test deadlines, and check natural product exit before helper cleanup. A polling-order or identity-observer gap is not a functional pass or a product-defect finding.

Validate the exact isolated source-bundle artifact on Node+Ink, Bun+Ink and strict Native after build, typecheck, affected whole-unit suites, lint, formatting and bundle checks. Evidence from another combined feature tree cannot qualify this artifact. Existing restart or signal regressions remain separate contracts and must not be silently credited to the warning change. Post-verification self-audit and non-author review are required before submission.

Filesystem cancellation limits and the existing cleanup ceilings remain acceptance boundaries. Windows, IME, distribution packages, long-term stability and overall UI migration require their own evidence. This design states test responsibilities rather than a changing execution-status ledger.
