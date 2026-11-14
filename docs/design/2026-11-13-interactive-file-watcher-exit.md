# Prepare file watchers before final interactive exit

[English](2026-11-13-interactive-file-watcher-exit.md) | [简体中文](2026-11-13-interactive-file-watcher-exit.zh-CN.md)

## Problem and evidence

On macOS arm64 with Bun 1.4.4, public `/quit` can print its summary while the interactive process remains alive beyond the existing 12-second E2E wait. The extension bridge replay recorded three passing cases and three failed cases, with seven natural exits across reached hot/cold sessions. The failures retain their original cleanup statuses. A separate unmodified `83cd18ac` diagnostic also reproduced the hang, so the extension bridge is not required.

The clean-main sample captured all 888 main-thread observations waiting on a native unfair lock, concurrent with an FSEvents registration RPC wait on `CFThreadLoop`. Unsymbolicated Bun frames do not identify a particular JavaScript watcher, close caller, lock cycle or permanent deadlock. This evidence supports a controlled trial of the existing final-exit watcher policy, not a claim that the exact native cause has been proven.

## Change and scope

Call the existing `prepareFileWatchersForProcessExit()` at two CLI entry points: OpenTUI's shared `exitSession`, after its existing once-only latch and before `requestShutdown`; and Ink's public quit action, before request cancellation, summary state changes and shutdown. Cancellation can synchronously reach resource cleanup, so preparation must precede it.

The helper already marks final process exit for ACP. On macOS it makes watcher cleanup detach listeners instead of synchronously rebuilding native FSEvents streams; the exiting OS process reclaims those handles. Other platforms retain normal watcher closure. No Core behavior or helper contract changes. Preparation is process-global and appropriate only after the CLI has committed to final process exit. It must not run for an in-process resume, renderer switch, ordinary unmount or session replacement.

The existing OpenTUI latch remains authoritative; a second call does not prepare watchers, request shutdown, drain or exit again. Ink gains no new latch. Its existing 100 ms summary delay and cleanup/exit sequence remain unchanged. No runtime flags, cleanup or E2E timeout increases, forced-success exits, or public case assertion changes are introduced. Other signal handlers and renderer-fatal paths are not separately qualified by this change.

## Validation and acceptance

Root runs build, typecheck, focused CLI unit files, lint and bundle. Unit coverage checks preparation before shutdown and cleanup, final exit order, OpenTUI idempotence, and Ink's normal and throwing-cancellation paths with its existing 100 ms delay.

Then Root replays the unchanged public setting Ctrl+C and marketplace Beta-Yes cases against the same newly built candidate under Node/Ink, Bun/Ink and Bun/OpenTUI, preserving the original 12-second exit waits. Installation, authority and hot/cold state assertions remain intact. A scoped pass requires every reached ordinary quit to exit naturally with code 0 and no signal, with zero model requests and no cleanup/evidence error. Any remaining hang stays a failure and requires further investigation; the old failures are never overwritten. This does not qualify Windows, device/voice, a release artifact, or the complete migration.

Status: implementation candidate; build, unit and public runtime verification pending Root execution.
