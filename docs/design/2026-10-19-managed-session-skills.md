# Managed Session static Skills

[English](2026-10-19-managed-session-skills.md) | [简体中文](2026-10-19-managed-session-skills.zh-CN.md)

## Problem and current state

Managed AgentDefinitions already publish bounded static Skill catalogs. Each
Session pins its definition revision and digest, and the Hosted Harness loads
the published bodies through its `skill` tool. Managed Web Shell does not query
this catalog or enable the composer's Skills menu. A leading `/name` is currently
ordinary prompt text, and Plan mode excludes the instruction-only tool.

## Scope and ownership

Expose the existing Session catalog and connect selection to actual loading for
Workspace-bound Sessions, including local and SSH Workspaces. The control plane
reads immutable definition data; the Harness loads instructions; Workspace tools
retain their existing Runtime ownership and approval policy. No filesystem Skill
discovery, installation, dynamic activation, argument expansion, model override,
MCP configuration, or file-reference support is added.

## Proposed changes

### Session catalog

Add `POST /api/agent/web-shell/v1/session-skills/query`, accepting the existing
Session request shape and returning `skills` containing only `name` and
`description`. This is a persisted Session-scoped read with the `READER_ACTOR`
rule: require an actor, visible tenant-scoped Session, and current Workspace read
grant before accessing its pinned definition. Reuse `pinnedContent` and the
existing Skill validator, including digest validation. Never resolve the latest
AgentDefinition or contact a Runtime. Built-in agents and definitions without
Skills return an empty catalog. Snapshot read-only child profiles also return an
empty catalog because their Harness does not expose Skills. Missing or
inconsistent pins fail visibly.

Keep OpenAPI, generated Web Shell types, the surface registry, and admission
contract tests synchronized. There is no schema migration or new durable state.

### Composer

The Java provider exposes an optional catalog reader. A Session-scoped hook loads
on opening the Skills menu, caches successful immutable results, aborts on scope
changes, and suppresses late results from another Session. Reuse ChatEditor's
existing Skills submenu, loading, error, empty states, and `/name` insertion.
Reopening after a failed request retries. New Sessions without an assigned
Session ID do not query a guessed definition. Keep other Workspace capabilities
controlled by their existing interfaces.

### Explicit invocation and loading

Before the first model request, recognize consecutive leading `/name` tokens
that exactly match the pinned catalog. Load distinct selected Skills as a pure
`skill` batch through the existing Hosted tool executor. Preserve the user's
prompt and attachments, journal the synthetic assistant calls and tool results,
and supply those results to the model. A published body must therefore reach
model context even if the model would otherwise answer without calling tools.
Unmatched slash text retains its current meaning. The remaining prompt is task
input, not Skill arguments or an activation configuration.

Run normal Session and prompt Hooks before loading. Reuse PreToolUse,
PostToolUse, batch Hooks, refusal behavior, and inline limits. Loading never runs
scripts, widens permissions, or calls the Runtime's filesystem. Recovery uses
the committed calls and results through the existing Skill recovery path;
resumed model and tool continuations must not synthesize another activation.
Allow `skill` in the public Plan read set while preserving pure-Skill batching
and all write, Shell, and plan-approval restrictions.

## Affected areas

Managed Agent API/service/model records and contract tests; Web Shell generated
API, Java client/provider, Session composer, and a catalog hook; Hosted Skill
catalog, model loop, Plan policy, and focused tests. This extends the existing
[static Skill design](2026-10-15-managed-agent-extension-config.md).

## Verification and acceptance

1. A Session created at revision 1 lists and loads revision 1 after revision 2
   changes the catalog; a new Session sees revision 2.
2. Reader access succeeds, absent actors and unauthorized/cross-tenant or deleted
   Sessions fail before catalog access, and empty catalogs have an explicit UI
   state. No body or host path is returned in the menu response.
3. Menu selection prepends the invocation. The first deterministic model request
   contains the selected body's tool result, the original task, and attachments.
4. Explicit invocations obey Hooks, deduplicate selected names, and remain
   bounded to the published catalog. Normal prompts and model-selected Skill
   calls retain their behavior.
5. Plan mode permits static instruction loading and continues to refuse writes
   and Shell. Restore/recovery does not replay a completed activation.
6. Session switching, provider changes, request errors, and late replies cannot
   expose a previous Session's Skills.

The executable plan and results live in
`.qwen/e2e-tests/managed-session-skills.md`. Run focused Java and TypeScript
tests, API generation, Java verification, root build/typecheck/bundle, changed
file lint/format checks, and two clean full-diff audits. Report environment and
process-test limits separately from verified behavior.

## Open questions

None for this slice. Publishing and installing new Skills remain administration
tasks outside the composer.
