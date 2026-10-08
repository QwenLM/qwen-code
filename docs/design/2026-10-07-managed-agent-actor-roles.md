# Managed Agent actor roles and tenant-isolation acceptance

[English](2026-10-07-managed-agent-actor-roles.md) | [简体中文](2026-10-07-managed-agent-actor-roles.zh-CN.md)

Issue: #13535 (R1 actor roles, R2 isolation acceptance). Parent: #12380 production
enablement. Vocabulary source: #12867 section 10 (`reader`, `operator`, `owner`;
`404` without read, `403` with read but without operate; idempotency domain
includes the actor — the last part already landed with D4). This design answers
#12867's open question Q4 (where roles come from) and defines the surface
registry plus its build gate.

Verified at `main` = `ac497aeed9` (one commit past the `b585508733` baseline the
issue names; the delta is a TUI change outside this module).

Status: slice A (#13543) lands the registry and its gates over today's
admission. The V48 storage in D2/D3 lands with slice B (#13544) and the
enforcement in D4/D7 with slice C (#13545); until those merge, their sections
describe planned changes, not the tree.

## 1. Problem

Two gaps, different in kind:

- **R1 — no role vocabulary.** Every bound-Session operation admits only its
  creator and answers anyone else with `404` or `403`. `AuthenticatedTenantActor`
  carries `tenantId()` and `actorId()` and nothing else. Two product behaviours
  are blocked today: a second operator on the same Workspace cannot answer an
  approval that blocks a Turn, and a Workspace-bound Session cannot be handed
  over because nothing expresses an owner distinct from the creator.
- **R2 — no systematic acceptance.** Admission coverage arrived slice by
  slice, per merged capability. For the 56 public and WebShell routes the API
  contract test already fails a mapped route that the OpenAPI contract lacks,
  and fires a cross-tenant probe at every contract operation. Nothing gates
  the original slice-A baseline's 22 internal routes, nothing probes a caller below read or with read but
  without the family's power, and nothing ties a route to the admission rule
  it should follow — so a route can land with the wrong check and every test
  stays green, which is the failure mode that matters most while this surface
  is still growing quickly.

## 2. Current state

Identity is `(tenantId, actorId)` only, supplied by trusted filters
(`SignatureAuthFilter` in SIGNED mode, `TrustedActorHeaderFilter` as the
OPEN-mode stand-in); the `AuthenticatedTenantActor` contract is unchanged by
this design.

Authorization today is grant rows plus a creator record:

- `managed_workspace_access(tenant_id, workspace_id, actor_id, can_read, can_create)`
  (V8) — the only per-actor grant table, read on every Workspace-bound route.
  Its domain enum is `WorkspaceAccess` (NONE/READ/CREATE, CREATE implies
  READ) in the runtime-broker module.
- `managed_agent_session.creator_actor_key` (V40) plus
  `managed_workspace_create_command` (V9, the idempotency-command record) —
  two copies of "creator".

"Creator-only" is three mechanisms with three refusal vocabularies:

| Family                                                     | Routes                                                                                                                             | Check                                                                                     | Readable non-creator gets         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| Turn submit / cancel / rename                              | public `POST …/events` (submit and cancel), `PATCH …/{id}`; WebShell `turns/submit`, `turns/cancel` (rename has no WebShell route) | `requireSubmitter` → `maySubmitWorkspaceTurn` (create-command row + current `can_create`) | **409 `workspace_unavailable`**   |
| Lifecycle (close, archive, unarchive, delete) + cwd change | `POST …/close` / `…/archive` / `…/unarchive`, `DELETE`, `POST …/cwd`, WebShell twins                                               | `requireWorkspaceCreator` (can_read then create-command row)                              | 403 `session_operation_forbidden` |
| Action (approval) respond                                  | `POST …/actions/{id}/responses`, WebShell `actions/respond`                                                                        | `requireOwner` (creator_actor_key, create-command fallback)                               | 403 `action_forbidden`            |

Other rule shapes as implemented: bound reads and all list/stream/catalog
routes require `can_read` (404 otherwise); bound create requires actor +
`can_create` + `ACTIVE` workspace (401/404/403/409 by failure); artifact byte
reads add a deployment policy gate (`403 artifact_content_forbidden`);
workspace discovery lists only `can_read` rows (401 without actor); legacy
(unbound) Sessions and agent definitions are **tenant-wide** — any actor in the
tenant may mutate them today; internal store/publication routes admit a writer
HMAC credential, not an actor. The public surface is `/v1/agents/**` plus
`/api/agent/web-shell/v1/**` (`PublicSurface`), realised by ten Spring
controllers — the section-10 matrix enumerates the current 32 public + 24
WebShell + 24 internal routes (80 in total, including the two L3 authorization
routes, counted by the gate).

There is no production provisioning of workspace registry/access rows —
today only tests and fixture entry points write them, and a deployment writes
them out-of-band; there is no role, owner, or per-tenant actor table
anywhere.

## 3. Decisions

### D1 — role vocabulary

Three roles, ordered NONE < READER < OPERATOR < OWNER, with the meaning
#12867 section 10 fixed:

- **READER** — may read but not answer: every read the actor can perform
  today, nothing more.
- **OPERATOR** — READER plus "may operate but not delete": submit and cancel
  Turns, rename, change cwd, create Sessions on the Workspace, and answer its
  Actions (approvals). This is the fix for the blocked approval handoff.
- **OWNER** — OPERATOR plus lifecycle: close, archive, unarchive, delete.

The refusal contract is #12867's: no read grant → `404`; read but insufficient
operate → `403`, named per family (`session_operation_forbidden`,
`action_forbidden`). The `409 workspace_unavailable` anomaly on the submitter
family is removed (section 6).

### D2 — roles belong to the Workspace binding

Q4's answer: a grant table, keyed `(tenant_id, workspace_id, actor_id)` — the
`managed_workspace_access` table that already exists and already sits on every
bound route's read path. Not gateway claims: the `AuthenticatedTenantActor`
contract stays tenant + actor, and per-workspace grants do not fit in a claim
set. Not Session-keyed: a Session-keyed table multiplies rows by
sessions × actors and would need a fan-out insert at every creation for a set
of actors the server cannot enumerate; the blocking behaviours are defined by
who shares the _Workspace binding_. Not tenant-keyed: it cannot express
"reader on A, operator on B".

Concretely, migration V48 replaces the two booleans with one column:

```sql
ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'READER';
-- A row without can_read grants nothing today; keeping it would gain
-- READER (or OPERATOR, for a can_create row) through the backfill.
DELETE FROM managed_workspace_access WHERE can_read = FALSE;
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK (role IN ('READER', 'OPERATOR', 'OWNER'));
```

The compound shapes are split into per-action statements, matching the
in-repo migration precedent (V7, V12, V24, V40); dropping unreadable rows
before the backfill is what makes the change purely a relabelling for every
reachable grant row. `role` is the single stored vocabulary; no
dual-write. The `WorkspaceAccess`
enum becomes `NONE / READER / OPERATOR / OWNER` (READ→READER,
CREATE→OPERATOR); `OWNER` implies `OPERATOR` implies `READER`. Every store
reader (`canRead`, `findReadable`, `listReadable`, `canCreateSession`,
`resolveForCreation`, `authorizePassiveAttachment`, the SSE read-grant
recheck, the list-route SQL filter) keeps its current decision with the
booleans re-derived from `role` — a behaviour-invisible internal change that
the existing suite pins. `NONE` is not storable (the CHECK excludes it); it
remains the domain value for "no row".

Grant provisioning stays out-of-band, exactly as the booleans are provisioned
today: fixture/deployment SQL writes rows; no HTTP grant-management route
appears in this slice (section 7).

### D3 — the Session record keeps an owner, defaulting to its creator

V48 also adds `managed_agent_session.owner_actor_key VARBINARY(2048) NULL`
and backfills it from `creator_actor_key`. Three identity facts stay
deliberately separate:

- the **record** (Session row) holds the owner — one actor, initially the
  creator;
- the **binding** (workspace grant rows) holds what each actor of the tenant
  may do on Workspaces;
- the **role** is the vocabulary the admission path consults — for
  Session-scoped checks, the Session's owner acts with OWNER rights on that
  Session regardless of workspace grants, which preserves today's creator
  behaviour exactly.

`managed_workspace_create_command` remains what it is — an idempotency-command
record whose `actor_id` belongs to the idempotency domain, not to
authorization. After V48 the authorization reads of it (the NULL-creator
fallbacks in `requireOwner` / `requireWorkspaceCreator`) survive only for
sessions created before V40; new sessions always carry creator and owner.

An owner update path (the handover command) is a follow-up slice on top of
this column; this slice creates the vocabulary and the storage the handover
needs, and re-points every creator check at the owner (section 7).

### D4 — route reclassification

Minimum role per implemented route family on the bound-Session surface
(behaviour for previously-admitted callers is preserved: create-grant holders
map to OPERATOR, creators map to owner):

| Family                                                                    | Rule today                                      | Rule after                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| Session/Turn/Item/task/Action/event reads, JSON+SSE, catalogs, transcript | `can_read` (404 without)                        | READER (404 without) — unchanged                                      |
| Bound Session create                                                      | actor + `can_create` + ACTIVE (401/404/403/409) | actor + OPERATOR + ACTIVE — unchanged callers                         |
| Turn submit / cancel / rename                                             | creator + current `can_create`, 409 on refusal  | OPERATOR; refusal becomes 403 `session_operation_forbidden`           |
| cwd change                                                                | creator, 404/403                                | OPERATOR, 404/403                                                     |
| Action respond                                                            | creator, 403 `action_forbidden`                 | OPERATOR, 403 `action_forbidden` — **second operator can now answer** |
| close / archive / unarchive / delete                                      | creator, 404/403                                | Session owner, 404/403 — unchanged callers                            |
| Artifacts (metadata)                                                      | actor + `can_read`                              | actor + READER — unchanged                                            |
| Artifact content bytes                                                    | actor + read + deployment policy                | actor + READER + policy — unchanged                                   |
| Workspace discovery list/get                                              | actor, filtered by `can_read`                   | actor, filtered by role ≥ READER — unchanged                          |
| Legacy (unbound) Session routes                                           | tenant-wide                                     | tenant-wide — unchanged (section 7)                                   |
| Agent definitions                                                         | tenant-scoped                                   | tenant-scoped — unchanged                                             |
| Internal store / tool-publication routes                                  | writer HMAC, no actor                           | unchanged                                                             |

Live behaviour that re-reads grants (SSE read-grant recheck, mid-stream
artifact revalidation, execution-time `authorizePassiveAttachment`) consults
`role` with identical thresholds, so revocation keeps its current meaning.

### D5 — the versioned surface registry

One enum in the server module's test tree — `api/SurfaceRegistry.java`, one
constant per implemented route — carrying: HTTP method, path template, surface (PUBLIC /
WEBSHELL / INTERNAL), capability id (shared by the public/WebShell twins of
one capability, e.g. `TURN_SUBMIT`), and rule class (`legacy_create`,
`legacy_tenant`, `workspace_create`, `reader`, `reader_actor`,
`reader_actor_policy`, `operator`, `owner`, `workspace_discovery`,
`tenant_scoped`, `internal_writer`). This single file is the
issue R2 enumeration: per route it states which actor may read, mutate,
cancel, answer or delete. It is versioned exactly as the surface is versioned
— registry changes ride the contract version they implement (the R1 flip is
v1.34), so `git blame` of the registry is the authoritative per-route history.

The registry lives under `src/test/java` because nothing in production reads
it: the gate and the acceptance probes below are its only consumers, in this
slice and in slice C, whose enforcement reads the stored roles. It moves to
`src/main` only if a runtime consumer appears.

It does not replace the OpenAPI contract
(`managed-agent-public-api.openapi.json`), which stays the single source for
the published shape of the 56 public and WebShell routes and which the API
contract test keeps in bijection with the mounted handlers. The rule class is
deliberately not an `x-qwen-*` extension on the spec: the spec is the
published, machine-consumed contract (the WebShell client types are generated
from it), it does not describe the 24 internal routes, and an admission rule
class is a server-internal classification. A new public or WebShell route is
therefore named three times — controller, spec, registry — and each pairing
is gated: the contract test fails a route the spec lacks, and the
correspondence gate fails a route the registry lacks.

### D6 — the build gate

Two test classes make the enumeration load-bearing:

1. **Correspondence gate.** A Spring test resolves every
   `RequestMappingHandlerMapping` in the module's application (with the
   conditional internal controllers enabled) and asserts a bijection with the
   registry: an implemented handler with no registry entry fails the build —
   a new route cannot silently skip the check; a stale entry for a removed
   route fails too.
2. **Acceptance probes.** A parametrized test walks the registry and, per
   rule class, fires the standard probe set — wrong tenant, no actor, role
   just-below, exactly-enough, cross-tenant principal — asserting the route's
   statuses against the declared rule (404-below-read, 403-below-operate,
   2xx-admitted shape specific to the family). Probes run both surfaces
   through one fixture graph (workspace rows, bound and legacy sessions, a
   pending Action, an artifact, task records), reusing the existing fixture
   patterns.

Cross-surface parity is structural, not hopeful: registry entries sharing a
capability id must share a rule class, and the probe run covers each twin,
so a public route and its WebShell twin cannot drift apart.

### D7 — WebShell capability advertisement follows roles

The per-caller capability advertisement (`workspaceTurns` and friends in the
create/get session views) is computed from the caller's role, not from
creator identity: OPERATOR-or-above sees turn submission and cancel
capabilities, the Session owner sees lifecycle capabilities. The UI's
composer/cancel exposure stays a mirror of server admission — the parity
assertion in D6 covers the rule; existing WebShell coverage covers the
advertisement.

## 4. Delivery plan

Three slices, two parallel lanes then one closing lane. Lane split follows
file-scope disjointness, not topic:

| Slice                              | Content                                                                                                                                                                                                                                             | Touches                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **A — registry + gate (R2 first)** | `SurfaceRegistry` over today's rules, correspondence gate, acceptance probes, parity assertions, bilingual route matrix in this doc                                                                                                                 | new test-tree files only: `api/SurfaceRegistry.java`, the gate and its negative twin, the acceptance probes; no production edits |
| **B — role storage (R1 storage)**  | V48 migration + backfill, `WorkspaceAccess` rename, registry store reads re-derivd from `role`, `owner_actor_key` column + write at creation, fixture INSERT updates (~24 sites), migration-shape tests                                             | `store/**`, `runtime-broker` enum, `db/migration`, test fixtures; no admission-decision change                                   |
| **C — enforcement (R1)**           | the three creator helpers re-pointed at role/owner, refusal-code normalisation, Action respond opens to OPERATOR, WebShell capabilities by role, registry rule flips, probe expectation flips, contract v1.34 + OpenAPI text, contract-test updates | `service/**`, `store/**` checks, controllers, contract, A's enum + tests                                                         |

A ∥ B is safe: disjoint files (A adds; B edits store-side). C is serial after
both merge because it rewrites both A's registry entries and B's helpers —
this is the one genuine blocking dependency, and it is sequenced rather than
raced. C closes #13535; A and B reference it.

## 5. Migration and compatibility

- V48 follows the established single-version doctrine (stop old servers
  before the migration; no `outOfOrder`). Taking V48 requires renumbering any
  open branch's later migration; `scripts/check-flyway-migrations.js` already
  gates numbering across both migration locations.
- Contract v1.34 records: the role vocabulary, OPERATOR admission for the
  submitter and Action families, owner-based lifecycle, the submitter-family
  refusal change 409 `workspace_unavailable` → 403
  `session_operation_forbidden`, and role-based capability advertisement.
- Refusal-code changes a client can observe: non-creator submitter on a bound
  Session (409 → 403); Action respond now succeeds for OPERATORs that are not
  the creator. Everything else is caller-preserving.
- Test fixtures writing `can_read`/`can_create` move to `role` in slice B;
  the generated-columns alternative was rejected to keep one source of truth
  and H2/MySQL parity simple.

## 6. Scope boundaries

Same as the issue's, plus the explicit deferrals named there:

- Legacy (unbound) Sessions stay tenant-wide this slice. Hardening them
  (they already record a creator since V40) is a named follow-up; widening R1
  to legacy would double this slice's blast radius without fixing a named
  product block.
- No handover command: `owner_actor_key` and the role checks it trips land
  here; the transfer operation (idempotent command, owner-only admission,
  audit event) is its own slice and issue.
- No HTTP grant-management routes (`actor_manager` provisioning): workspace
  grants arrive through out-of-band provisioning today, and this slice
  extends that same channel with the `role` column. If deployments need
  HTTP-managed grants, that is a control-plane slice of its own, including
  its expiry semantics — grant rows live and die with the workspace binding,
  never with a Session.
- No change to how `AuthenticatedTenantActor` is supplied, no SIGNED-mode
  claim additions, no `java_durable` admission, no capacity limits, no
  Stage F fault gates.

## 7. Validation plan

- Slice A: the correspondence gate fails on an unregistered route, typed or
  untyped, and on a registered route nothing mounts — a committed negative
  test keeps proving both; probes pin today's statuses per rule class on
  public, WebShell and internal routes.
- Slice B: migration-shape test applying V48 over V47 fixtures asserts the
  backfill (can_create → OPERATOR, can_read-only → READER, owner := creator);
  the full existing suite stays green untouched except fixture INSERTs —
  that is the behaviour-invisibility proof.
- Slice C: updated probes and contract tests pin the new matrix; targeted
  tests: second-operator answers a pending approval on both surfaces,
  OPERATOR submits/cancels/renames/changes cwd, owner lifecycle unchanged,
  readable stranger keeps 404, role revocation flips admission mid-stream
  (SSE window) as before; MySQL parity via the failsafe profiles
  (`mysql-integration`, `hosted-harness-mysql`) where fixtures allow.
- Cross-surface parity is asserted twice: structurally (registry capability→
  rule class) and behaviourally (probe twins).

## 8. Acceptance criteria

- [ ] Every implemented public, WebShell and internal route appears in
      `SurfaceRegistry`; an implemented route missing from the registry —
      or a stale entry for a removed route — fails the build (R2).
- [ ] Per-rule-class probe matrix passes on both surfaces, including the
      404-below-read / 403-below-operate contract (R2, #12867 semantics).
- [ ] A second OPERATOR on the Workspace answers a pending approval on the
      public route and the WebShell route (R1's blocked behaviour #1).
- [ ] `owner_actor_key` exists, defaults to creator on new bound and legacy
      creations, and drives every former creator check (vocabulary for
      handover ready; the command itself is follow-up) (R1's blocked
      behaviour #2, storage half).
- [ ] Contract v1.34 documents the roles, the refusal normalisation and the
      capability-advertisement rule; the OpenAPI changelog names them.
- [ ] Full managed-agent-server suite green on H2; `mysql-integration`
      profile green where the runner offers MySQL.

## 9. Open questions for review

1. Lifecycle stays Session-owner-only; should a workspace-OWNER grant also
   admit lifecycle on every Session bound to that workspace (admin model)?
   This design keeps today's caller set; flipping it later is one line per
   helper plus probe expectations.
2. Legacy Session hardening — schedule with the handover command, or wait
   for a product ask?
3. If deployments ask for HTTP grant management, does `actor_manager` expire
   with the three copies (session record, grant rows, command rows) or is it
   a fourth, tenant-scoped record? Left open deliberately with provisioning
   out of scope.

## 10. Surface route matrix (the slice-A registry, bilingual summary)

`api/SurfaceRegistry.java` integrated with L3 carries 80 route constants: 32
public + 24 WebShell + 24 internal handler methods of the ten controllers,
including the two L3 authorization routes.
The gate derives everything from scanning, so the count is information, not
an asserted constant.

Rule classes name today's admission: `WORKSPACE_CREATE` (2), `READER` (24),
`READER_ACTOR` (6), `READER_ACTOR_POLICY` (1), `OPERATOR` as today's
submitter family (4), `OWNER` as today's creator families — lifecycle and
cwd plus Action respond — (12), `WORKSPACE_DISCOVERY` (4), `TENANT_SCOPED`
(3), `INTERNAL_WRITER` (24). The design's `legacy_create` and
`legacy_tenant` names are kept in the class documentation as the names of
the legacy arms: a route carries exactly one rule class and, per the
separation rule, it is the bound-Session one. Slice C flips cwd and Action
respond `OWNER` → `OPERATOR`, rewrites the submitter-family refusals, and
splits the legacy arms only if the probes need distinct expectations.

For `INTERNAL_WRITER` the walk pins each route's wrong-credential answer as
observed. The Session-store routes and the publication routes that carry the
writer token refuse at the credential check (403 `writer_credential_invalid`).
The publication-grant routes validate the payload and the publication scope
first, so their wrong-token answer is a 400 (404 for the operation read):
proof that a wrong token does not get in, not that the credential check
refused it. The credential check itself is pinned by a dedicated test on a
store route and a publication route.

| Route                                                                                                                            | Surface  | Capability                | Rule class (today)  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- | ------------------- |
| `POST /v1/agents/sessions`                                                                                                       | PUBLIC   | SESSION_CREATE            | WORKSPACE_CREATE    |
| `GET /v1/agents/sessions`                                                                                                        | PUBLIC   | SESSION_LIST              | READER              |
| `GET /v1/agents/sessions/{sessionId}`                                                                                            | PUBLIC   | SESSION_GET               | READER              |
| `PATCH /v1/agents/sessions/{sessionId}`                                                                                          | PUBLIC   | SESSION_RENAME            | OPERATOR            |
| `POST /v1/agents/sessions/{sessionId}/close`                                                                                     | PUBLIC   | SESSION_CLOSE             | OWNER               |
| `POST /v1/agents/sessions/{sessionId}/archive`                                                                                   | PUBLIC   | SESSION_ARCHIVE           | OWNER               |
| `POST /v1/agents/sessions/{sessionId}/unarchive`                                                                                 | PUBLIC   | SESSION_UNARCHIVE         | OWNER               |
| `DELETE /v1/agents/sessions/{sessionId}`                                                                                         | PUBLIC   | SESSION_DELETE            | OWNER               |
| `GET /v1/agents/sessions/{sessionId}/operations/{operationId}`                                                                   | PUBLIC   | SESSION_OPERATION_GET     | READER              |
| `POST /v1/agents/sessions/{sessionId}/cwd`                                                                                       | PUBLIC   | SESSION_CWD_CHANGE        | OWNER               |
| `POST /v1/agents/sessions/{sessionId}/events`                                                                                    | PUBLIC   | TURN_SUBMIT, TURN_CANCEL  | OPERATOR            |
| `GET /v1/agents/sessions/{sessionId}/events`                                                                                     | PUBLIC   | TAIL_EVENTS               | READER              |
| `GET /v1/agents/sessions/{sessionId}/items`                                                                                      | PUBLIC   | ITEM_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/turns`                                                                                      | PUBLIC   | TURN_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/turns/{turnId}`                                                                             | PUBLIC   | TURN_GET                  | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks`                                                                                      | PUBLIC   | TASK_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks/{taskId}`                                                                             | PUBLIC   | TASK_GET                  | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events`                                                                      | PUBLIC   | TASK_EVENT_LIST           | READER              |
| `GET /v1/agents/sessions/{sessionId}/actions`                                                                                    | PUBLIC   | ACTION_LIST               | READER              |
| `GET /v1/agents/sessions/{sessionId}/actions/{actionId}`                                                                         | PUBLIC   | ACTION_GET                | READER              |
| `POST /v1/agents/sessions/{sessionId}/actions/{actionId}/responses`                                                              | PUBLIC   | ACTION_RESPOND            | OWNER               |
| `GET /v1/agents/sessions/{sessionId}/items/{itemId}/tool-result`                                                                 | PUBLIC   | TOOL_RESULT_GET           | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts`                                                                                  | PUBLIC   | ARTIFACT_LIST             | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}`                                                                     | PUBLIC   | ARTIFACT_GET              | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content`                                                             | PUBLIC   | ARTIFACT_CONTENT          | READER_ACTOR_POLICY |
| `GET /v1/agents/sessions/{sessionId}/hook-catalog`                                                                               | PUBLIC   | HOOK_CATALOG              | READER              |
| `GET /v1/agents/sessions/{sessionId}/mcp-catalog`                                                                                | PUBLIC   | MCP_CATALOG               | READER              |
| `GET /v1/agents/workspaces`                                                                                                      | PUBLIC   | WORKSPACE_LIST            | WORKSPACE_DISCOVERY |
| `GET /v1/agents/workspaces/{workspaceId}`                                                                                        | PUBLIC   | WORKSPACE_GET             | WORKSPACE_DISCOVERY |
| `POST /v1/agents`                                                                                                                | PUBLIC   | AGENT_DEFINITION_CREATE   | TENANT_SCOPED       |
| `GET /v1/agents/{agentId}`                                                                                                       | PUBLIC   | AGENT_DEFINITION_GET      | TENANT_SCOPED       |
| `POST /v1/agents/{agentId}`                                                                                                      | PUBLIC   | AGENT_DEFINITION_UPDATE   | TENANT_SCOPED       |
| `POST /api/agent/web-shell/v1/tasks/query`                                                                                       | WEBSHELL | TASK_LIST                 | READER              |
| `POST /api/agent/web-shell/v1/tasks/get`                                                                                         | WEBSHELL | TASK_GET                  | READER              |
| `POST /api/agent/web-shell/v1/tasks/events/query`                                                                                | WEBSHELL | TASK_EVENT_LIST           | READER              |
| `POST /api/agent/web-shell/v1/sessions/query`                                                                                    | WEBSHELL | SESSION_LIST              | READER              |
| `POST /api/agent/web-shell/v1/sessions/get`                                                                                      | WEBSHELL | SESSION_GET               | READER              |
| `POST /api/agent/web-shell/v1/transcript/query`                                                                                  | WEBSHELL | TRANSCRIPT_QUERY          | READER              |
| `POST /api/agent/web-shell/v1/events/stream`                                                                                     | WEBSHELL | TAIL_EVENTS               | READER              |
| `POST /api/agent/web-shell/v1/sessions/create`                                                                                   | WEBSHELL | SESSION_CREATE            | WORKSPACE_CREATE    |
| `POST /api/agent/web-shell/v1/turns/submit`                                                                                      | WEBSHELL | TURN_SUBMIT               | OPERATOR            |
| `POST /api/agent/web-shell/v1/turns/cancel`                                                                                      | WEBSHELL | TURN_CANCEL               | OPERATOR            |
| `POST /api/agent/web-shell/v1/sessions/close`                                                                                    | WEBSHELL | SESSION_CLOSE             | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/archive`                                                                                  | WEBSHELL | SESSION_ARCHIVE           | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/delete`                                                                                   | WEBSHELL | SESSION_DELETE            | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/unarchive`                                                                                | WEBSHELL | SESSION_UNARCHIVE         | OWNER               |
| `POST /api/agent/web-shell/v1/operations/query`                                                                                  | WEBSHELL | SESSION_OPERATION_GET     | READER              |
| `POST /api/agent/web-shell/v1/sessions/cwd/change`                                                                               | WEBSHELL | SESSION_CWD_CHANGE        | OWNER               |
| `POST /api/agent/web-shell/v1/actions/query`                                                                                     | WEBSHELL | ACTION_LIST               | READER              |
| `POST /api/agent/web-shell/v1/actions/get`                                                                                       | WEBSHELL | ACTION_GET                | READER              |
| `POST /api/agent/web-shell/v1/actions/respond`                                                                                   | WEBSHELL | ACTION_RESPOND            | OWNER               |
| `POST /api/agent/web-shell/v1/tool-results/get`                                                                                  | WEBSHELL | TOOL_RESULT_GET           | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/get`                                                                                     | WEBSHELL | ARTIFACT_GET              | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/query`                                                                                   | WEBSHELL | ARTIFACT_LIST             | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/workspaces/query`                                                                                  | WEBSHELL | WORKSPACE_LIST            | WORKSPACE_DISCOVERY |
| `POST /api/agent/web-shell/v1/workspaces/get`                                                                                    | WEBSHELL | WORKSPACE_GET             | WORKSPACE_DISCOVERY |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/execution:authorize`                                               | INTERNAL | STORE_EXECUTION_AUTHORIZE | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/lifecycle:authorize`                                               | INTERNAL | STORE_LIFECYCLE_AUTHORIZE | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:acquire`                                                   | INTERNAL | STORE_WRITER_ACQUIRE      | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:renew`                                                     | INTERNAL | STORE_WRITER_RENEW        | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:seal`                                                      | INTERNAL | STORE_WRITER_SEAL         | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/recovery:block`                                                    | INTERNAL | STORE_RECOVERY_BLOCK      | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/transactions:commit`                                               | INTERNAL | STORE_TRANSACTION_COMMIT  | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/restore`                                                            | INTERNAL | STORE_RESTORE             | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/tool-results:publish`                                              | INTERNAL | STORE_TOOL_RESULT_PUBLISH | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions`                                                       | INTERNAL | STORE_TRANSACTION_LIST    | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/resources/{resourceId}`                                             | INTERNAL | STORE_RESOURCE_GET        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/grants`                                                        | INTERNAL | PUB_GRANT                 | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/segments/{streamId}/{ordinal}`    | INTERNAL | PUB_SEGMENT               | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/resources/{kind}/{slot}`          | INTERNAL | PUB_RESOURCE              | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/streams/{streamId}/seal`          | INTERNAL | PUB_STREAM_SEAL           | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/streams/{streamId}/prefix`        | INTERNAL | PUB_STREAM_PREFIX         | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/finish`                           | INTERNAL | PUB_FINISH                | INTERNAL_WRITER     |
| `GET /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/operations/{operationId}`          | INTERNAL | PUB_OPERATION_GET         | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/operations/{operationId}/recover` | INTERNAL | PUB_OPERATION_RECOVER     | INTERNAL_WRITER     |
| `GET /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/finished`                          | INTERNAL | PUB_FINISHED              | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/admissions/prepare`               | INTERNAL | PUB_ADMISSION_PREPARE     | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/receipts/verify`                                               | INTERNAL | PUB_RECEIPT_VERIFY        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/receipts/commit`                  | INTERNAL | PUB_RECEIPT_COMMIT        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/range`                            | INTERNAL | PUB_RANGE                 | INTERNAL_WRITER     |
