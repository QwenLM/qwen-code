# Bun on macOS file-watcher backends

[English](2026-11-16-bun-darwin-file-watchers.md) | [简体中文](2026-11-16-bun-darwin-file-watchers.zh-CN.md)

## Problem and status

Bun 1.4.4 on macOS can block the JavaScript thread while registering or closing
filesystem watchers. A saved application CPU profile contains native watch
registration stacks. A separate two-watcher control observed a synchronous
registration taking about 305 ms. These observations do not identify the cause
of the application's failed OS SIGINT timing checks. Those failures remain.

The exact Bun 1.4.4 source holds a shared registry mutex while the CF thread
rebuilds its FSEvents stream; registration and removal also acquire that mutex.
This change uses existing public polling APIs while keeping Bun 1.4.4 and
OpenTUI 0.5.10. Implementation is pending verification and maintainer review.

## Runtime policy and consumers

The shared `shouldPollFileWatchers()` policy selects only Bun on macOS. Node on
all platforms and Bun on Linux retain their existing backends. There are no new
user flags or environment settings.

CLI settings, LSP configuration, and extension watchers pass this policy as
Chokidar's `usePolling` option, including settings and extension bootstrap
watchers. Existing roots, ignored predicates, event classification, debouncing,
mutation suppression, generation checks, and close handling remain unchanged.
The extension store's existing 30-second generation check is supplemental; it
does not replace content hot reload.

The worktree-sidecar hook uses `fs.watchFile` on the exact sidecar path only on
the selected runtime, at 500 ms with `persistent: false`. It performs the same
initial read, tolerates a missing file, and unsubscribes the exact callback.
Unmounted callbacks cannot start new polling reads; pending reads retain the
existing cancellation checks. Other runtimes keep the directory watcher and
its existing directory-replacement limitation. This backend change does not
incorporate the separate Common owner-state changes.

Core Skills and file-change hooks select the same Chokidar backend while
retaining their roots, depth, exclusions, generation and abort handling.
Reflog subscriptions remain shared by resolved Git directory across the UI
branch hook and workspace Git-state service. On Bun/macOS they poll the validated
reflog path at 500 ms, retaining the original persistent subscription until the
last subscriber or cache cleanup removes that exact callback. Initial symlink
rejection and safe HEAD reads remain; later path replacement is not an atomic
confinement guarantee, and stat polling can follow a replacement symlink.
The UI retains its existing five-second branch refresh fallback; the workspace
Git-state service has no equivalent periodic refresh.

Durable cron polls its exact tasks file at 500 ms with `persistent: false`,
retaining its existing debounce and multi-session ownership. Stop disables queued
callbacks and removes only its own listener. Sidecar and cron polling do not
own process keepalive; the shared reflog retains its previous keepalive policy.
All Core paths and their downstream UI/service consumers require maintainer
review. This document does not qualify every command path or real lifecycle.

## Costs and boundaries

Polling adds periodic stat work and notification latency. Chokidar retains its
existing interval and binary interval defaults; sidecar polling uses the
existing Common design's 500 ms contract. Brief changes between polls may be
coalesced or missed. Atomic replacement, creation, deletion, symlinks, and root
recovery must be checked for each consumer rather than assumed equivalent.
FileChanged delivers a FIFO of hook events, not just a latest-state snapshot.
Its existing write-stability filter already suppresses some short-lived files,
but polling can add a discovery blind window. Maintainers must explicitly decide
whether that tradeoff is acceptable or that consumer must retain another
backend; a default-session SIGINT pass cannot qualify hook-event parity.
Existing Chokidar environment overrides keep their library-defined precedence;
qualification uses the clean default environment. No polling setting changes
the original interaction or exit deadlines.

## Verification and acceptance

Run the affected settings, LSP, extension, and worktree-hook whole test files,
then the normal build, typecheck, lint, format, and bundle checks. Route tests
must cover both policy results, target/bootstrap watchers, and unchanged native
routes. Sidecar tests must preserve session changes, late reads, independent
same-path subscriptions, cleanup, sandbox isolation, read-error recovery, and
real file creation, deletion, and atomic replacement.

Use owned real-filesystem and public application fixtures to verify hot reload
and ordinary exit on the new artifact. Existing failed or unqualified lifecycle
and OS SIGINT observations remain historical evidence. A local polling success
does not prove an FSEvents root cause, platform-wide stability, or complete
migration readiness. Runtime policy tests and all Core consumers must receive
maintainer review before merge or production-readiness claims.
