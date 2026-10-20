# Memory index omission diagnostics

[English](memory-index-omission-notice.md) | [简体中文](memory-index-omission-notice.zh-CN.md)

## Problem and scope

Issue [14877](https://github.com/QwenLM/qwen-code/issues/14877) reports that index rebuilding omits topic files without naming them. The existing scan parses all eligible files but returns only 200; subsequent index budgeting can omit more entries. A generic writer warning loses both sets before prompt loading can explain them.

This fix changes diagnostics only. Headless post-write rebuilding, retention policy, topic-file deletion, scanner trust rules and existing PRs are out of scope.

## Approach

The index-only scan returns the same retained documents plus the omitted tail. Project/user selection remains newest-first; team selection remains deterministic by relative path, with grouping after the scan cap. Other scanner consumers keep their existing APIs and behavior.

The writer reports index-budget omissions and scan-cap topic-file omissions separately, with a count and up to three bounded names per set. When both apply, it also gives the combined count. It distinguishes excessive entry count from overlong entries and does not claim all omitted entries are necessarily oldest: character-budget backfill can retain later short entries.

The reader keeps the writer's single-paragraph warning outside the entry budget instead of discarding it or counting it as another entry. Only a trailing notice with the known writer prefix and at most 1024 UTF-16 code units qualifies; arbitrary long warning-like text is still budgeted. Reader-side truncation, if separately required, retains the writer warning and adds its own diagnostics.

## Constraints and consumers

Keep the 200-file scan cap, 200-line index cap, 25,000 UTF-16-unit entry-body budget and 150-unit ordinary-entry priority. Topic files remain untouched. Existing title sanitization and surrogate-safe 60-unit diagnostic names are reused.

The changed internal scan is consumed only by project/user/team index rebuilding. Existing builders retain compatible optional arguments. Rebuild callers include save/extract, Dream, forget, managed-write refresh and metadata migration; their routing and error handling do not change. All project/user/team prompt sections use the same notice-aware reader. No daemon route or package boundary is added.

## Validation and acceptance

Reproduce on exact main with synthetic filesystem stores, then compare retained entries and ordering after the fix. Cover character-only, scan-only and combined omissions; under-budget silence; non-tail oversized omissions; bounded hostile/astral names; all three scopes; prompt round-tripping; and unbounded handwritten warning-like text. New regressions must fail with the original production sources. Run relevant memory suites, build, bundle, typecheck, formatting and lint.

The baseline source-runtime reproduction is confirmed. Final verification results belong in the PR report; this document does not claim model, interactive CLI or ACP execution. The released CLI is unavailable locally, so the recorded fallback exercises actual filesystem writer/reader sources without model requests.
