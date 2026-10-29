# Managed Agent capacity observation

[English](2026-10-22-managed-capacity-observation.md) | [简体中文](2026-10-22-managed-capacity-observation.zh-CN.md)

## Problem and scope

Issue #15082 asks for a capacity and idle-reclamation model. The first
deliverable is a read-only operator observation that can distinguish durable
runtime state from an unmeasured host condition. This slice extends the
reference distribution's existing `--check` preflight and does not admit,
reject, reclaim, or mutate any runtime.

## Observed facts

When the database preflight succeeds, `--check` groups rows by state in
`ma_runtime_binding`, `ma_runtime_session`, and `ma_operation`. The output names
these as durable logical records. A binding row represents a persisted runtime
generation, and a runtime-session row represents a persisted logical session;
neither is asserted to be one physical process. Operation state counts provide
the pending, running, recovery, and terminal distribution that an operator can
use to investigate backlog.

The report explicitly marks physical process count and memory as `unknown`.
Idle status is `not measured`: `last_active_at` alone cannot prove that a
runtime is safe to reclaim while leases, writers, tools, or recovery work may
still exist. No timeout, threshold, admission refusal, or cleanup action is
introduced.

## Failure and compatibility behavior

The existing database check remains the gate. If it fails, the capacity line is
`SKIP` so a missing database is not presented as an empty deployment. If the
database is reachable but one of the observation tables is unavailable, the
capacity line is `WARN` and the preflight continues to preserve the existing
read-only behavior. A timeout from the fixed five-second observation connection
is also `WARN`, but its detail says that the observation timed out before all
state counts were read and its fix points to database load, not a broken schema.
The state grouping intentionally keeps exact all-state counts and does not add
an index or restrict the query to non-terminal rows in this slice. A later
status view can provide a separately designed bounded operational view if that
becomes necessary. The query uses fixed table and column names from the shared
schema and does not change that schema.

## Acceptance and follow-up

Acceptance is a stable `capacity` line containing the three durable state maps,
plus explicit `physical-processes=unknown`, `memory=unknown`, and
`idle-reclamation=not measured`. A focused H2 regression exercises the grouped
state output without requiring a live deployment; it is intentionally not run
in this change.

The next #15082 slice still needs a deployment-owned capacity authority,
measurements for host memory and physical runtime identity, a precise idle
definition, and an evidence-preserving reclamation workflow through Runtime
Broker drain/close. Those decisions remain outside this report-only change.
