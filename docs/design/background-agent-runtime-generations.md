# Background Agent runtime generations

[中文](background-agent-runtime-generations.zh-CN.md)

## Problem

A background Agent that does not settle after cancellation can leave its ACP child usable enough to answer transport probes but unsafe for fresh work. Replacing that child must not move its existing Sessions, create unbounded children, or route new work back to the draining generation.

## Design

Each ACP bridge channel has one of three states: `active`, `draining`, or `dying`. Existing Session entries continue to route through their recorded channel while it drains. Explicit recycle requests mark only the affected generation as draining; fresh work then creates a new active generation. Existing timeout retirement keeps its previous reap-after-drain behavior without starting another generation.

Fresh work admits at most two non-dying generations. If both are draining, admission fails with `503 runtime_recycling` until one exits. Restore and recycle recovery may start a replacement while dying processes await reap; dying generations remain tracked until channel exit so synchronous shutdown can still reach them.

After a logical watchdog abort, the Agent gets a fixed five-second cooperative exit window. If it still has not settled, its registry entry and sidecar become failed once while the underlying run keeps its concurrency slot. The terminal notification is recorded and displayed without starting another model turn, then the trusted child-to-daemon route requests recycle for the Session's owner generation. A late Agent settlement releases the physical slot but cannot replace the failed terminal state.

This changes no persisted Session format and adds no public timeout configuration.
