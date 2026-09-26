# Structured recall: split of #10183

Source: [#10183](https://github.com/QwenLM/qwen-code/pull/10183),
commit `38b9b7ce8f7cbc03537cd2bff2b294c8e1e267f4`.
First extraction base: `16496a71ec` (main, 2026-09-26).

The original PR spans 112 files and several independently reviewable changes.
The split preserves its on-demand recall objective. It does not treat the
original PR's benchmark results as measurements of these smaller branches.

## Delivery order

| Part                         | Behavior and boundary                                                                                                                                                                    | Depends on |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1. Metadata and tree         | Parse scoped metadata, scan trusted roots, report incomplete sources, and render bounded metadata trees. Preserve the existing body-delivery protocol.                                   | main       |
| 2. Bounded retrieval         | Extract the search/fetch/explore engine, scope-qualified refs, body windows, and cursor validation. Keep the model-facing tool registration with runtime integration.                    | Part 1     |
| 3. Runtime activation        | Wire the memory tool and metadata delivery into both CLI and ACP. Keep body residency, invalidation, and compression cleanup together. Include only telemetry needed to verify delivery. | Parts 1–2  |
| 4. Existing-memory migration | Add metadata writers, background migration, readiness/activation, and the required Dream/Remember/Extraction integration. Keep old memories usable until conversion succeeds.            | Part 3     |

Part 1 is the first extracted branch. Parts 2–4 remain pending until their
code and validation are published. These are dependency boundaries, not a
promise that every original hunk belongs in the final implementation.

Part 3 must either remain opt-in until Part 4 lands or provide a reviewed
legacy compatibility path. A partially migrated corpus must not silently lose
recall. The precise activation boundary is part of Part 3's review.

## Part 1 scope

The extraction includes the source PR's metadata parser, scope/status types,
trusted memory traversal, and tree renderer. Existing recall and forget calls
carry workspace trust to the shared scanner. Recall uses the tolerant scan
so an unavailable compatibility root does not suppress a healthy root;
forget retains strict failure behavior before acting on a candidate list.
Existing typed fixtures acquire the new metadata fields without changing
their selection assertions.

Tree helpers are not injected into model requests by this part. The current
memory prompt, selector, and selected-body delivery remain active. This part
therefore reports no user-session token reduction.

Verification covers real temporary memory files, old-format metadata,
scope separation, rejected symlinks, incomplete scans, cache invalidation,
body-free tree rendering, stable references, bounded output, and existing
index/recall/forget consumers. Complete repository CI is required before
marking the extraction ready.

## Keep correctness dependencies together

Body residency and compression cleanup are one contract: once a body leaves
history, a later fetch must be able to return it again. Splitting these into
independently enabled runtime changes can leave a memory marked present when
the model no longer has its content.

Similarly, a metadata-only session prompt cannot become active before its
body-reading tool is registered and reachable. Dynamic tool discovery must
be validated with the actual declared tool set.

## Work outside the core split

- Direct file/shell/glob access denial is not implemented in the source head.
  Do not reproduce the original PR body's claim that it is enforced, or add
  that product behavior merely to reconcile the stale description.
- Code-mode host timing changes and unrelated test-environment changes are
  separate from memory recall. Check whether main already covers them before
  proposing another PR.
- Additional telemetry, keyword-vocabulary tuning, and User Dream scheduling
  require their own need and scope check; migration dependencies are retained
  only where necessary for correct memory writes.
- #10649 already covers recall tokenization deduplication; avoid overlapping it.

## Acceptance for the token-saving runtime

Compare the same memory corpus, task, model, and settings before and after
Part 3/4. Report first-request memory input, whole-session main-model usage,
and selector/migration/Dream usage separately. Include cache reads and uncached
input when comparing cost. Disabling a background component is a diagnostic
variant, not a saving attributable to the implemented change.

Verify first-turn recall, irrelevant-memory controls, body fetch, repeated
fetch, changed files, compression followed by re-fetch, and CLI/ACP parity.
Do not transfer the full original PR's measured savings to Part 1 or Part 2.
