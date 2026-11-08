# Managed Git process-tree cleanup

[English](2026-11-04-managed-git-process-reaping.md) | [简体中文](2026-11-04-managed-git-process-reaping.zh-CN.md)

## Problem and scope

The Git runner stops the parent before its descendants. Linux CI recorded the parent disappearing while its original child remained a zombie under PID 1. That child still counts as alive, so stop proof fails and Workspace maintenance correctly remains held. The interrupted-checkout test repeats the same parent-first pattern. Separately, the native CSI test generator waits for the HTTP collector's close callback before forcibly closing active connections, which can prevent the callback from running.

This fix changes process cleanup and these test fixtures. It changes no SQL, Workspace ownership protocol, public API, or native fixture bytes. Unverified stops must continue to block resource release.

## Cleanup design

Retain one two-second cleanup deadline. During the first 1.5 seconds, repeatedly observe descendants and forcibly stop the current leaves while their parents remain able to reap them. Keep every observed handle, including handles that subsequently leave the original tree, in the final stop proof. Rescan surviving observed parents as well as the original root to catch new descendants.

Reserve the final 500 milliseconds for signaling all known descendants and the root and confirming their exit. Attempt every final signal even if another signal fails. Any observation or signal failure, or any original observed handle still alive at the deadline, remains `STOP_UNVERIFIED`. This is bounded best-effort tree discovery, not an operating-system guarantee that an unobserved process cannot escape.

Temporarily clear and record interruption while cleanup runs, then restore it even if cleanup fails. Record that cleanup was attempted so the runner's `finally` does not start a second cleanup budget after a failed attempt. Successful cleanup retains the original timeout, lost-claim, output-bound, or interrupted-command error semantics.

## Test fixture changes

Register the interrupted-checkout fixture with `worktree add --no-checkout`, then directly own and interrupt `reset --hard`. This preserves the partially written files without a failing parent `worktree add` deleting them. Stop any descendants before their parent. Keep the partial-file count, reentry refusal, and preservation assertions.

For the CSI collector, initiate `server.close`, immediately call `closeAllConnections`, then await the close promise. New connections are refused before existing ones are forced closed. Keep the generator's existing 30-second exit deadline and fixture/projection checks. An independent real HTTP shutdown probe can verify the ordering, but does not establish full native CSI acceptance or explain every historical generator timeout.

## Validation and acceptance

Exercise timeout, lost claim, output overflow, and nested parent/child/leaf interruption against real processes. Assert original PID disappearance and restored interruption. Exercise partial-checkout retry and the affected Workspace services, preserving their fail-closed maintenance behavior. Check Java style with JDK 21 and the source-matching sibling SDK. Use the module's shared ten-minute local verification budget.

Compare old and new collector shutdown with an active HTTP request. Full Linux/container process-reaping, Hosted/fault, native CSI, and SpotBugs gates belong in CI; macOS results alone do not establish non-reaping PID 1 behavior. Acceptance remains pending until required gates pass on the submitted revision. No migration is required.
