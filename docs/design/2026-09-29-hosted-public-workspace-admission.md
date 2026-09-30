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
service. Later submit, cancel, rename, lifecycle and cwd operations retain their
existing Workspace gates. Discovery continues to advertise only Workspace
binding, not complete Workspace execution support. No UI changes are required.

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
- Before attaching a bound Session, the connector rechecks the persisted binding
  through `WorkspaceExecutionStore.authorize`. Broker acquisition and execution
  retain their own grant, generation, storage and ownership checks. No failed
  binding falls back to the global Workspace or an unbound no-tool Session.
- Private create and load both carry the selected profile and the persisted
  Workspace ID. This includes create-conflict and uncertain-create fallback to
  load. The Harness's existing immutable definition check pins the profile.
- Cold load of unsettled input remains blocked. G0 does not enable in-flight
  continuation, adopt workers, remove affinity or change the G1 failover gates.

## Changes and ownership

| Layer                               | Change                                                                   | Scope                                    |
| ----------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Java configuration                  | Explicit file admission opt-in and dependency validation                 | Deployment                               |
| Creation service and SQL store      | Admit initial input only under fixed, authorized Workspace configuration | Tenant, creator and persisted Workspace  |
| Coordinator                         | Dispatch admitted bound Turns only when the opt-in is enabled            | Persisted Session and leased Turn        |
| Java connector and private SDK DTOs | Resolve the Session binding and pass the profile on create/load          | Persisted Session and live Harness owner |
| Existing Broker/worker              | Reuse production routing and fencing                                     | Selected Runtime and persisted Workspace |
| Contract and README                 | Document the narrow creation capability and remaining gates              | Public REST and WebShell adapter         |

Production behavior changes only under `packages/sdk-java/managed-agent-server`
and in the private Hosted DTOs in `packages/sdk-java/qwencode`; it stays limited
to the initial Workspace Read/Write/Edit Turn. No core authority, tool
execution loop, database schema or public request field needs a new
abstraction.

The merged change also touched three places outside that scope, none of which
adds runtime behavior:

- **Generated WebShell types.** `packages/web-shell` regenerates
  `managed-agent-api.ts` from the updated OpenAPI descriptions; only the
  documentation comments change.
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
unchanged later-operation gates, and unbound no-tool regression paths.

Focused SDK serialization, connector, store/admission and coordinator tests
cover create/load identity, authorization rechecks and disabled gates. Run the
Hosted integration on H2 locally and include it in the existing Hosted MySQL CI
suite. Record separately whether local MySQL is available. Build, typecheck,
bundle, focused tests and two clean diff audits precede completion.

## Boundaries and open questions

G0 lives under #12952 for this implementation; moving its tracking to D or W does
not change the contract. This does not settle G3 scope. Shell, approvals, D8
AgentDefinition, public profile selection, later Turns, lifecycle enablement,
distributed provisioning and W0e/G1–G3 recovery remain separate. The existing
`EmbeddedRuntimeBroker` is a production component and remains allowed; the E2E
must not replace it or bypass admission with direct store calls.
