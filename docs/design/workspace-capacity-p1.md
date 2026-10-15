# P1: Configurable workspace registration capacity

[English](workspace-capacity-p1.md) | [简体中文](workspace-capacity-p1.zh-CN.md)

Status: implemented locally, 2026-09-09; validation results are tracked in `.qwen/e2e-tests/workspace-capacity-p1.md`. Implementation baseline: `d8c505bf423d6adf68c77a603202cd7b0578be56`.
Source baseline: `dd4cd4a08bf416f88d9e357045f6ff45aa557d2e`, the main commit
merging [#11428](https://github.com/QwenLM/qwen-code/pull/11428).
Tracks [#11386](https://github.com/QwenLM/qwen-code/issues/11386) and the
configuration requests [#9304](https://github.com/QwenLM/qwen-code/issues/9304)
and [#9316](https://github.com/QwenLM/qwen-code/issues/9316).

## 1. Recommendation and scope

Add one operator environment variable, `QWEN_SERVE_MAX_WORKSPACES`, with default
256 and supported range 1–256. The requested default is now 256; deployments
can explicitly select 25 to retain the earlier registration limit and session
defaults. This updates the initial default-25 proposal and the P1 expansion
stage in the [earlier research](workspace-lru-eviction.md). It does not change
historical evidence or establish a resource guarantee for 256 active workspaces.

P1 also needs a defined global session policy, bounded channel transactions,
and readable persisted registrations. A constant substitution alone does not
meet these requirements. Keep eager daemon runtime construction and existing
lazy ACP child startup. Dormant states, LRU, actual child-memory enforcement,
channel timeout negotiation and asynchronous channel-operation APIs are outside
P1. The three independent P0 policies must remain independent.

## 2. Verified baseline behavior

The following findings were checked against the source baseline, including
consumers outside the original P0 diff.

| Concern                  | Current behavior and source                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration             | [workspace-inputs.ts](../../packages/cli/src/serve/workspace-inputs.ts) defines 25. Startup checks and persisted merging consume it in [run-qwen-serve.ts](../../packages/cli/src/serve/run-qwen-serve.ts).                                                                                       |
| Runtime admission        | [workspace-management.ts](../../packages/cli/src/serve/routes/workspace-management.ts) counts managed user runtimes plus pending additions and scratch reservations. Internal Live Conversation runtimes are exempt; user scratch runtimes count.                                                 |
| Sessions                 | [deriveDefaultMaxTotalSessions](../../packages/cli/src/serve/run-qwen-serve.ts) returns no total cap for one startup workspace and otherwise multiplies the per-workspace cap by startup count. The default is 32 per workspace. Dynamic registration does not recalculate it.                    |
| Enforcement owner        | [total-session-admission.ts](../../packages/cli/src/serve/total-session-admission.ts) checks live sessions plus reservations. [run-qwen-serve.ts](../../packages/cli/src/serve/run-qwen-serve.ts) shares this controller across its bridges, including dynamically created and internal runtimes. |
| Store                    | [workspace-registration-store.ts](../../packages/cli/src/serve/workspace-registration-store.ts) reads at most 24 secondary records and 256 KiB. Updates re-read under lock but currently have no serialized-byte check before atomic writing.                                                     |
| Startup overflow         | [Stored merging](../../packages/cli/src/serve/run-qwen-serve.ts) skips invalid/reserved/nested paths and extra entries when capacity fills. Store read errors fall back to explicit workspaces.                                                                                                   |
| Channel grouping         | [channel-workspace-grouping.ts](../../packages/cli/src/serve/channel-workspace-grouping.ts) groups selected channels by unique owner. `all` selects only primary. Empty registered workspaces do not each create a channel worker.                                                                |
| Channel transactions     | [channel-worker-group.ts](../../packages/cli/src/serve/channel-worker-group.ts) stops, starts and rolls back sequentially. Failed rollback cleanup can retain both old and new owners. No independent owner-count guard exists.                                                                   |
| Timeout clients          | [DaemonClient.ts](../../packages/sdk-typescript/src/daemon/DaemonClient.ts) uses the fixed 2,130,000 ms channel default for legacy and qualified mutations. Web Shell uses these SDK methods. Java currently exposes no channel-control methods and retains raw capability maps.                  |
| Configuration provenance | [fast-path-settings.ts](../../packages/cli/src/serve/fast-path-settings.ts) can load project environment values before daemon construction. Operator-only keys are excluded in [shared-env-keys.ts](../../packages/cli/src/config/shared-env-keys.ts).                                            |

The [2026-09-08 measurements](workspace-capacity-baseline-2026-09-08.md) found
about 20.6 MiB additional post-GC daemon heap for 25→256 empty startup
workspaces on one macOS host. They also found watcher/FD costs and a default
session total of 800→8192. Those historical observations support investigating
opt-in expansion, not a universal 256-workspace resource guarantee.

## 3. Configuration and registration contract

### 3.1 One resolved policy per daemon

Add `ServeOptions.maxRegisteredWorkspaces` for embedded callers and the single
environment variable above. Precedence is explicit option, then startup
environment, then 256. Do not add a CLI flag, settings-schema property, runtime
setter, child-model variable or channel-capacity variable in P1.

For environment input, trim surrounding whitespace and require decimal digits
and an integer in 1–256. Empty/whitespace-only, 0, negative, fractional, exponent
or hexadecimal notation, NaN, Infinity and values over 256 fail startup. A
numeric embedded option must be a safe integer in the same range. A valid
explicit option bypasses an invalid lower-priority environment value.

Use a small pure resolver next to `workspace-inputs.ts`. `runQwenServe` resolves
from its existing frozen `daemonRuntimeBaseEnv` before admission or listener
publication, then passes the resulting number to server/routes/store writes.
Direct `createServeApp` callers use the existing boot environment snapshot and
the same resolver when no resolved option is supplied. Do not mutate a module
constant or `process.env`; two embedded daemon handles must remain independent.

Add the key to `PROJECT_ENV_HARDCODED_EXCLUSIONS`, with tests for both project
`.env` and project `settings.env`. An operator launch environment or the
existing trusted home-environment mechanism may supply it. Secondary overlays,
trust changes and later environment updates cannot resize a running daemon.

### 3.2 All admission consumers

Reuse the existing identity checks and reservation accounting. Thread the
resolved number through explicit startup validation, the completed persisted
merge, both owned-runtime admission checks, scratch creation, normal dynamic
registration, transient-to-persisted promotion, and the store's locked add
check. Count primary and user scratch runtimes. Keep the existing internal
Live Conversation exemption and its independent resource accounting.

Pass the resolved cap explicitly to store additions, including injected stores;
the store must not read environment or silently use a different limit. Read,
remove and rename operations use structural bounds, not this admission value.
Standalone store additions default to 256 registrations including primary,
while every production route must pass the daemon's resolved value.

Direct `createServeApp` must reject an injected initial registry already over
the advertised cap, counting the same non-internal identities. It must not
silently drop entries. An idempotent re-add consumes no slot. A slot under
construction or removal remains governed by existing reservation/drain rules;
do not admit another runtime by ignoring unfinished work.

## 4. Global session policy

Registration capacity is not permission to multiply running sessions. Use this
policy for the production `runQwenServe` owner:

| Resolved registration cap | Explicit `maxTotalSessions` | Proposed total session limit                                                                                                                              |
| ------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–25                      | Absent                      | Preserve current behavior: one startup workspace is unlimited; multiple workspaces use the existing per-workspace multiplication and unlimited semantics. |
| 26–256                    | Absent                      | Fixed default **800**, regardless of startup count or later registrations.                                                                                |
| Any                       | Present                     | Respect the explicit value; 0 and Infinity still disable the total cap.                                                                                   |

The default registration capacity of 256 selects the fixed 800-session policy,
even with one startup workspace. Keep the historical threshold of 25 independent
of the registration default.

800 preserves the old 25×32 default total as an independent expansion default;
it is not derived from the new registration cap or the child model. An explicit
per-workspace limit still controls each bridge but does not multiply the new
default total; even a per-workspace unlimited value leaves the expanded default
total at 800 unless total admission is explicitly disabled. Operators can use
the existing `--max-total-sessions` to select a lower deployment-specific cap.
800 is a compatibility ceiling, not a measured memory-safe concurrency target.

Resolve this once after startup merging, before constructing the shared
admission controller. All primary, secondary, scratch and internal Live
Conversation bridges created by `runQwenServe` retain its admission callback.
Do not add a second controller or recompute the cap during registration.

Low-level `createServeApp` retains its existing injected-bridge contract: the
embedding owner supplies matching bridge admission and `maxTotalSessions`.
It cannot retrofit admission into externally constructed bridges. Only
`runQwenServe` derives the production default; low-level embeds must not
advertise 800 merely because registration was configured above 25. Document
this distinction and test supplied limits, rather than claiming that a numeric
option proves enforcement inside an injected bridge.

## 5. Store format, startup and downgrade

### 5.1 Structural bounds and atomic writes

Keep schema version 1. Raise the structural reader bound to 255 secondary
records and the byte bound to **8 MiB**, independent of the configured admission
cap. The maximum path length remains 4096 UTF-16 units and display-name length 256. JSON escaping can require six bytes per unit; simply raising the count
while retaining 256 KiB can create a file that the next startup cannot read.

A read-only serialization probe using 256 maximum-length paths and 255
maximum-length escaped display names produced 6,687,308 bytes. This validates
the format-size rationale for 8 MiB, not filesystem support for those paths.
Before atomic writing, serialize once and check its UTF-8 byte length against
the same bound. Keep bounded reads, no-follow identity checks, permissions,
in-process/file locks, lock ownership and committed-error behavior unchanged.

Within the locked add, require fewer than `maxRegisteredWorkspaces - 1` saved
secondary records before adding a new record; duplicate additions stay
idempotent. Stale or aliased saved records still consume storage slots until
forgotten, even when fewer runtime identities activate. Reading, removing and
renaming an existing supported snapshot must remain possible above the current
operational limit.

### 5.2 Complete merge, then reject overflow

Continue canonicalizing explicit paths and rejecting explicit duplicates and
nesting. Restore valid saved paths with existing reserved/missing/nested skip
rules. Merge canonical aliases and retain every registration ID and display
name according to existing precedence. Check capacity after that complete
valid merge, rather than truncating it at the first full slot.

If the merged count exceeds the configured cap, fail before runtime/listener
publication with the count, cap and instructions to restore the previous cap
and reduce registrations. Leave store bytes untouched. Place this check outside
the existing broad store-read catch, or rethrow a distinct capacity error.
Otherwise it would become the old explicit-only fallback.

This intentionally changes the earlier overflow behavior where extra valid
saved entries were skipped, including when the operator explicitly selects 25. Unrelated malformed/identity-error handling stays as it is, with
failed mutations unable to overwrite the unreadable store.

Map count-limit failures consistently to `409 workspace_limit_reached`,
including persistence failure after temporary runtime construction. Dispose
the temporary runtime and release its reservation. A byte-bound failure should
have a distinct `409 workspace_registration_store_too_large` error and preserve
the file; do not misreport it as exhaustion of runtime slots.

### 5.3 Lowering configuration and rolling back versions

To lower the cap, use the new binary at the previous cap, remove/forget enough
registrations and reduce explicit `--workspace` arguments or the embedded
workspace array as needed, then restart at the lower cap. Explicit startup
workspaces cannot be removed by forgetting saved records. If the lower setting
already prevented startup, temporarily restore the previous value. Missing/nested saved
records can be listed and forgotten because the reader is independent of the
admission limit. No new offline cleanup tool is required.

Before downgrading to a pre-P1 binary, back up the store, use the new binary to
reduce it to **at most 24 secondary records and at most 256 KiB**, stop the
daemon, then start the old binary and verify restoration. Counts alone are not
enough for long or escaped paths. Removing a registration must not delete its
workspace files or transcripts.

An old binary reading an expanded file warns and starts explicit workspaces
only. Its locked mutations re-read and fail before overwriting the file. This
also blocks registration list/forget/persist and can block runtime deletion,
even for a transient runtime, because deletion consults the store. Recovery is
to restart the new binary, not to accept partial restoration as successful
downgrade. A schema bump would not make old readers understand the extra rows.

## 6. Preserve a bounded channel transaction

Keep the existing 2,130,000 ms SDK default and worker start/stop deadlines.
Add an independent channel-control workspace guard of 25, using the same
channel-owned constant as the timeout calculation. If sharing across packages
requires an export, expose that channel-specific policy, never reuse the
deprecated registration-ambiguous `MAX_DAEMON_WORKSPACES` value.

Initial grouping must have at most 25 unique owners. For reconciliation, bound
the union of current entries, retained recovery groups, and effective candidate
owners to 25. Include pending ownership where construction can overlap; validate
inside the existing serialized manager/group lifecycle before creating
supervisors or stopping workers. `forceWorkspaceCwd` must use the effective
partial replacement topology, including preserved owners.

Checking only target count is insufficient. A normal disjoint old25→new25
replacement still fits the old transaction arithmetic: two rounds of
25×(12s stop + 30s start), plus 30s client headroom. But failed cleanup retains
new entries alongside old ones in the group Map; the next transaction could
then exceed 25. The union guard prevents this newly reachable accumulation.

At a full owner set, moving to a new owner requires a prior successful operation
that removes the old owner from selection/recovery, or successful stop-all
followed by a new selection. A temporarily drained owner retained for restore
still occupies capacity. Do not stop unrelated workers automatically to make
room. Stop, remove and shutdown remain available for cleanup. After failed
reconcile/stop, owners still retained in existing entries/recovery maps continue
to count. Preserve the existing permanent-removal and force-kill semantics:
they may detach ownership even when cleanup reports an error. This guard bounds
tracked control/recovery ownership and does not prove OS processes have exited.
Do not introduce a second capacity registry or use failed removal as the
recommended migration procedure.

Cover startup preflight and runtime grouping, initial start, set, enable,
reload, qualified reload, registration/trust refresh and restore. Scan all
registered workspaces to resolve ownership, ambiguity and trust; do not inspect
only the first 25. Reject capacity expansion before lease/supervisor/lifecycle
effects. For named startup selections with more than 25 registered workspaces,
run the owner-count preflight before the boot lease reservation. Smaller sets
cannot exceed the owner cap; retain their existing validation/cleanup timing
and the later runtime/trust validation for every startup. In manager
selection, check initial owner count after resolution and before `reserve()`.
The group constructor alone is too late because the manager reserves first.
For an existing group, calculate the effective union inside `reconcile` before
its `createEntry` loop; restore checks before `createEntry` as well.

Preserve a specific `channel_control_workspace_limit_reached` error through
both manager `classifyFailure` and group-constructor error wrapping, then map
it to 409 in both HTTP route families. Recognize this specific capacity error
before ordinary start/stop classification; leave unrelated error mapping alone.

The guard bounds channel control and recovery ownership, not ACP child count
or physical process memory. Existing unbounded request-queue waiting remains:
the old timeout is a single-transaction budget, not a promise that arbitrary
concurrent callers finish before their deadlines.

Do not change channel settings into a cross-workspace transaction. Offline
configuration and startup-selection persistence remain possible. Existing
active upsert saves first, then reloads; reload failure can become a diagnostic
while the save returns success. Runtime-added refresh can likewise fail after
registration succeeds. Preserve and test these distinctions: saving or
registering does not certify that a channel started successfully.

## 7. API ownership and compatibility

| Surface                                                           | Ownership and P1 change                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /capabilities`, `GET /daemon/status`                         | Process-global. Add `limits.maxRegisteredWorkspaces`. Standard `runQwenServe` also advertises `maxChannelControlWorkspaces=25` during bootstrap and full operation, regardless of whether a worker has started. Custom embeds advertise it only when their control/management callbacks actually enforce the same guard. Keep boot/full status consistent. |
| Session limits in capabilities                                    | Process-global. In expanded mode advertise the supplied `maxTotalSessions` even with one workspace; do not wait for a second registry entry.                                                                                                                                                                                                               |
| `POST /workspaces`, scratch/owned publication                     | Process-global registration admission; canonical identity, trust, runtime environment and reservations stay unchanged.                                                                                                                                                                                                                                     |
| `/workspace-registrations` list/forget                            | Persisted-workspace scope; structural read bounds are independent of active runtime count.                                                                                                                                                                                                                                                                 |
| Workspace runtime delete and display-name changes                 | Selected-runtime plus its associated persisted registration IDs; preserve drain, rollback and committed-write rules.                                                                                                                                                                                                                                       |
| `PUT/DELETE /workspace/channel`, `POST /workspace/channel/reload` | Process-global despite the legacy-looking path; enforce the channel owner guard in lifecycle code.                                                                                                                                                                                                                                                         |
| `/workspace/channels/:name/...`                                   | Legacy-primary management; preserve primary ownership.                                                                                                                                                                                                                                                                                                     |
| `/workspaces/:workspace/channels/:name/...`                       | Selected-runtime management; exact owner, trust and environment checks remain mandatory, with no primary fallback.                                                                                                                                                                                                                                         |

Extend daemon and TypeScript SDK capability/status types additively without a
protocol version bump. Old clients ignore new fields; new clients treat absence
as unknown and use server admission responses. Java's raw capability map stays
compatible. No new UI control or timeout negotiation is needed. Existing SDK
explicit deadlines and `timeoutMs: 0` retain their meaning.

## 8. Delivery and affected areas

Implement in three reviewable increments; only the last exposes expansion:

1. **Channel boundary:** channel group/manager guard, startup preflight and error
   mapping, additive capability, and rollback/degraded-state tests. Validate
   the full 25-owner transition before relying on the unchanged SDK timeout.
2. **Store preparation:** structural count/byte bounds, pre-write byte check,
   complete startup merge/overflow failure, lowering/downgrade documentation
   and tests. Registration admission remains 25 during this increment.
3. **Registration expansion:** default 256, resolver, operator-only environment handling,
   explicit embedded option, all admission/store consumers, expanded default
   total sessions, capabilities/status, documentation and target-host E2E.

These can be commits or separate PRs; expansion must depend on both preceding
increments. Default 256 is the requested policy; deployment resource limits
still require workload evidence. Accepting
disjoint channel owner migrations without a release step would require a
separate degraded-recovery design rather than weakening the union guard.

Expected production areas are `workspace-inputs.ts`, `run-qwen-serve.ts`,
`server.ts`, `types.ts`, `daemon-status.ts`, registration store/routes,
`config/shared-env-keys.ts`, channel group/manager and their route mappings,
the channel timeout policy, and SDK capability/status types. Synchronize
daemon protocol/configuration documentation and collocated tests. Existing
session admission mechanics should need no new algorithm.

## 9. Validation and unresolved deployment evidence

The executable plan and global dry-run results are recorded separately in
`.qwen/e2e-tests/workspace-capacity-p1.md`. This task's dry-run demonstrates
pre-implementation gaps. It does not validate proposed behavior or make the
historical measurements current production benchmarks. On 2026-09-09, five
isolated runs against global effective CLI 0.23.0 confirmed that the proposed
variable is ignored: 2 still permits a third registration, 256 still rejects
the 26th, and abc still boots. Unset-variable startup with two workspaces
advertises a total session limit of 64; adding a second dynamically advertises
null. All five daemons exited normally and released their ports/process groups.
This older global binary is distinct from the main source baseline; it only
establishes the pre-implementation gap. The local 0.23.1 implementation passed
seven E2E groups covering 256/257 registration, 255 named persisted records and
restart, lower-cap startup rejection without file changes, old-reader mutation
protection, invalid configuration, project-environment isolation, scratch and
last-slot races, and explicit session-limit overrides. Channel lifecycle and
rollback boundaries are verified with fake supervisors in unit tests; real
provider channel operation remains separate deployment validation.

Acceptance requires configuration provenance/precedence, all admission paths,
final-slot races, 256/257 boundaries, persisted round-trip with aliases/names,
unchanged file hashes on rejection, new/old-reader downgrade, session
reservations across all owned bridge types, and the channel recovery cases
above. Run unit tests within each package and build/typecheck/bundle before
testing a changed local binary.

Deployment validation must separately cover Linux/container limits, real Git
repositories, FD/watchers, startup and list/Git latency, a full default
10-minute keepalive interval, repeated registration churn, enabled cron/channel,
and Web Shell/SSE/terminal behavior. Separate registered-runtime costs from
fixed active-child workloads. A global 800-session default does not provide
memory enforcement.

Remaining evidence-dependent decisions are deployment-specific resource
thresholds and whether measured runtime costs justify LRU. The P1 contract
selects one environment variable, default and maximum 256, a total-session
default of 800 at registration capacities above 25, explicit startup overflow
failure, bounded channel ownership and a documented downgrade. The default
change is verified separately in `.qwen/e2e-tests/workspace-capacity-default256.md`;
earlier default-25 results remain historical evidence.
