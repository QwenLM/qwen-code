# Hosted Hook command orphan reaper

[English](2026-10-19-hook-command-orphan-reaper.md) | [简体中文](2026-10-19-hook-command-orphan-reaper.zh-CN.md)

## Problem and scope

Issue [#14502](https://github.com/QwenLM/qwen-code/issues/14502), found by the FG13 round ([#14449](https://github.com/QwenLM/qwen-code/issues/14449)), records that a Runtime worker can die while a Hosted Hook command is running. SIGKILL, a V8 heap-OOM abort or a native crash runs none of the worker's JS handlers. The command's cgroup unit (`qwen-hook-<uuid>`) keeps its foreground process and any detached descendants; the unit name lives only in the dead worker's memory, and nothing in production finds, kills or removes it. The orphan can keep changing the Workspace after the record is `recovery_blocked`/`outcome_unknown`.

This slice adds a Hook-only parent-death reaper to the existing cgroup launcher. The launcher is already a member of the unit; when the worker disappears, it writes `cgroup.kill`, which kills every member including `setsid` descendants. It does not add a Broker or Java reaper, does not turn the unknown outcome into a settled one, and does not remove the empty unit directory.

## Decision

- `HookCommandCgroup.launch(..., { reapOnParentExit: true })` sets a launcher-environment marker. The launcher checks `process.ppid` every 100 ms; if it starts already reparented to PID 1 it reaps immediately, and on a later change it writes `cgroup.kill` and exits. The kernel kills the launcher and the whole unit, so a foreground command that never writes and detached descendants both go.
- The Hook runner opts in only for the `waitForProcessTree` command path. Background Shells do not: H3 deliberately keeps them across worker restarts and re-attaches their named units. The `survivesParentExit` Hooks (`MessageDisplay`, `StopFailure`, `SessionDelete`) use a separate supervisor and never create this unit.
- Why this instead of the issue's two designs: the launcher is already inside the unit, so no owner-derivable unit name or product state is needed, and the Java control plane gains no cgroup code. The kill happens at the only process that survives the worker. The empty directory and the unknown outcome remain; a sweep and the abandonment route are follow-up.

## Behavior and acceptance

- The launcher test spawns a worker that owns the launcher, kills the worker, and asserts the launcher wrote `cgroup.kill`; a second case starts the launcher after its worker has already exited (ppid 1) and asserts the immediate reap. The default launch carries no marker, so background Shells keep their current lifetime.
- The Hook runner suite and the existing process-tree cancellation cases stay green.
- On the Linux Hosted lane with a real delegated cgroup root, the original `HookRunner` reproduction (worker SIGKILL, heap-OOM, native crash) should now show the unit emptied; `populated 0` is the observable.
- `packages/core` typecheck and lint pass.

## Limits

- The empty unit directory remains after `cgroup.kill`; a worker-start sweep of `populated 0` `qwen-hook-*` units is follow-up.
- The record stays `recovery_blocked`/`outcome_unknown`: killing bounds the effect, it cannot settle an outcome no survivor observed.
- Only the local-process Linux cgroup path is covered; non-Linux Hook commands are already refused by the cgroup guard.
- A custom subreaper that adopts the launcher before it starts can hide the startup reparent; the normal worker/Harness topology reparents to PID 1, and the interval still covers a mid-command death.
- No Broker/Java change and no owner-derivable unit name in this slice.
