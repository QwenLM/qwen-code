# Hosted public Workspace admission (G0)

[English](2026-09-29-hosted-public-workspace-admission.md) | [简体中文](2026-09-29-hosted-public-workspace-admission.zh-CN.md)

Status: implemented; under review. Part of #12952 and #12380.

## Problem and scope

Hosted Read/Write/Edit already runs through the production Broker and worker,
but only private integration tests connect it to a persisted Workspace Session.
Public creation rejects an initial input in both the service and SQL store; the
coordinator also rejects bound Sessions. The Java connector sends no tool profile
and uses the deployment's global Workspace for every Session Store connection.

G0 enables one initial file-tool Turn admitted with Session creation. It uses
the existing public REST route and the WebShell creation adapter that shares its
service. Discovery continues to advertise only
Workspace binding, not complete Workspace execution support. G0 requires no UI
changes; the follow-up's only UI changes are enabling the creator's composer and
its Cancel control.

A follow-up admits later Turns for the Session's creator under the same opt-in,
and lets the creator cancel a running Turn, which the Hosted Harness aborts and
settles through the original Runtime identities. Execution authorizes every
Turn against the creator's Workspace grants, so any other actor, and every
deployment without the opt-in, keeps the existing refusal:
`workspace_unavailable` when the actor can read the Workspace,
`session_not_found` when they cannot. The creator may also rename the Session.
Admitting new work requires the creator's create grant on an `ACTIVE`
Workspace at the generation and storage the Session was bound to, so a
re-registration refuses submit and rename before any command is written.
Cancelling only aborts work already running: while the deployment still enables
Workspace files, the creator who can still read the Workspace may cancel even
after the create grant is revoked, the Workspace starts draining or it is
re-registered. A live cancel reuses the running Turn's resident attachment.
A cold connector cache re-attaches for the persisted cancellation, validating
its frozen Session binding and exact tenant/Session identity without requiring
mutable creation grants, registry state or mount readiness. New API requests
still require the creator's read grant; a cancellation already accepted keeps
retrying if that grant is later revoked. New work always rechecks execution
authority, including when physical recovery is disabled. Passive load of a
resident Harness Session returns the original client identity after validating
its tenant, Workspace, Session Store URL and frozen profile. It does not reopen
the writer or drive work; an inactive parked Runtime Turn is reported again if
a prior load reply was lost. Passive recovery may adopt the original Runtime
and query status, but does not prepare or execute work. On the cancellation
path, the adopted lease stays owed through lost replies and retryable refusals
until terminal success or teardown. This does not prove recovery after Broker/worker
process death or resolve an original prompt admission whose reply was lost.
A cancel the Harness did not take is re-sent while the Turn is still cancelling. After each
successful lease renewal, the running owner observes cancellation requested
through any API replica and sends it on the executor, keeping network waits
off the lease scheduler. Failed deliveries retry at the lease renewal interval.
Workspace close follows its separate close capability and lifecycle admission.
Archive, delete and unarchive follow the separate retention capabilities after
reliable Workspace close. Cwd operations remain gated for bound Sessions.

## Decisions

- A deployment explicitly enables `harness.workspace-files-enabled` (environment
  variable `QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED`), defaulting to false.
  It requires the Hosted Harness, HTTP Session Store and same-host, Session-
  isolated local-process Broker. Existing unbound no-tool Sessions are unchanged.
  Disabling the opt-in refuses input-bearing creation, including retries; empty
  bound creation and read access remain available.
- Only `qwen-code` and the already supported, frozen
  `managed-runtime-tools/1` / `preapproved-workspace-tools/1` Workspace pair are
  admitted. The server selects `hosted-workspace-files/1`. Public requests cannot
  select a profile or raise their privileges through metadata.
- Workspace resolution, ACTIVE state, creator read/create grants, fixed profile
  checks, Session creation, initial Turn and actor-scoped idempotency remain in
  the existing creation transaction. Replays preserve the original identities
  and binding; changed payloads conflict.
- Before attaching a bound Session for new work, the connector rechecks the persisted binding
  through `WorkspaceExecutionStore.authorize`. Broker acquisition and execution
  retain their own grant, generation, storage and ownership checks. No failed
  binding falls back to the global Workspace or an unbound no-tool Session.
- Private create and load both carry the selected profile and the persisted
  Workspace ID. This includes create-conflict and uncertain-create fallback to
  load. The Harness's existing immutable definition check pins the profile.
- Cold load of unsettled input remains blocked. G0 does not enable in-flight
  continuation, adopt workers, remove affinity or change the G1 failover gates.

- A cancellation reuses its admitted Harness attachment or passively re-attaches from a cold connector cache and is retried by the current lease owner. It never certifies a terminal failure from a fresh attach refusal. Recorded rename failures retain a `FAILED` command receipt and digest; same-content retries are replays, conflicting content remains rejected, and a concurrent success can complete the retained receipt.

## Changes and ownership

| Layer                               | Change                                                                               | Scope                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| Java configuration                  | Explicit file admission opt-in and dependency validation                             | Deployment                               |
| Creation service and SQL store      | Admit initial input only under fixed, authorized Workspace configuration             | Tenant, creator and persisted Workspace  |
| Coordinator                         | Dispatch admitted bound Turns only when the opt-in is enabled                        | Persisted Session and leased Turn        |
| Java connector and private SDK DTOs | Resolve the Session binding and pass the profile on create/load                      | Persisted Session and live Harness owner |
| Hosted private load route           | Reuse resident connection after frozen identity checks; report parked Turn passively | Live Session owner                       |
| Existing Broker/worker              | Reuse production routing and fencing                                                 | Selected Runtime and persisted Workspace |
| Contract and README                 | Document the narrow creation capability and remaining gates                          | Public REST and WebShell adapter         |

Production behavior changes under `packages/sdk-java/managed-agent-server`, in
the private Hosted DTOs in `packages/sdk-java/qwencode`, in the CLI Hosted Session routes (`packages/cli`), and in the WebShell
managed Sessions page and its providers (`packages/web-shell`); it covers the
initial Workspace Read/Write/Edit Turn and the creator's later-Turn submit,
cancel and rename admission. No core authority, tool
execution loop, database schema or public request field needs a new
abstraction.

The merged change also touched two places outside that scope, neither of which
adds runtime behavior:

- **Runtime Broker fault gate.** `DurableLocalRuntimeFaultGateTest` holds the
  worker's `execute` response in its fault proxy, so the first Broker cannot
  record the result before it is killed. The replacement Broker's `acquire`
  then settles the call through the takeover reconciliation of #12964, and the
  test asserts that outcome (`ALREADY_SETTLED`, one physical execution)
  instead of accepting either a settled or a resolved state, which depended
  on timing.
- **Core resume test.** One `background-agent-resume.test.ts` case reports
  the Skill tool as registered so that its listing assertion does not pass
  vacuously. The override is still present on `main`.

## Validation and acceptance

Use a deterministic local model and the packaged CLI with a real Spring
coordinator, SQL Store, configured production Broker and separate worker. Only
the model and trusted gateway principal are fixtures. Seed Workspace registry
and grants as deployment data; create Sessions exclusively through public HTTP.

The initial Turn must write, edit and read a file under the selected Workspace
and relative cwd, produce durable tool history and exactly one public terminal
event, and leave the Harness's decoy directory untouched. Repeat the creation
key and verify the same Session/Turn and no extra model/tool effects. Verify a
different payload conflicts, unauthorized tenants/actors cannot create or read,
unsupported profiles and unavailable Workspaces refuse, and disabling the
opt-in preserves the current gate. Exercise the shared WebShell create adapter,
the later-operation gates that changed (the creator's later-Turn submit, cancel
and rename are admitted; close and retention follow their separate capabilities,
while cwd remains gated), and unbound
no-tool regression paths.

Focused SDK serialization, connector, store/admission and coordinator tests
cover create/load identity, authorization rechecks and disabled gates. The real
Hosted stack must cancel after creation authority is revoked and the connector
cache is cleared; generation-only and storage-only drift must refuse new work
before any command is written. New cancellation requests after read revocation
must remain hidden, while previously accepted cancellations still retry. Run the
Hosted integration on H2 locally and include it in the existing Hosted MySQL CI
suite. Record separately whether local MySQL is available. Build, typecheck,
bundle, focused tests and two clean diff audits precede completion.

## Boundaries and open questions

G0 lives under #12952 for this implementation; moving its tracking to D or W does
not change the contract. This does not settle G3 scope. Shell, approvals, D8
AgentDefinition, public profile selection, later Turns (since admitted for the
creator, above), lifecycle enablement,
distributed provisioning and W0e/G1–G3 recovery remain separate. The existing
`EmbeddedRuntimeBroker` is a production component and remains allowed; the E2E
must not replace it or bypass admission with direct store calls.

The late-rename supersession check protects the public SQL title and receipt.
It runs after the Harness title write, so it does not order overlapping Harness
writes. That inherited lifecycle issue remains tracked in #13269.
