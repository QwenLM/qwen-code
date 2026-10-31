# Memory index omission diagnostics

[English](memory-index-omission-notice.md) | [简体中文](memory-index-omission-notice.zh-CN.md)

## Problem and scope

Issue [14877](https://github.com/QwenLM/qwen-code/issues/14877) reports that index rebuilding omits topic files without naming them. The existing scan parses all eligible files but returns only 200; subsequent index budgeting can omit more entries. A generic writer warning loses both sets before prompt loading can explain them.

This fix changes diagnostics only. Headless post-write rebuilding, retention policy, topic-file deletion, scanner trust rules and existing PRs are out of scope.

## Approach

The index-only scan returns the same retained documents plus the omitted tail. Project/user selection remains newest-first; team selection remains deterministic by relative path, with grouping after the scan cap. Other scanner consumers keep their existing APIs and behavior.

The writer reports index-budget omissions and scan-cap topic-file omissions separately, with a count and up to three bounded names per set. It does not add the two counts: a grouped team entry can represent several topic files. Scan-only omissions describe an incomplete topic catalog and suggest merging topic files or removing obsolete ones; only actual entry-budget overflow claims the index is too large. Mixed cases give the action for each limit. Only sampled omitted files are formatted. It distinguishes excessive entry count from overlong candidates and does not claim all omitted entries are necessarily oldest: character-budget backfill can retain later short entries.

Writer advice targets the underlying topic files, not temporary edits to the generated index. Overlong writer entries already omit descriptions, so their length remedy is shortening paths or frontmatter names. Advice to shorten overlong links is used only when the candidate body exceeds the character budget and shortening overlong entries to the ordinary line limit would bring that body within budget. When the candidate body still exceeds the character budget at ordinary line lengths, the writer reports cumulative entry length and offers shorter topic-file paths or frontmatter names/descriptions, as well as merging/removal. It does not equate cumulative character pressure with exceeding the entry-count cap. A pure line-count overflow never gets length advice. The reader can also load handwritten entries, so it retains its separate detail-moving advice when the candidate character budget actually binds.

The reader keeps the writer's single-paragraph warning outside the entry budget instead of discarding it or counting it as another entry. Only a trailing notice with a known budget/scan-cap writer prefix and at most 1024 UTF-16 code units qualifies; arbitrary long warning-like text is still budgeted. New pointer lines must be inserted above a trailing warning so it remains the last paragraph; appending a pointer after it removes the exemption. The save instructions and user documentation state this boundary. The legacy budget prefix remains recognized. Reader-side truncation, if separately required, retains the writer warning and adds its own diagnostics, considering only the first 200 candidate entries when choosing length-related advice.

Extra blank separators before a recognized notice are not index entries. Short multiline tails remain budgeted rather than being preserved as writer metadata. Arbitrary-root rebuilding reports the same scan omissions as scoped rebuilding while preserving its existing mtime selection, including its compatibility team-root mode; the normal shared team rebuild keeps deterministic path ordering.

## Constraints and consumers

Keep the 200-file scan cap, 200-line index cap, 25,000 UTF-16-unit entry-body budget and 150-unit ordinary-entry priority. Topic files remain untouched. Existing title sanitization and surrogate-safe 60-unit diagnostic names are reused.

The changed internal scan is consumed only by project/user/team index rebuilding. Existing builders retain compatible optional arguments. Rebuild callers include save/extract, Dream, forget, managed-write refresh and metadata migration; their routing and error handling do not change. All project/user/team prompt sections use the same notice-aware reader. No daemon route or package boundary is added.

## Validation and acceptance

Reproduce on exact main with synthetic filesystem stores, then compare retained entries and ordering after the fix. Cover character-only, scan-only and combined omissions; under-budget silence; non-tail oversized omissions; bounded hostile/astral names; all three scopes; prompt round-tripping; and unbounded handwritten warning-like text. New regressions must fail with the original production sources. Run relevant memory suites, build, bundle, typecheck, formatting and lint.

The baseline source-runtime reproduction is confirmed. Final verification results belong in the PR report; this document does not claim model, interactive CLI or ACP execution. The released CLI is unavailable locally, so the recorded fallback exercises actual filesystem writer/reader sources without model requests.
