# Managed Workspace basic tool alignment

[English](2026-11-06-managed-basic-tools.md) | [简体中文](2026-11-06-managed-basic-tools.zh-CN.md)

## Status and scope

Implementation design, 2026-11-06. This change covers ordinary Managed Workspace
file and Shell sessions: file discovery, durable todos, and PDF page selection.
It does not add structured questions, grep, LSP, or other daemon features.

## Problem and current behavior

Built-in file sessions select `hosted-workspace-files/1`, which lacks `glob`.
Ordinary Shell sessions select `hosted-workspace-shell/1`, which has `glob` but
lacks `todo_write`.
`hosted-workspace-files/3` already implements durable Session todos. Ordinary
Hosted file execution already forwards `read_file.pages` to Core, but its model
declaration omits the parameter.

The existing profiles already govern lifecycle, approvals, Plan mode, extensions,
and recovery. Extend their tool declarations directly. Historical Session tool
vocabularies and old tool schemas are not compatibility requirements for this
change. The private CSI executor shares the file declaration but rejects `pages`.

## Proposed behavior

| Session                        | Profile                          | Added capability     |
| ------------------------------ | -------------------------------- | -------------------- |
| Ordinary Hosted file session   | `hosted-workspace-files/1`       | `glob`               |
| Ordinary Hosted Shell session  | `hosted-workspace-shell/1`       | Durable `todo_write` |
| Resident/CSI Workspace session | Existing restricted file profile | None                 |

No new profile version, default-selection logic, capability negotiation, or
Java/SDK adaptation is needed. Creation and load use the same current tool
declarations; they do not select an old tool vocabulary. Existing receipt
idempotency and persisted Session identity remain necessary correctness rules.
The separate file-search, todo-enabled file and read-only child profiles keep
their existing roles. SSH retains its foreground-only execution limits; glob
uses the existing native file path and todos use the Session journal.

Native `glob` is intentionally pre-approved on ordinary file sessions, as on
the existing search and Shell profiles. Undeclared calls are refused before
approval. MCP tool names remain isolated as `mcp_<digest>` aliases and retain
their existing approval requirements even when the server calls a tool `glob`.

Normal Hosted `read_file` declarations, including read-only children, expose the
existing optional `pages` parameter. This additive declaration matches execution
that already exists; it does not add a tool name. Resident/CSI declarations stay
unchanged. Core remains responsible for page validation and extraction: page
numbers start at 1, single pages and closed ranges are supported, and one request
may select at most 20 pages. Result budgets do not change. Oversized PDF results
suggest a smaller `pages` range; text results retain `offset`/`limit` guidance.
The declaration uses Core's page-limit constant so its guidance stays aligned
with execution.

Recovery requires an exact match with the current tool declaration. A pending
read saved with an old schema is refused; no fallback removes `pages` for matching.
Development sessions with incompatible pending work must be recreated.

## Components and boundaries

The existing Java admission, Turn snapshots, approvals, Plan and lifecycle
contracts continue to apply to `files/1` and `shell/1`. Glob is added through the
ordinary profile predicate, not to the shared restricted file-tool array. The
resident/CSI path must continue to declare and execute only read/write/edit.
No Java/SDK production change or database migration is required.

The Harness uses the same exact profile vocabulary across create, load, tools,
approvals, and recovery. Todos reuse the current Session todo persistence,
validation, projection, and replay behavior. They remain excluded from Plan
mode's read-only tool set and do not become a Runtime filesystem operation.
Workspace restore validates the `todo_state` domain and follows its saved record
chain, so loading a detached Session can restore and reinject the current list.

Affected implementation areas are `packages/cli/src/serve` profile predicates,
tool declarations and Session restore, plus focused unit and packaged-process
tests. Core PDF parsing and existing Java/Web Shell todo projection are reused.

## Validation and acceptance

1. Ordinary `files/1` declares and executes `glob`; `shell/1` declares `todo_write`.
2. Create and load use the current declarations. Recovery refuses an outdated
   saved read schema. No historical-vocabulary or schema fallback is present.
3. Existing approval, Plan, lifecycle, extension and child-agent behavior keeps
   its current profile contracts. Resident/CSI and SSH execution restrictions
   remain enforced.
4. Shell todos survive a session reload and retain existing validation and
   event projection. Invalid todo bodies and missing ancestors refuse load
   before a model call. Plan mode does not advertise todo writes.
5. Hosted declarations and forwarded requests include `pages`. A real three-page
   PDF read of page 2 returns only its marker. Invalid and excessive ranges fail
   through Core validation; ordinary text line reads still work. CSI does not
   advertise `pages`.
6. Run focused TypeScript tests, build, typecheck, and a packaged
   Harness process fixture with a deterministic local model. Record baseline and
   local verification in `.qwen/e2e-tests/managed-basic-tools.md`.

Java/SDK production code is unchanged; the Hosted Java fixture's exact tool
sets are updated to match ordinary declarations. Its execution remains pending
CI because the shared local Java validation budget is exhausted. Full CI, Linux,
and deployed Hosted qualification remain separate evidence unless actually run.
Fixture success is not real-model or production acceptance.

## Risks and open questions

The main risks are exposing ordinary tools to restricted CSI sessions and
accepting outdated saved schemas. Verify the declarations and execution refusal
paths separately. There are no unresolved product decisions within this scope.
