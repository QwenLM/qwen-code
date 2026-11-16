# Converging Read unchanged-dedup with the 1.0.0-preview lineage

[English](read-dedup-convergence.md) | [简体中文](read-dedup-convergence.zh-CN.md)

Status: implemented design, 2026-11-16. Ships with the change set that updates the placeholder wording and adds ranged-read dedup.

## Problem and current state

Two lineages implement "this file was already read, do not re-emit it" dedup for the Read tool:

- **main** — a dedicated `FileReadCache` service (inode-keyed, metadata-only). Its fast-path serves the placeholder only for no-args full reads whose whole-file view is sticky-resident. The placeholder is a long, hedged paragraph that names its assumptions and ends with a recovery instruction. Auto-memory files are recorded but never served the placeholder. Residency is disarmed at every site where content fails to reach model history: idle microcompaction blanking, compression eviction, execution-environment invalidation, and nested code-mode reads.
- **v1.0.0-preview** — a short-circuit at the top of the text-read path. It dedups any repeated identical `offset`/`limit` request against an mtime-only fingerprint, returns a blunt one-line "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.", exposes a per-invocation `dedupUnchangedReads` opt-out, and tags the result with a structured `file_unchanged` payload.

A line-by-line audit found preview gaps (mtime-only fingerprint, no auto-memory exclusion from dedup, tool-result-budget truncation not reflected in residency) and main gaps (ranged re-reads always re-emit bytes the model already holds; no structured placeholder result; no per-invocation opt-out). This change converges the two wins from preview that land cleanly on main; the rest are deferred with reasons.

## Decisions

### 1. Placeholder wording: preview's base plus main's recovery path

New text: `Wasted call — file <path> unchanged since your last Read. Refer to that earlier tool_result instead. If you cannot retrieve that earlier result (e.g. after context compaction) or suspect the file was modified outside the read/edit tools, re-read with explicit offset/limit.`

The appended sentence is functional, not polite: a no-args re-read satisfies the fast-path conditions again and would return the same placeholder, so an explicit `offset`/limit re-read is the only escape from the dedup loop. The compaction example names the one case where "refer to that earlier tool_result" is guaranteed to fail. Dropping either clause (as preview's wording does) leaves the model with no recovery path.

### 2. Ranged-read dedup, additive to the existing full-read half

- The read pipeline gains `contentLengthTruncated`, separated from the existing combined `isTruncated`: the latter is also true for an explicit `offset`/`limit` slice whose request was fully satisfied, so it cannot distinguish "the cap cut the view" from "the request asked for a slice".
- `FileReadEntry` gains a recorded view: `lastReadRange` (`'full'` | `{ offset, limit }` | `undefined`) plus `lastReadRangeResident`. A view is recorded only for cacheable (plain-text), non-cap-truncated reads; page-based (PDF) reads record none because a page view is not a line range. The most recent read overwrites the view.
- The fast-path keeps the full-read half byte-identical (sticky `lastReadWasFull` + `readResidentInHistory`) and adds a ranged half: exact view equality plus `lastReadRangeResident`. Both halves keep the fresh mtime+size fingerprint, `lastReadCacheable`, and write-newer-than-read checks.
- `markReadEvictedFromHistory` / `markAllReadsEvictedFromHistory` disarm both residency flags together, so blanking a ranged result kills its quote-back exactly as it kills the whole-file one.
- Cap-truncated views are never recorded: the cap is a session setting, not a file property, so the on-disk fingerprint cannot promise the same cut on a later read.

### 3. Deferred to follow-up issues, with reasons

- **Structured `file_unchanged` result.** main's `ToolResult` has no `toolUseResult` channel and no consumer reads one; adding a single producer would create a dead channel. Needs a cross-package contract change plus at least one consumer (Web Shell or SDK) in the same change.
- **Per-invocation `dedupUnchangedReads`.** main has no invocation-context API; the only non-model-facing ReadFileTool caller found is the managed CSI file worker's host-driven retirement/composition flow, whose Config/FileReadCache sharing semantics need managed-domain review before wiring an opt-out. Shipping the flag without a setter would be a dead switch.

## Constraints

- The full-read placeholder behavior is unchanged: same flags, same order, same exclusions (auto-memory, nested code-mode reads, disabled-cache escape hatch).
- The ranged half must never widen what a no-args Read may quote; it only adds quote-back for views the model actually received.
- `priorReadEnforcement.ts` must not start consulting the new fields: read-before-write needs only "the model saw text" plus a current fingerprint.

## Acceptance

- `fileReadCache.test.ts`: view recorded for satisfied ranged reads and untruncated full reads; no view for cap-truncated, non-text reads; most-recent-read overwrite; both eviction helpers disarm the ranged view.
- `read-file.test.ts`: identical ranged Read returns the placeholder without echoing bytes; a different range serves content; a cap-truncated first view never dedups; a full Read between ranged Reads re-emits once before dedup resumes; eviction re-emits bytes.
- The five test files that pinned the old placeholder string assert the new wording.
- Existing full-read, eviction, nested-read, binary, and microcompaction suites stay green.
