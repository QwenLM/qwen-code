# Structured recall: three-PR delivery plan

Source: #10183 at `38b9b7ce8f7cbc03537cd2bff2b294c8e1e267f4`.

The objective is to land the original structured on-demand recall capability
in dependency order. Line-count reduction is not an acceptance criterion.
Foundation code with a concrete downstream owner belongs in the split even
before the final runtime is enabled. Simplification must preserve the agreed
capabilities and their correctness dependencies.

## Merge order

1. **#12726 — structured memory data and retrieval.** Metadata parsing and
   validation, trusted scans, source completeness, scoped references, tree
   rendering, search/fetch/explore, body windows and cursor validation.
   The structured scanner is separate from the existing scanner so the
   legacy parser, recall, forget and index candidate universe stay intact.
   The engine is callable and independently testable; model registration and
   default activation belong to PR 3. No session-token saving is claimed.
2. **New PR — migration and writer compatibility.** Body-preserving atomic
   metadata migration, corpus readiness, writer vocabulary, and necessary
   Remember/Extraction/Dream adapters. Depends on PR 1. Preserve legacy
   recall until activation. Background scheduling and protocol switching
   remain in PR 3; do not add an unrelated Dream scheduling feature.
3. **#10183 — runtime integration and activation.** Config/manager, CLI and
   ACP delivery, model-facing tool registration, selection, body residency,
   compaction invalidation, migration scheduling, activation/rollback and
   the telemetry needed to measure the result. Depends on PRs 1 and 2.

Each PR targets main when its predecessors have landed. Until then, the
second PR can target the first branch to show only its incremental diff.
The original PR is reduced after the extracted changes land; do not delete
its source work or rewrite its shared history during extraction.

## Source ownership

| Source area                                      | Owner                                       | Acceptance                                                                       |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------- |
| scan/types/paths/trusted filesystem/tree         | PR 1                                        | Structured metadata and bounded trees; legacy consumers retain their contract    |
| memory/search-memory                             | PR 1                                        | Search, exact fetch, explore, stable refs, bounded windows and validated cursors |
| metadata-migration/indexer/writer vocabulary     | PR 2                                        | Preserve body bytes, reject concurrent edits, keep incomplete corpora unready    |
| remember/extract/Dream writers                   | PR 2                                        | New writes remain compatible with structured metadata; preserve legacy operation |
| config/manager/client/ACP/agent adapters         | PR 3                                        | Tool and prompt activation is atomic across entry points                         |
| tools/search-memory or manage-memory integration | PR 3                                        | Actual registered tool reaches the PR 1 engine                                   |
| microcompaction/memory pressure/history state    | PR 3                                        | Evicted content can be fetched again; resident versions are not delivered twice  |
| telemetry and user documentation                 | PR 3                                        | Measure actual delivery and document final behavior                              |
| code-mode timing and unrelated test setup        | Exclude unless a dependency is demonstrated | Record the reason before removing any source change                              |
| direct file/shell access restrictions            | Verify source before deciding               | Do not inherit stale PR-body claims or invent new behavior                       |

## Review constraints

- Preserve every core capability across the three PRs; record any intentional
  simplification with its replacement and consumer.
- Do not enable an extra project root in legacy recall/forget. Before the
  structured runtime enables multiple roots, resolve identity collisions,
  deletion of physical copies and index rebuilding for the affected root.
- Keep body residency and compaction invalidation in the same runtime PR.
- Do not activate metadata-only prompts before the body retrieval tool is
  registered, discoverable and usable.
- Keep migration readiness and activation/rollback consistent. Partial or
  unreadable sources cannot be declared ready.
- Review source code rather than trusting old descriptions or green tests.

## Verification and measurement

PR 1: focused parser/scan/tree/retrieval tests plus legacy scan compatibility.
PR 2: migration body preservation, concurrent edit rejection, partial failure,
and relevant writer tests. PR 3: first-turn recall, irrelevant-memory control,
fetch/re-fetch, changed files, compaction, tool discovery and CLI/ACP parity.
Use targeted local checks; leave whole-repository validation to remote CI.

Only PR 3 can substantiate session-token savings. Compare the same corpus,
task, model and settings. Report main-model input, selector/migration/Dream
usage and cache reads separately. Disabling auto memory is not an implemented
optimization. Original PR benchmark numbers do not establish split-PR gains.
