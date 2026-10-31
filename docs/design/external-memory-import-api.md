# External memory import API v1

[English](external-memory-import-api.md) | [简体中文](external-memory-import-api.zh-CN.md)

## Capability and ownership

Check `/capabilities` for `memory_import_v1`. Select a trusted active workspace
from its `workspaces` list. Every route below is under
`/workspaces/{workspaceId}/memory/import`; there is no implicit-primary route.
Use the same authentication, origin/CSRF and mutation authorization as other daemon
workspace routes. Responses are private and not cacheable. SSH workspaces and
legacy `QWEN_CODE_MEMORY_BASE_DIR` / `QWEN_CODE_MEMORY_LOCAL` path overrides are not supported in v1 and fail closed.
No DataAgent or other host-product changes are included.

## Source and offline preview

The source envelope is `{version:1, source:"codex", files:[{path,content}]}`.
Paths are relative to the selected Codex memories folder. Accepted resources are
`MEMORY.md`, `memory_summary.md`, and referenced `rollout_summaries/*.md` files.
These are distilled Markdown resources, not raw session JSONL. Symlinks,
traversal, credentials, configuration and skills are excluded. Limits are 256
files, 512 KiB per file, 8 MiB total decoded source and 64 KiB per selectable
section and 4,096 headings in total; HTTP's existing 10 MiB JSON-body limit also applies. Selected contextual snapshots are limited to 16 MiB serialized JSON, and each consolidation request to eight sections / 64 KiB of source plus 32 KiB of same-scope context. Oversized input is rejected, never silently truncated. Before Markdown parsing, source sets are limited to 16,384 line breaks and 4,096 inline syntax markers (`* _ ~ [ ] < > !` plus backticks, ampersands and backslashes), conservatively including code blocks. Expanded preview context, including repeated ancestor text, is limited to 8 MiB. Split oversized source sets into smaller groups.

`POST /preview` accepts the source envelope. It does not retain files, start a
model or create memory/task records. Sending it to a server does transmit its
contents; hosts requiring browser-local preview should present their own local file preview before this request. The Qwen parser is shared by CLI and server, not shipped as a browser library. It is not a promise
of zero network transport by the external UI.

The versioned preview contains `digest`, `groups`, `sections` and `warnings`.
Each section has stable `id`, `groupId`, source `path`/`line`, complete contextual
`content`, `references`, `suggestedScope`, optional `sourceProject`, `reason` and
`selectable`. Suggested scopes are `project`, `user`, `unassigned`; suggestions
never authorize a destination. Hosts may initially select every selectable item,
but must ask for a scope mapping before submitting unassigned items. Missing
supporting references are warnings; unreferenced supporting resources are excluded.

## Confirm, observe and control

| Method and suffix                       | Request                                            | Result                                |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| POST `/batches`                         | `{source, selection:[{id,scope}], idempotencyKey}` | 202 durable task                      |
| GET `/batches`                          | none                                               | tasks for this workspace              |
| GET `/batches/{id}`                     | none                                               | durable status and counts             |
| GET `/batches/{id}/sources/{sectionId}` | none                                               | selected retained source section      |
| POST `/batches/{id}/cancel`             | none                                               | cancelled/terminal task               |
| POST `/batches/{id}/retry`              | none                                               | 202 task with unfinished items queued |

`scope` is `project` or `user`, relative to the explicitly selected workspace.
Map another source project by submitting its selected sections to another
workspace ID. No target paths are accepted. Only selected sections are retained
or sent to the model; supporting sections must also be explicitly selected.
The idempotency key is 1–128 letters, digits, underscores or hyphens. Reusing it
with a changed selection is rejected; repeating the same request returns its batch.

Tasks expose `version:1`, `kind:"task"`, `id`, `status`, creation/update times,
`items` and `result`. Status is queued, running, completed, partial or cancelled.
Items distinguish pending, added, duplicate, conflict, skipped and failed, with a
reason and native memory refs for additions. Result counts distinguish source
sections from new native documents. A completed task can contain conflicts that
need caller review. Retry processes only pending/failed items, not conflicts or
successful items. Cancellation prevents further publication; a provider request
already in flight may finish, but its result is discarded. Model responses are scope-validated before retention; retry can regenerate scope-invalid items retained by older versions without resetting usage or changing valid sibling records. A CLI reader closing its output pipe early does not turn completed work into an error; use the idempotency key to retrieve the result again.

HTTP 400 `memory_import_rejected` identifies invalid source, selection, batch ID, unsupported legacy memory overrides, or admission while managed memory is unavailable; 404 `memory_import_not_found` identifies a missing batch. Submit and retry refuse admission with that 400 before charging task usage when the workspace's managed memory is unavailable, so a workspace that can never import does not exhaust its budget. Generation closure or draining returns 503 `workspace_runtime_unavailable` with `Retry-After: 1`. Unexpected storage/service failures return 500 `memory_import_failed`, with details confined to daemon logs. Retry submission with the same idempotency key, or retry/status requests with the same batch ID, after resolving the failure. Existing authentication, mutation and trust rejection rules remain in force.

A 202 response acknowledges durable admission, not completed publication. Once submit or retry has returned its durable task, a subsequent runtime closure does not discard that receipt or its task ID. Background work still checks the runtime before publishing; clients query the task after the workspace becomes available again. Reads, including retained source content, recheck runtime access before responding.

Registered runtimes recover queued/running batches when the daemon activates the
service; later registered runtimes recover on first import task access. If recovery fails, task endpoints return 503 `memory_import_recovery_unavailable` with `Retry-After: 1`, rather than reporting stalled tasks as running. Restore storage access and repeat the request: it retries recovery without discarding the service or its worker deduplication. Concurrent requests share the same recovery attempt, and a successful attempt is cached. Preview remains independent of recovery. Recovery errors are logged locally; source content and storage paths are not included in the HTTP error. Model failures
require explicit retry. Restart recovery waits for a crashed worker’s 120-second lock lease to expire; it does not require manual lock deletion. A lost task or scope lock aborts only its dependent work and prevents further journal/publication replacements by that holder once loss is detected; it does not cancel unrelated tasks. Unknown retry IDs are rejected before allocating task directories. Source snapshots and task journals are private runtime
state outside Git repositories and outside native memory scanning. Native search,
fetch, recall and forget can operate on published documents. Source inspection is
restricted to the owning workspace and retained selection.

## Minimal host example

```js
const base = `${daemonUrl}/workspaces/${encodeURIComponent(workspaceId)}/memory/import`;
const preview = await authenticatedJson(`${base}/preview`, {
  method: 'POST',
  body: JSON.stringify(source),
});
// Render preview, then obtain explicit selection and target scope from the user.
const task = await authenticatedJson(`${base}/batches`, {
  method: 'POST',
  body: JSON.stringify({
    source,
    selection,
    idempotencyKey: crypto.randomUUID(),
  }),
});
const status = await authenticatedJson(`${base}/batches/${task.id}`);
```

`authenticatedJson` is the host's existing daemon transport, including its auth
and mutation headers. The example does not introduce a second credential flow.
Use the source-view endpoint for full retained text rather than filesystem paths.
Do not log uploaded content or include it in bug reports by default.

## CLI

`qwen memory import codex --source <folder> --dry-run --json` is fully offline and
does not load model authentication or write memory. Omit `--source` to use
`$CODEX_HOME/memories`, falling back to `~/.codex/memories`.

To authorize consolidation, provide `--apply --selection <selection.json>
--idempotency-key <key>`. The selection file is the explicit array of section IDs
and scopes. The current trusted local project is the destination; invoke in another
project to map another group. Qwen uses its configured model. `--apply` and
`--dry-run` are mutually exclusive. `--retry` retries unfinished items for that
same key. CLI confirmed imports wait for the task and print its JSON result;
conflicts, partial results and cancellation produce a nonzero exit status. Bare/safe mode supports offline preview but rejects confirmed import, consistently with native managed memory availability.

## Cost estimates and task budget

Preview includes `estimate` and `groups[].estimate`: `modelCalls`, `sourceTokens`,
`maxOutputTokens`, `reservedTokens`, `exceedsBudget`, and `limits`. Estimates cover
all selectable sources; unmapped groups are provisional. `modelCalls` is an upper
bound: a preview group can be mapped across both `project` and `user`, and the
estimate counts each of the two scope layouts, so an explicit selection can only
stay at or below it. Offline preview neither reads native memory nor invokes a
model; it reserves up to 32 KiB context and a bounded prompt/schema allowance per
batch. Actual selected groups, previous imports and relevant existing context can
reduce the reservation. This is not a billing quote.

Each task exposes `usage.modelCalls`, `usage.reservedTokens` and `budget`. Limits are
32 logical invocations and 512,000 reserved token units, including an 8,192-token
output allowance per request. Reservations persist before requests and survive
failure, restart, cancellation and retry. `partial` results identify budget exhaustion
or oversized metadata/relevant evidence in `items[].reason`. Retrying an exhausted
task does not replenish its allowance. Confirm a smaller new selection explicitly;
previously processed per-source identities still deduplicate across tasks. Legacy
tasks lacking reservation records have a zero model budget and zero recorded usage; their historical usage is unknown.

The model context contains the complete bounded same-scope metadata index and relevant
full bodies; index-only entries are marked. An index or relevant evidence exceeding
32 KiB fails before invoking a model. Native snapshot checks still cover all existing
content, including bodies not sent to the model. Provider-internal retries and token
accounting differ; logical-call/reservation limits are not guaranteed billed-token
or monetary caps. Normal memories and authentication policy are unchanged.
