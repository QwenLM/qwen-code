# Background Agent runtime generations

## Problem

A background Agent that does not settle after cancellation can leave its ACP child usable enough to answer transport probes but unsafe for fresh work. Replacing that child must not move its existing Sessions, create unbounded children, or route new work back to the draining generation.

## Design

Each ACP bridge channel has one of three states: `active`, `draining`, or `dying`. Existing Session entries continue to route through their recorded channel while it drains. Existing timeout retirement paths and explicit recycle requests mark only the affected generation as draining; fresh work then creates a new active generation.

The bridge keeps at most two OS-live generations. If both slots are occupied and neither can accept fresh work, admission fails with `503 runtime_recycling` until an older generation exits. Dying generations remain tracked until process exit so synchronous shutdown can still reach them.

This changes no persisted Session format and adds no public timeout configuration. Non-cooperative Agent detection and the child-to-daemon recycle request are connected in the following stacked PR.
