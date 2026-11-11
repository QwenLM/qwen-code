# compression-v2 Module

## Runtime flow

`CompressionPipeline.compress()` is the shared implementation for main agents
and subagents. It locates the last compact boundary, applies the per-message
200,000-character tool-result budget, recalculates request tokens when history
changes, then calls `runAutoCompactStage()`.

`runAutoCompactStage()` checks automatic thresholds and failure tracking,
resolves the compact request model, runs PreCompact, and calls `runForkCompact()`.
Manual and reactive calls reuse the same pipeline with `force: true`.

Fork compaction uses one agent turn and the parent prompt/tool schemas for
prefix-cache reuse, with tool execution prohibited. The model emits
`<analysis>...</analysis><summary>...</summary>`; summary formatting removes
analysis. Media recovery and PTL retries live in `fork-compact.ts` and
`ptl-retry.ts`; cleanup tracks automatic failures without regenerating summaries.

After successful compaction the pipeline invokes PostCompact and
SessionStart(Compact). The host applies `newHistory`, persists the boundary and
summary, and restores attachments through `apply-post-compact.ts`.

## ModelProvider selection

The pipeline consumes `ModelSelection` and borrows the session's Manager.
`ensureCompactModelSelected()` runs only when a summary is needed and caches one
selection for hooks, the fork request and retries. Use nested `reasoning`,
`context` and `sampling` configuration. A selection's config is already merged
and clipped; never replace it with the parent config or merge preferences again.

Keep the host's `createCompactRequestResolver()` and manual `prepareParent()`
policy behavior behind the narrow `resolveCompactSelection` adapter. Preserve
SDK 404 recovery, explicit model intent, identity/abort guards, policy labels
and diagnostic source. Without an adapter, select `purpose: 'compact'` with the
parent selection and workdirs, protected by a request guard and abort race.
Do not restore legacy ModelRouter selection in the compression pipeline.

Pass the full selected `compactSelection` and policy labels to `runForkedAgent()`
with the compact / partial-compact label. The summary query uses `purpose: compact`;
only this purpose may reuse the prepared compact selection.
This preserves final reasoning/sampling/window settings and Provider-owned BYOK
material without another main-purpose selection or old credential projection.
Keep completion billing/usage callbacks and trigger-time usage snapshots.
Provider `select/inference` interfaces and model definitions remain unchanged.

## Synchronous segmentation and handoff restoration

Synchronous compaction always summarizes the older response groups and preserves
the latest complete response group, its tool results and following input verbatim.
No environment variable or feature gate is required. If no older response exists
or retaining the tail would replay an orphan tool call, use full-summary recovery.
Local `responseGroupId` metadata is persisted but never sent to the provider.

Retain initial session announcements in prefix order and restore their delta
baselines, so continuation and resume do not duplicate Skill/Agent/MCP listings.
File recovery rereads current disk contents through Read with permissions and
budgets; only delivered complete reads establish Edit baselines. Oversized files
remain references. Preserve summary, prefix and retained tail placement on resume.
Persist the retained response group's UUID order in the compact boundary and
select its tail as the active transcript leaf. Resume relinks existing records
after the new prefix, including parallel tool results, without duplicating UUIDs.

## Removed strategies

Snip, Microcompact, Context Collapse and Session Memory compaction are removed.
Do not add their configuration, state, callbacks or request projections back
implicitly. The ordinary AGENTS/rules and Auto Memory mechanisms are separate
and remain active, including `MemoryContextManager.refresh('compact')`.

State loading accepts older envelopes and keeps only tool replacement decisions
and seen tool-result IDs. Existing transcript records and summary sidecar files
are not deleted by the removal; legacy attachment DTOs remain readable.

## Validation

Cover threshold accounting (history, prefix, pending input and fixed overhead),
tool-output persistence, automatic/manual/reactive compaction, Hook ordering,
failure handling and older state loading when changing this module.
