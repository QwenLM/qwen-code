# Managed Agent actor roles and tenant-isolation acceptance

[English](2026-10-07-managed-agent-actor-roles.md) | [简体中文](2026-10-07-managed-agent-actor-roles.zh-CN.md)

Issue: #13535 (R1 actor roles, R2 isolation acceptance). Parent: #12380 production
enablement. Vocabulary source: #12867 section 10 (`reader`, `operator`, `owner`;
`404` without read, `403` with read but without operate; idempotency domain
includes the actor — landed with D4 for the operation ledger; the
submitter-family command key stays `(tenant_id, operation, idempotency_key)`
and its actor scoping is tracked as #13619). This design answers
#12867's open question Q4 (where roles come from) and defines the surface
registry plus its build gate.

Verified at `main` = `ac497aeed9` (one commit past the `b585508733` baseline the
issue names; the delta is a TUI change outside this module).

Status: slice A (#13543) lands the registry and its gates over today's
admission, and the V53 role storage of D2/D3 lands with slice B (#13544);
both are merged. This PR is slice C — the D4/D7 enforcement sections below
describe the changes it lands.

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
  the original slice-A baseline's 22 internal routes, nothing probes a caller
  below read or with read but without the family's power, and nothing ties a
  route to the admission rule it should follow — so a route can land with the
  wrong check and every test stays green, which is the failure mode that
  matters most while this surface is still growing quickly.

## 2. Current state

Identity is `(tenantId, actorId)` only, supplied by trusted filters
(`SignatureAuthFilter` in SIGNED mode, `TrustedActorHeaderFilter` as the
OPEN-mode stand-in); the `AuthenticatedTenantActor` contract is unchanged by
this design.

Authorization today is grant rows plus a creator record:

- `managed_workspace_access(tenant_id, workspace_id, actor_id, can_read,
can_create)` (V8) — the only per-actor grant table, read on every
  Workspace-bound route. Its domain enum is `WorkspaceAccess`
  (NONE/READ/CREATE, CREATE implies READ) in the runtime-broker module.
- `managed_agent_session.creator_actor_key` (V40) plus
  `managed_workspace_create_command` (V9, the idempotency-command record) —
  two copies of "creator".

"Creator-only" is three mechanisms with three refusal vocabularies:

| Family                                                     | Routes                                                                                                                             | Check                                                                                     | Readable non-creator gets         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| Turn submit / cancel / rename                              | public `POST …/events` (submit and cancel), `PATCH …/{id}`; WebShell `turns/submit`, `turns/cancel` (rename has no WebShell route) | `requireSubmitter` → `maySubmitWorkspaceTurn` (create-command row + current `can_create`) | **409 `workspace_unavailable`**   |
| Lifecycle (close, archive, unarchive, delete) + cwd change | `POST …/close \| archive \| unarchive`, `DELETE`, `POST …/cwd`, WebShell twins                                                     | `requireWorkspaceCreator` (can_read then create-command row)                              | 403 `session_operation_forbidden` |
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
WebShell + 24 internal routes (80 in total, including the two L3
authorization routes, counted by the slice-A gate; this body previously said
77/21 before #13088's `receipts/verify` handler, 78 before L3).

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
family is removed (section 5).

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

Concretely, migration V53 replaces the two booleans with one column:

```sql
ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NULL;
-- A row without can_read grants nothing today; keeping it would gain
-- READER (or OPERATOR, for a can_create row) through the backfill.
DELETE FROM managed_workspace_access WHERE can_read = FALSE;
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access
    MODIFY COLUMN role VARCHAR(16) NOT NULL;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK ((role = 'READER' AND CHAR_LENGTH(role) = 6)
        OR (role = 'OPERATOR' AND CHAR_LENGTH(role) = 8)
        OR (role = 'OWNER' AND CHAR_LENGTH(role) = 5));
```

The compound shapes are split into per-action statements, matching the
in-repo migration precedent (V7, V12, V24, V40); `role` arrives without a
default so an omission fails loudly exactly as a boolean omission did, the
backfill supplies every existing row's value before `NOT NULL` is set, and
the `CHAR_LENGTH` pin defeats utf8mb4's PAD-SPACE equality storing
`'READER '` instead of `READER`. Dropping unreadable rows before the
backfill is what makes the change purely a relabelling for every reachable
grant row. `role` is the single stored vocabulary; no
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
appears in this slice (section 6).

### D3 — the Session record keeps an owner, defaulting to its creator

V53 also adds `managed_agent_session.owner_actor_key VARBINARY(2048) NULL`
and backfills it from `creator_actor_key`. Three identity facts stay
deliberately separate:

- the **record** (Session row) holds the owner — one actor, initially the
  creator;
- the **binding** (workspace grant rows) holds what each actor of the tenant
  may do on Workspaces;
- the **role** is the vocabulary the admission path consults — for
  Session-scoped checks, the Session's owner acts with OWNER rights on that
  Session without holding an OPERATOR or OWNER workspace role, provided it
  keeps a readable grant; an actor with no readable row is invisible (`404`),
  which is exactly today's `can_read`-then-creator order.

`managed_workspace_create_command` remains what it is — an idempotency-command
record whose `actor_id` belongs to the idempotency domain, not to
authorization. After V53 its authorization reads (the NULL-creator fallbacks
in `requireOwner` / `requireWorkspaceCreator`) do not cover only sessions
created before V40: every actor-less legacy open-mode creation still writes
NULL to both key columns, so the fallbacks stay live for the legacy arm, and
the handover slice must decide what a NULL owner means instead of assuming it
cannot occur.

An owner update path (the handover command) is a follow-up slice on top of
this column, tracked as #13617; this slice creates the vocabulary and the
storage the handover needs, and re-points every creator check at the owner
(section 7).

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
| Legacy (unbound) Session routes                                           | tenant-wide                                     | tenant-wide — unchanged (section 6)                                   |
| Agent definitions                                                         | tenant-scoped                                   | tenant-scoped — unchanged                                             |
| Internal store / tool-publication routes                                  | writer HMAC, no actor                           | unchanged                                                             |

Live behaviour that re-reads grants (SSE read-grant recheck, mid-stream
artifact revalidation, execution-time `authorizePassiveAttachment`) consults
`role` with identical thresholds, so revocation keeps its current meaning.

On the bound arm, the submitter family and the cwd change additionally
certify the Session's creator-keyed execution facts — the Registry still
backs the binding exactly and stays ACTIVE, and the actor recorded by the
Workspace create command keeps OPERATOR or above, because the admitted work
executes under that actor's grants (the execution authority re-verifies the
same join). Their failure is the family's domain `409
workspace_unavailable`, answered synchronously at admission rather than as
an asynchronously failing Turn. A cwd operation's settlement re-verifies both the recorded
creator-keyed facts and the V54-persisted initiator's role, so an
operation fails with `workspace_unavailable` when either actor is
demoted after admission (pre-V54 rows carry no initiator key and settle
on the creator-keyed facts alone); that is the W2 design's "grant
revoked after admission still blocks the change", now covering the
widened admission.

### D5 — the versioned surface registry

One enum in the server module — `api/SurfaceRegistry.java`, one constant per
implemented route — carrying: HTTP method, path template, surface (PUBLIC /
WEBSHELL / INTERNAL), capability id (shared by the public/WebShell twins of
one capability, e.g. `TURN_SUBMIT`), and rule class (`legacy_create`,
`legacy_tenant`, `workspace_create`, `reader`, `reader_actor`,
`reader_actor_policy`, `operator`, `owner`, `workspace_discovery`,
`tenant_scoped`, `internal_writer`). This single file is the
issue R2 enumeration: per route it states which actor may read, mutate,
cancel, answer or delete. It is versioned exactly as the surface is versioned
— registry changes ride the contract version they implement (the R1 flip is
v1.34), so `git blame` of the registry is the authoritative per-route history.

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

The per-caller `workspaceTurns` flag in the session views mirrors the
submitter family's server admission exactly: it is computed from the
caller's OPERATOR-or-above role and the Session's creator-keyed execution
facts, not from creator identity, so the composer's exposure stays a mirror
of what submit would answer. The lifecycle capability flags stay
Session-scoped and caller-blind in this slice — they describe whether the
Session supports close/archive/delete at all, not whether the current
caller may drive them; owner-scoped advertisement of the lifecycle flags is
deferred with the handover (#13617). The parity assertion in D6 covers the
rule; existing WebShell coverage covers the advertisement.

## 4. Delivery plan

Three slices, two parallel lanes then one closing lane. Lane split follows
file-scope disjointness, not topic:

| Slice                              | Content                                                                                                                                                                                                                                             | Touches                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **A — registry + gate (R2 first)** | `SurfaceRegistry` over today's rules, correspondence gate, acceptance probes, parity assertions, bilingual route matrix in this doc                                                                                                                 | new files only: `api/SurfaceRegistry.java`, two test classes; no production edits              |
| **B — role storage (R1 storage)**  | V53 migration + backfill, `WorkspaceAccess` rename, registry store reads re-derivd from `role`, `owner_actor_key` column + write at creation, fixture INSERT updates (~24 sites), migration-shape tests                                             | `store/**`, `runtime-broker` enum, `db/migration`, test fixtures; no admission-decision change |
| **C — enforcement (R1)**           | the three creator helpers re-pointed at role/owner, refusal-code normalisation, Action respond opens to OPERATOR, WebShell capabilities by role, registry rule flips, probe expectation flips, contract v1.34 + OpenAPI text, contract-test updates | `service/**`, `store/**` checks, controllers, contract, A's enum + tests                       |

A ∥ B is safe: disjoint files (A adds; B edits store-side). C is serial after
both merge because it rewrites both A's registry entries and B's helpers —
this is the one genuine blocking dependency, and it is sequenced rather than
raced. C advances #13535 (the handover command and legacy hardening are
tracked as #13617 and #13618 respectively); A and B reference it.

## 5. Migration and compatibility

- V53 follows the established single-version doctrine (stop old servers
  before the migration; no `outOfOrder`). `scripts/check-flyway-migrations.js` already
  gates numbering across both migration locations.
- Contract v1.34 records: the role vocabulary, OPERATOR admission for the
  submitter and Action families, owner-based lifecycle, the submitter-family
  refusal change 409 `workspace_unavailable` → 403
  `session_operation_forbidden`, and role-based capability advertisement.
- What a client can observe: a readable non-owner submitter (submit, cancel,
  rename) keeps the same requests but its below-OPERATOR refusal normalizes
  from 409 `workspace_unavailable` to 403 `session_operation_forbidden`,
  while an OPERATOR past the role check still meets the family's domain 409
  on shape or creator-fact failure; Action respond now succeeds for
  OPERATORs that are not the creator; Turn submit, cancel, rename and cwd
  change now succeed for OPERATORs that are not the creator, while the
  Session's creator-keyed execution facts hold. Everything else is
  caller-preserving.
- Test fixtures writing `can_read`/`can_create` move to `role` in slice B;
  the generated-columns alternative was rejected to keep one source of truth
  and H2/MySQL parity simple.

## 6. Scope boundaries

Same as the issue's, plus the explicit deferrals named there:

- Legacy (unbound) Sessions stay tenant-wide this slice. Hardening them
  (they already record a creator since V40) is tracked as #13618; widening
  R1 to legacy would double this slice's blast radius without fixing a
  named product block.
- No handover command: `owner_actor_key` and the role checks it trips land
  here; the transfer operation (idempotent command, owner-only admission,
  audit event) is its own slice, tracked as #13617. Note which families the
  owner column drives: lifecycle and Action respond key on it, while
  submit, cancel, rename, cwd change and execution itself stay
  create-command-keyed (the execution authority's join names the
  create-command actor), so the handover slice must also decide whether
  the transfer re-points the create command or re-keys execution — or
  accepts a Session that is inoperable for its new owner.
- No actor term in the submitter-family command idempotency key: the
  operation ledger is actor-scoped since D4, but `managed_agent_command`
  keeps its `(tenant_id, operation, idempotency_key)` domain this slice —
  scoping it by actor (without breaking the single-unique-index dedupe its
  racing inserts rely on) is tracked as #13619.
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

- Slice A: the correspondence gate's fail-closed arms are pinned by the
  committed `SurfaceRegistryGateNegativeTest` (one mounted route the
  registry does not register, and one registered route with no handler);
  `SurfaceRegistryGateUnconstrainedTest` adds the method-agnostic-mapping
  arm; probes pin today's statuses per rule class on public + WebShell.
- Slice B: migration-shape test applying V53 over the earlier fixtures
  asserts the backfill (can_create → OPERATOR, can_read-only → READER,
  owner := creator) and the hardened CHECK (a padded role value is
  rejected).
  Existing expectations change only where they name a renamed
  `WorkspaceAccess` constant; the behaviour-invisibility proof is the
  preserved `canRead()`/`canCreate()` truth table pinned by
  `WorkspaceAccessTest`, not untouched files.
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
      handover ready; the command itself is follow-up): lifecycle and
      respond key on it after this PR, while submit/cancel/rename/cwd and
      execution stay on the create-command actor until #13617 decides the
      transfer's re-keying (R1's blocked behaviour #2, storage half).
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

`api/SurfaceRegistry.java` integrated with L3 carries 80 route constants:
32 public + 24 WebShell + 24 internal handler methods of the ten
controllers, including the two L3 authorization routes. (The 21-internal
figure section 2 previously carried is stale: #13088 added the
`receipts/verify` handler to ToolPublicationController, and L3 added its
two authorization routes; the gate derives everything from scanning, so the
count is information, not an asserted constant.)

Rule classes name the implemented admission. After slice C (contract
v1.34): `WORKSPACE_CREATE` (2), `READER` (24), `READER_ACTOR` (6),
`READER_ACTOR_POLICY` (1), `OPERATOR` — the submitter family plus cwd
change and Action respond — (8), `OWNER` — the lifecycle family alone —
(8), `WORKSPACE_DISCOVERY` (4), `TENANT_SCOPED` (3), `INTERNAL_WRITER`
(24). The design's `legacy_create` and `legacy_tenant` names are kept in
the class documentation as the names of the legacy arms: a route carries
exactly one rule class and, per the separation rule, it is the
bound-Session one. The matrix's rule column below is the post-C matrix;
the pre-C values it replaced are D4's "Rule today" column.

| Route                                                                                                                            | Surface  | Capability                | Rule class (post-C) |
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
| `POST /v1/agents/sessions/{sessionId}/cwd`                                                                                       | PUBLIC   | SESSION_CWD_CHANGE        | OPERATOR            |
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
| `POST /v1/agents/sessions/{sessionId}/actions/{actionId}/responses`                                                              | PUBLIC   | ACTION_RESPOND            | OPERATOR            |
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
| `POST /api/agent/web-shell/v1/sessions/cwd/change`                                                                               | WEBSHELL | SESSION_CWD_CHANGE        | OPERATOR            |
| `POST /api/agent/web-shell/v1/actions/query`                                                                                     | WEBSHELL | ACTION_LIST               | READER              |
| `POST /api/agent/web-shell/v1/actions/get`                                                                                       | WEBSHELL | ACTION_GET                | READER              |
| `POST /api/agent/web-shell/v1/actions/respond`                                                                                   | WEBSHELL | ACTION_RESPOND            | OPERATOR            |
| `POST /api/agent/web-shell/v1/tool-results/get`                                                                                  | WEBSHELL | TOOL_RESULT_GET           | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/get`                                                                                     | WEBSHELL | ARTIFACT_GET              | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/query`                                                                                   | WEBSHELL | ARTIFACT_LIST             | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/workspaces/query`                                                                                  | WEBSHELL | WORKSPACE_LIST            | WORKSPACE_DISCOVERY |
| `POST /api/agent/web-shell/v1/workspaces/get`                                                                                    | WEBSHELL | WORKSPACE_GET             | WORKSPACE_DISCOVERY |
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
