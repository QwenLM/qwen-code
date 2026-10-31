# Managed model display and context usage

[English](2026-10-15-managed-model-context.md) | [中文](2026-10-15-managed-model-context.zh-CN.md)

## Problem and current behavior

Managed new tasks already select host-published AgentDefinition presets through the shared model menu. Existing conversations hide that menu and the context indicator. Local WebShell has reusable model and context-usage controls, but its model mutation and compression actions belong to the daemon. They cannot be sent to a Managed Session.

Hosted execution durably publishes model-attempt usage resources. Their provider prompt-token count describes the most recent request; cumulative billing totals do not describe context occupancy. Those resources currently lack the resolved context-window size.

## Scope and behavior

Keep new-task AgentDefinition preset selection. Existing Workspace-bound public conversations can change the next user Turn's model through a server-published model catalog while idle, preserving history, instructions, tools and approval policy. The catalog contains configured model IDs and labels, never browser-supplied credentials. A current selection is distinct from the last actual model observation. Before an observation exists, show the Agent identity without claiming a host preset label is the actual model of an older definition revision. Do not introduce model credentials or arbitrary model IDs into browser requests.

Reuse the context ring and its popover for used tokens, configured window and remaining capacity. Use the latest successfully committed main-model request's provider `promptTokenCount` and the same resolved configuration's `contextWindowSize`. Both values must be safe integers with nonnegative usage and positive capacity. Missing data remains unknown, including older Sessions, unsupported providers and invalid metadata. No estimated capacity or cumulative usage substitutes for a missing value.

This change covers Workspace-bound Java Managed Sessions. Manual compression, detailed prompt-category estimation and provider administration are outside this slice. Unsupported actions are not displayed. Local model, usage, reasoning and compression behavior stays intact.

## Durable data and projection

The Hosted CLI attaches optional `contextWindowSize` to each existing successful usage-metadata entry from the resolved configuration. The existing usage resource, `model.attempt` envelope and recovery contract remain unchanged. The resource's model route supplies the observed model identity. Prepared requests use the active configuration's capacity only when its existing provider pin matches. Fallback or restored routes with an unproven capacity remain unknown. No core schema or recovery-format change is required.

Within the existing Session Store commit transaction, project only `model.attempt` events in `output_committed` state whose usage reference has kind `managed-hosted-model-usage` and schema version 1. Hook, started and abandoned attempts do not update occupancy. Validate the referenced resource against its committed Session scope and full reference, and read at most the existing 64 KiB resource limit.

Use one private SQL projection in `ma_session_record`: `record_kind=DOMAIN`, `domain=hosted_context_usage`, `record_id=latest`. It points to the committed usage resource and maintains its existing `SESSION_RECORD` resource reference. It emits no new `domain.committed` event and is not a title record. The source event sequence is the projection revision; `first_sequence` retains its initial source sequence. The Session head transaction serializes updates. Every newer qualifying success advances the pointer even if its metadata is missing, so an old observation cannot survive a newer unknown result.

The existing table checks permit this bound-Session projection. This context projection adds no DDL. Snapshot, task, relay and metadata consumers remain scoped to their existing domains; generic Session retirement and resource-reference cleanup cover this row. No startup backfill or journal scan is introduced.

## API and browser integration

Add optional `modelContext` to WebShell Session summaries: `modelId`, optional `inputTokens`, optional `contextWindowSize`, and `observedAt`. Return only these allowlisted fields, never raw resources, budgets, routes, credentials or cumulative metrics. A single Session reads one projection/resource pair; a list page loads observations in one batch after its existing authorization filtering. Existing providers and Sessions without observations remain compatible.

The Managed provider validates and projects this metadata. Existing conversations enable shared model and context-usage toolbar actions. An optional model-control disable flag locks selection while running, awaiting approval, changing model, or unsupported, and leaves Local defaults unchanged. Keep the usage control available with an honest unknown state until valid data arrives. Shared popovers continue using the WebShell portal root, scoped styles and viewport bounds.

## Same-Session model selection

Use synchronous WebShell `session-models/query` and `session-models/change` operations. Query returns the host catalog, current selection and capability. Change accepts a catalog model ID, expected revision and actor-scoped idempotency key. Authorize access before any replay; exact completed receipts replay before later configuration or idle checks. Reject conflicting key reuse, stale revision, unsupported Harness, non-public/unbound Sessions and any active Turn, approval, lifecycle or recovery work.

V5 follows the published V3 Session-list migration and this change's V4 Workspace-creation migration, preserving their resource bytes and history. It adds current model ID/revision to `ma_session` and a nullable immutable model ID/revision snapshot to `ma_turn`. Default revision zero leaves the original AgentDefinition model behavior intact. Under the same Session lock as admission, each user Turn copies the current selection; dispatch reads only that Turn snapshot. A model change clears the private latest context projection and its projection reference in the same transaction, preserving journal history. This also prevents A-to-B-to-A from reviving old A usage. Exact receipt replay never clears a later observation.

The SDK sends optional `modelSelection: {modelId, revision}` to the private Harness prompt route, gated by `model-selection/1`. The Harness validates and persists it in the existing `managed-admission` resource, and includes it in resident and cold prompt replay identity checks while keeping the existing prompt payload digest unchanged. Every execution and recovery reads that accepted input's selection; no mutable current choice replaces an in-flight Turn's pin. Fresh per-Turn configuration resolves the selected existing non-runtime model with cached credentials. Missing or ambiguous configuration fails closed as model unavailable. The immutable AgentDefinition header, prepared request schema and existing exact-route recovery remain unchanged. Autonomous wake inputs retain their existing AgentDefinition policy in this first slice.

The browser persists a pending mutation's exact Session, model, revision and key. Until a successful response is confirmed by a Session read, disable send, cwd changes and further selection; uncertain outcomes retry the same intent. Summary revision guards prevent stale polls from restoring old selections or usage. Switching preserves messages and shows context unknown until a new successful request supplies usage. Local controls and new-task AgentDefinition presets stay independent.

## Validation and acceptance

1. Baseline global CLI and browser observations establish that existing Managed conversations omit model and context controls while new-task presets already exist.
2. CLI tests prove metadata comes from the resolved configuration and latest Finished usage without changing model execution or recovery envelopes; absent/invalid capacity is not invented.
3. Java tests prove committed-main-only projection, scope/reference checks, monotonic replay, replacement by unknown, batch reads, safe-field projection and old-resource compatibility. The context projection needs no DDL; verify V4-to-V5 upgrade preserves existing Sessions and immutable Turn selections, with cleanup intact.
4. Frontend tests cover actual model display, idle model selection, busy controls, unknown and valid occupancy, refresh, Session isolation, Local defaults and new-task presets.
5. A new real-model demo task exposes a context snapshot matching committed native records; percentage and remaining values match arithmetic after refresh. Verify A-to-B-to-A within one Session, busy and approval locks, refresh persistence and continuous history. No tool effect or billing inference replaces that evidence. Check desktop and 390px popovers and preserve earlier Sessions and files.
6. Build, typecheck, bundle, focused tests, paired documentation, two clean self-audit passes and independent reviews complete before delivery. Only owned demo processes are updated while test Turns are quiescent.

## Open questions

There are no pending protocol decisions for this slice. Manual compression requires a separate admission and recovery design.
