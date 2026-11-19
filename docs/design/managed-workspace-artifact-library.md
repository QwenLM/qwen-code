# Managed workspace artifact library

[English](managed-workspace-artifact-library.md) | [简体中文](managed-workspace-artifact-library.zh-CN.md)

Status: implemented in this change; locally verified (H2 and real MySQL 8.4
integration, surface/contract/acceptance/parity gates, focused web-shell
tests, build/typecheck/bundle). Full CI acceptance remains pending.

## Problem and current state

The Managed Agent Web UI shows artifacts only inside one session: the Outputs
panel lists the artifacts of the open session through the session-scoped
WebShell routes `POST /api/agent/web-shell/v1/artifacts/query` and
`/artifacts/get`, and downloads bytes through the public
`GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content` route.
There is no way to browse the artifacts a workspace produced across its
sessions.

The local daemon already serves a workspace artifact library
(`docs/design/workspace-artifact-library.md`), but the Managed product does not
talk to the daemon: the Managed-only shell (`ManagedAgentWebShell`) consumes
the Java control plane through `createJavaManagedAgentProvider`. The control
plane has no workspace-wide artifact surface at all; the capability parity
matrix records `workspace_artifact_library` and
`workspace_artifact_library_stream` as `NO_MANAGED_EQUIVALENT`
(`packages/cli/src/serve/capability-parity.ts`).

Artifacts are durable control-plane rows, not transcript projections:
`ma_artifact` stores one descriptor per published output stream, partitioned by
`scope_key = sha256(len-prefixed tenant, session)`. The table carries no
workspace column; workspace attribution lives on the joined
`ma_operation` row (`operation_kind = 'TOOL_RESULT_PROJECTION'`) and on
`ma_session.workspace_id`. Listing order today is the per-session
`creation_sequence`, which is not comparable across sessions.

## Goals and scope

Add one workspace-scoped artifact query to the WebShell API and one library
panel to the Managed Web UI: list the workspace's artifacts newest first
across sessions, label each row with its source session, preview and download
through the existing session-scoped byte route.

In scope:

- One WebShell route, `POST /api/agent/web-shell/v1/workspaces/artifacts/query`,
  with opaque cursor pagination and the existing `WebShellArtifactPage`
  envelope.
- Workspace read-grant admission plus per-session visibility filtering, the
  deployment artifact gate, batched availability, and the content-policy flag
  per row.
- A page-level capability flag on the workspace query response, a provider
  capability, a workspace-group entry button, and a library dialog reusing
  `ManagedArtifactContent`.
- The parity flip for `workspace_artifact_library`, the surface twin
  regeneration, and the contract, surface, and acceptance gates.

Out of scope:

- Removal. The control plane has no artifact deletion primitive; retention is
  session-rooted (`docs/design/managed-tool-output-retention.md`). Batch
  removal stays a daemon-only capability; the parity reason for the stream
  tag remains.
- SSE progressive reads. The daemon streams because cold reads replay
  transcripts; this query is one indexed SQL read per page, so JSON cursor
  pagination suffices. `workspace_artifact_library_stream` stays absent.
- A public twin route. Only the Web UI consumes this surface; the WebShell-only
  workspace-files family is the precedent.
- Session metadata in the response envelope and rich MIME previews. Session
  titles resolve client-side from the lifecycle summaries (the loaded list,
  the open session's summary, and the archived list), not the envelope;
  artifact bytes remain the raw stdout/stderr streams the projection
  publishes. The one schema change is the workspace access-path index on the
  V1 baseline (see Store and service).

## Protocol

### Request and response

`POST /api/agent/web-shell/v1/workspaces/artifacts/query`

| Field         | Shape                         | Validation                     |
| ------------- | ----------------------------- | ------------------------------ |
| `workspaceId` | string, required              | `@NotBlank` (workspace family) |
| `cursor`      | string or null, optional      | at most 2048 characters        |
| `limit`       | integer, optional, default 20 | 1–100, enforced in the service |

Unknown fields are rejected (`@JsonAnySetter`, matching the newer WebShell
request records). The response reuses `WebShellArtifactPage`:
`data: ArtifactResponse[]`, `nextCursor: string | null`, `hasMore: boolean`.
Each `ArtifactResponse` keeps the existing shape: the `PublicArtifact`
descriptor with `availability` injected, plus `access.can_read_content`.
`artifact.session_id` identifies the source session; no session metadata is
added to the envelope. Responses carry `Cache-Control: no-store` — the
workspace family convention: `TenantContextFilter` pre-sets it on
`/workspaces/` paths, so the session routes' `private, no-store` would leave
two header values.

### Ordering and cursor

Rows order by `ma_artifact.id DESC` — the auto-increment primary key assigned
at projection insert. It is a strict total order across sessions and matches
"newest projected first"; within one projection the stdout/stderr pair keeps
a stable order. The per-session `creation_sequence` is deliberately not used:
it comes from each session's own event stream and is not comparable across
sessions.

The first page captures `watermark = MAX(a.id)` over the same visible set and
freezes the window, mirroring the session page's watermark semantics: rows
projected after the first page do not shift or duplicate later pages. The
cursor is Base64url JSON with exactly six fields:

```json
{
  "v": 1,
  "tenant": "...",
  "actor": "...",
  "workspace": "...",
  "watermark": 123,
  "before": 120
}
```

`before` is the last returned row's `a.id`. Validation rejects a cursor whose
length exceeds 2048, whose field count differs, whose `v` differs, whose
tenant/actor/workspace differ from the request, whose numeric fields do not
convert to longs, or where `watermark < 0`, `before < 0`, or
`before > watermark`. Failures answer `400 invalid_cursor`; an out-of-range
limit answers `400 invalid_limit`. The next cursor is emitted only when the
store fetched `limit + 1` rows.

### Admission and row visibility

Service admission runs before limit/cursor validation, following the artifact
family's order (body constraints — the required `workspaceId` and the closed
field set — are enforced by the framework before the service is invoked):

1. Trusted actor: `401 actor_required` without one.
2. Workspace read grant: `registry.accessOf(tenant, actor, workspaceId)`
   below READER, or an unknown workspace, answers `404 workspace_not_found`.
   CHILD_GIT workspaces resolve to their root grant through the registry, as
   every workspace-scoped read does.
3. Deployment artifact gate: `settings.isEnabled() && reader.supported()`
   otherwise answers `404 artifact_not_found`, the same code the session
   routes use when artifact reads are off.

The query then filters rows in SQL:

- `r.operation_kind = 'TOOL_RESULT_PROJECTION'` and `r.state = 'READY'`;
- `r.tenant_id = ?`, `r.workspace_id = ?`, and `s.workspace_id = ?` — the
  operation's source workspace and the session's current binding must both
  equal the requested workspace, so a rebound session's drifted artifacts do
  not list under either workspace (the byte route already refuses drifted
  reads);
- `s.session_kind = 'PUBLIC'` — CONTROL lifecycle records never list;
- `s.status` not `DELETED` or `DELETING`; archived sessions stay visible;
- `(s.owner_only = 0 OR COALESCE(s.owner_actor_key, s.creator_actor_key) = ?)`
  with the encoded actor key — the same per-session visibility predicate the
  worktree list uses.

Legacy sessions without a workspace binding cannot match the workspace
filters and never list. There is no primary-runtime fallback, no session
load, and no unarchive.

### Availability and content policy

`reader.availability(artifacts)` reads receipts for a nonempty page in one SQL
query. Each source session contributes its own scope, retirement check, and
publication IDs. Results are matched by scope and publication ID. When any row
is unavailable, the workspace read grant is re-checked once — the workspace
analogue of the session page's `session()` re-check — and a lost grant answers
`404 workspace_not_found` instead of silently serving the page.

`access.can_read_content` is `available && policy.readOriginal(tenant, actor,
workspaceId, sessionId)`, evaluated once per distinct session in the page.
The default policy is deployment-level, but the interface is per-session and
custom policies may differ; grouping keeps the call count bounded by the page
size. Unavailable rows remain listed with `availability: "unavailable"` and
`can_read_content: false` — retention collects retired sessions' bytes while
descriptors survive, and the library must tolerate that state.

Byte reads are unchanged: the UI downloads through the existing public
session-scoped content route with its fixed revision, ETag, Range, and
revalidation guards.

## Surface, contract, and parity gates

- `SurfaceRegistry`: one new entry
  `WEBSHELL_WORKSPACE_ARTIFACT_LIST(POST, "/api/agent/web-shell/v1/workspaces/artifacts/query", Surface.WEBSHELL, RuleClass.WORKSPACE_ARTIFACT, EnumSet.of(Capability.WORKSPACE_ARTIFACT_LIST))`.
  The new `RuleClass.WORKSPACE_ARTIFACT` documents the rule above: trusted
  actor, workspace READER grant (`404 workspace_not_found` below), per-session
  owner-only filtering, deployment artifact gate (`404 artifact_not_found`
  when off), no legacy arm. `SurfaceRegistryGateTest`'s exact bijection and
  capability-twin rule class checks apply unchanged.
- `SurfaceAdmissionAcceptanceTest`: a new switch arm probes anonymous
  (`401 actor_required`), stranger (`404 workspace_not_found`), and reader
  (admitted, serving the seeded artifact row while another actor's owner-only
  session's row stays invisible). `bodyFor` gains the capability's minimal
  body; the fixture seeds one visible artifact and one owner-only-hidden
  artifact in the probed workspace.
- OpenAPI: the new path entry is `implemented`, tagged `WebShell`, with
  `x-qwen-admission-rule: workspace_artifact`; the request schema
  `WebShellWorkspaceArtifactQueryRequest` is closed
  (`additionalProperties: false`); the response references the existing
  `WebShellArtifactPage`. `WebShellWorkspacePage.capabilities` gains an
  optional boolean `workspaceArtifactLibrary` ("missing means unsupported",
  the family's existing convention).
- `ApiModels`: `WebShellWorkspaceArtifactQueryRequest(@NotBlank String
workspaceId, String cursor, Integer limit)` with `rejectUnknown`;
  `ManagedAgentApiContractTest.RECORD_SCHEMAS` maps it, and the route exchange
  probes cover the anonymous refusal (`401`) and an admitted page (`200`):
  the contract context seeds one readable workspace with a projected artifact
  row and stubs the reader's publication support, so the response is
  schema-validated down to `ArtifactResponse.access`, not just the envelope.
- `WorkspaceDiscoveryController`: `WebShellCapabilities` gains
  `workspaceArtifactLibrary`, computed as
  `settings.getArtifacts().isEnabled() && reader.supported()`; a telescoping
  constructor keeps the older shapes. The controller injects
  `ManagedAgentSettings` and `ManagedArtifactReader`.
- Parity: `workspace_artifact_library` flips to
  `{ standing: 'managed', evidence: 'surface:WORKSPACE_ARTIFACT_LIST' }`.
  The daemon tag also covers batch removal, which stays absent; the matrix
  already maps `session_artifact_library` to the get-only `ARTIFACT_GET`
  surface, so a read-only standing is the established convention.
  `workspace_artifact_library_stream` keeps its absent reason, updated to
  name the JSON-only query. The committed twin
  `verification/src/test/resources/capability-parity/managed-surface.txt` is
  regenerated with
  `mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test`,
  and `capability-parity.test.ts` verifies the evidence and digest. The
  `web_terminal` row already cites the terminal ticket surface alongside its
  design doc; this change leaves it untouched.

## Store and service

`ManagedToolResultStore` gains one method:

```java
WorkspaceArtifactPage listWorkspaceArtifacts(String tenant, byte[] actorKey,
        String workspaceId, Long watermark, Long beforeId, int limit);
```

The store returns a new `WorkspaceArtifactPage(artifacts, watermark, hasMore,
lastId)` record: the shared `Artifact` record carries no row id and the
session path stays untouched. `lastId` is the truncated page's last row id
(0 when empty); the cursor emits it, never the probe row fetched for
`hasMore`. The JDBC implementation selects
`a.id` plus `ManagedSchemaProjection.ARTIFACT.columns("a")` and
`r.request_json`, joining `ma_operation r` on
`r.operation_kind = 'TOOL_RESULT_PROJECTION' AND r.operation_id = a.result_id`
and `ma_session s` on `s.tenant_id = r.tenant_id AND s.session_id =
r.session_id`, with the visibility predicates above, `a.id <= watermark`, the
optional `a.id < beforeId` keyset, `ORDER BY a.id DESC LIMIT ?` (fetching
`limit + 1`). The watermark query is `SELECT COALESCE(MAX(a.id), 0)` over the
same join and filters. The row mapper reuses the existing artifact mapper and
reads the extra `id` column for the cursor.

The projection enum is untouched: `ManagedSchemaProjectionTest` pins each
projection to the table's non-`id` columns in DDL order. Referencing `a.id`
in this one query's select list and keyset follows the existing practice of
referencing joined-table columns outside the projection in where/join
clauses. The V1 baseline gains one index,
`idx_ma_operation_workspace ON ma_operation (workspace_id, operation_kind,
state, id)`, so the page's cost is bounded by the workspace's projections
instead of the deployment's whole tool-output catalog — a first page is
requested on every library open, including empty workspaces. `tenant_id`
stays a residual filter rather than a leading column: both identity columns
are `VARBINARY(2048)`, and a `(tenant_id, workspace_id)` leading pair would
exceed InnoDB's 3072-byte index key limit. The expected plan narrows
`ma_operation` through the workspace index, probes `ma_session` by its
primary key and `ma_artifact` through
`uk_managed_artifact_stream (result_id, stream_id)`, then sorts the matched
rows by `a.id`. A schema assertion in the workspace-artifact integration
suite (H2 and MySQL twins) pins the index's leading columns, so removing it
turns the gate red.

`ManagedArtifactService` gains `workspacePage(TenantContext, workspaceId,
cursor, limit)` implementing the admission, validation, availability, policy
grouping, and cursor emission above, and injects `ManagedWorkspaceRegistry`
for the grant check and `ManagedWorkspaceRegistry.actorKey` encoding. The
session-scoped methods are unchanged. `ManagedArtifactController` gains the
one WebShell endpoint delegating to it.

## Web UI

Types regenerate from the contract with
`npm run generate:managed-agent-api --workspace=@qwen-code/web-shell`;
`managed-agent-api.test.ts`'s byte-equality pin guards the drift.

- `java-managed-agent-client.ts`: `listWorkspaceArtifacts(workspaceId,
options)` posts `/workspaces/artifacts/query` with
  `{ workspaceId, cursor?, limit? }` through the shared JSON RPC path,
  returning `ManagedArtifactPage`.
- `managed-agent-provider.ts`: a new optional capability
  `workspaceArtifacts?: ManagedWorkspaceArtifactReader` with
  `listArtifacts(workspaceId, options & { cursor?, limit? })`. The Java
  provider wires it unconditionally, like `toolResults`; hosts without the
  surface simply omit it. `workspaceBinding.list` maps the page's
  `workspaceArtifactLibrary` flag to `artifactLibrary: boolean`
  (false when missing).
- `ManagedWorkspaceNavigation`: the workspace group header gains a library
  button beside the existing new-task button, shown when the workspace page
  declares `artifactLibrary` and the provider exposes `workspaceArtifacts`
  and `toolResults`. It calls a new
  `onOpenArtifactLibrary(workspaceId, workspaceLabel)` prop.
- `ManagedSessionsPage`: one new state `artifactLibraryWorkspace`, cleared on
  provider identity change. Unlike the session-scoped `outputTarget`, it
  deliberately survives session selection because the library belongs to the
  workspace, not the open session; the nav callback sets it, and the panel
  area renders the library dialog while it is set. Both the Managed-only shell
  and the hybrid App reach it through the shared page, so no `App.tsx` panel
  union change is needed.
- `ManagedArtifactLibraryPage.tsx`: a shadcn dialog listing the workspace's
  artifacts. Each row shows the stream role, byte length, projection time,
  availability badge, and the source session's title resolved from the
  session summaries the page already holds (fallback: the shortened session
  id — deleted or child sessions may not be in the list). Selecting a row
  renders the existing `ManagedArtifactContent` with
  `reader = provider.toolResults`, which re-fetches the artifact metadata by
  `artifact.session_id` and pages the bytes with the existing 64 KiB reader,
  preview, and download gating (`reader.canDownload`). Load-more appends the
  next cursor page; empty, loading, and error states are explicit, and a
  `404` answers with a code-specific message rather than an empty list:
  `workspace_not_found` (a revoked grant) reads as the workspace being gone
  for this account, while the deployment gate's `artifact_not_found` reads
  as the library being unavailable on this server. Strings live in a new
  `managed-artifact-library-messages.ts`
  (EN/ZH/RU) registered in `i18n.tsx`; the hand-maintained `i18n-zh-tw.ts`
  catalog carries the ten keys in Traditional glyphs, and `i18n.test.ts`
  pins both their presence (no English fallback) and the absence of
  Simplified-only glyphs. The library is interactive-only, so a
  `managed-artifact-library-messages.transcript-stub.ts` of three empty
  objects replaces the module in the transcript build (registered in
  `vite.lib.config.ts` beside the other `managed-*` stubs): the copy ships in
  no exported document, and the renderer budget stays at main's tracking.

The dialog never uses `useArtifactWorkspaceTarget` or `ArtifactPanel`: those
depend on the daemon workspace context the Managed-only shell does not
provide.

## Files affected

Java (managed-agent-server):

- `contracts`: `ApiModels.java`, `ManagedToolResultStore.java`, the OpenAPI
  contract JSON.
- `control-plane`: `ManagedArtifactService.java`.
- `persistence`: `JdbcManagedToolResultStore.java`, the `V1__managed_schema.sql`
  baseline (one new index, edited in place per the module's pre-release rule).
- `server`: `ManagedArtifactController.java`,
  `WorkspaceDiscoveryController.java`.
- `verification`: `SurfaceRegistry.java`, `SurfaceAdmissionAcceptanceTest.java`,
  `ManagedAgentApiContractTest.java`, the regenerated
  `capability-parity/managed-surface.txt`, and focused store/service tests
  (H2 plus the selected MySQL integration case).

TypeScript:

- `packages/cli/src/serve/capability-parity.ts` (parity flip; the test file
  unchanged unless a pinned row names the old reason).
- `packages/web-shell`: the generated API types,
  `java-managed-agent-client.ts`, `java-managed-agent-provider.ts`,
  `managed-agent-provider.ts`, `managed-tool-result-types.ts`,
  `ManagedWorkspaceNavigation.tsx`, `ManagedSessionsPage.tsx`, the new
  `ManagedArtifactLibraryPage.tsx` and messages module with its transcript
  stub, `i18n.tsx`, `i18n-zh-tw.ts` (Traditional catalog), `i18n.test.ts`,
  `vite.lib.config.ts` (stub registration), `build-artifact.test.ts`
  (transcript boundary), and collocated tests.
- `packages/web-templates`: `src/export-html/build.mjs` — the renderer budget
  constants stay at main's tracking; the measurement record notes the stub.

Docs: this design pair and the E2E plan
`.qwen/e2e-tests/managed-workspace-artifact-library.md`.

## Validation plan

- Java focused gates: `ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`,
  `SurfaceRegistryGateNegativeTest`, `SurfaceAdmissionAcceptanceTest`,
  `ManagedSurfaceCaptureTest` (capture mode regenerates the twin), the new
  store/service tests, and Checkstyle. The new SQL is a SQL change: select the
  affected `mysql-integration` cases against a disposable MySQL 8.4 within the
  module's local budget, and leave the full profile to CI.
- TypeScript: focused vitest for every changed web-shell file (client
  transport, provider wiring and flag mapping, navigation gating, the library
  dialog DOM behavior, and the sessions-page integration), the generated-type
  drift test, `capability-parity.test.ts` in `packages/cli`, then root build,
  typecheck, and bundle.
- E2E: the test plan exercises an isolated control plane with seeded
  projections — visible and owner-only-hidden sessions, archived and deleting
  sessions, drifted bindings, unavailable bytes, cursor stability under
  concurrent projection, and the UI entry/preview/download path. The baseline
  dry-run records the missing route and the absent UI entry.

## Acceptance criteria

- A reader of a workspace lists its sessions' artifacts newest first, paginates
  with a stable cursor, and sees per-row availability and content access.
- A stranger sees `404 workspace_not_found`; an anonymous caller sees
  `401 actor_required`; a deployment with artifact reads off sees
  `404 artifact_not_found`; owner-only sessions of other actors, CONTROL,
  DELETED/DELETING, legacy-unbound, and drifted rows never list.
- The library entry appears only when the workspace page declares the
  capability and the provider exposes the reader; the dialog previews and
  downloads through the existing byte route with its unchanged guards.
- All surface, contract, acceptance, parity, and generated-type gates pass;
  the session-scoped artifact routes keep their contracts byte-for-byte.

## Decisions and limitations

- Read-only slice: removal and SSE remain daemon-only. The parity matrix
  records this as a read-only `managed` standing for the library tag (the
  daemon tag also covers batch removal, which this surface does not
  implement) and an absent stream row whose reason names both missing
  halves — progressive streaming and session-summary updates.
- `a.id` ordering is projection order, not tool-execution order; the two can
  differ when projection lags the receipt. The watermark freezes the window
  per query, not across queries.
- Session titles resolve client-side from the lifecycle summaries; a session
  absent from all of them labels its rows with the shortened id. The envelope
  stays the existing
  `WebShellArtifactPage`, so no response-schema drift reaches the session
  routes.
- Results are per-page snapshots filtered at query time; a grant or binding
  change mid-pagination is caught by the cursor's tenant/actor/workspace
  binding and the unavailable-row grant re-check, not by a transactional
  workspace snapshot.
- One new index, `idx_ma_operation_workspace (workspace_id, operation_kind,
state, id)`: the library opens on every workspace visit, so the page's cost
  must be workspace-bounded, not catalog-bounded. `tenant_id` cannot lead the
  index beside `workspace_id` — both are `VARBINARY(2048)` and the pair would
  exceed InnoDB's 3072-byte key limit — so it stays a residual filter, which
  preserves isolation without widening the key.
