# Native Memory Recall Reliability

## Problem

Managed-memory recall starts asynchronously for each user query. The initial
request originally performed a zero-wait consume, so a useful selector result
could miss the first prompt. If the turn has no tool call, that result has no
later safe delivery point and is discarded.

A fixed 100 ms initial budget was the first attempt at a fix. Measurement
showed it is not sufficient on its own. Recall awaits the model selector
whenever a `Config` is present — the normal case — and that selector is a
network side query whose abort ceiling is 30 s. The budget is therefore
dominated by round-trip time, not by the incidental scheduler timing it was
sized for, so it expires on the common path. Delivery then falls through to the
ToolResult point, which a tool-free turn never reaches. Tool-free turns are
exactly the ones where user-level memory matters most: short questions answered
from context rather than from the repository.

The model selector remains the normal precision gate. Its failure fallback had
two independent correctness problems: it tokenized only ASCII text and gave
every non-empty document a positive score even without a lexical match.

## Decision

Keep a single recall lifecycle and model-primary selection. Add one
deterministic delivery stage in front of it — not the two-stage shared-scan
Fast/Refined architecture originally proposed in RFC #7040.

- Give user-query recall a fixed 100 ms initial wait budget.
- Deliver a result that settles inside the budget in the initial prompt.
- If the budget expires and the deterministic candidate pass found relevant
  documents, deliver that bounded result instead of nothing.
  `selectModelCandidateDocuments` already computes lexically ranked candidates
  in order to build the model manifest, so the fast result reuses them and
  costs no extra scan or I/O. It is capped at two documents
  (`MAX_FAST_RECALL_DOCS`), well below the five-document prompt limit, because
  it carries no model judgement.
- Leave recall pending after a fast delivery so the model-selected result still
  lands at the existing same-query ToolResult delivery point.
- Exclude documents the fast phase already delivered from that later delivery,
  rebuilding the prompt from what remains. Both results come from one scan, so
  the selector never saw the fast documents as excluded and can legitimately
  re-select them. When every selected document was already delivered, record
  `already_delivered`; when the selector returned no documents at all, record
  `no_relevant_results`.
- Do not abort recall merely because the initial budget expires.
- Preserve the existing cancellation and exactly-once terminal telemetry paths.
  A cancelled turn delivers no fast result.

The 100 ms budget stays internal, per RFC #7040's direction of a small fixed
internal budget determined by benchmark rather than exposed as public
configuration; telemetry can show whether a later change is justified.

### Why not the original Fast/Refined architecture

RFC #7040 specified two results produced from one shared scan, with the refined
pass excluding already-delivered fast documents and filling up to a combined
five-document limit. The delivery guarantee that design existed to provide is
worth having; its machinery is not. A second selection pathway needs its own
scan plumbing, its own budget accounting, and cross-phase document bookkeeping —
and that bookkeeping is the source of the duplicate-injection class of bug the
RFC itself warned about. Reusing the candidates the selector was already going
to score gets the same guarantee from one added callback and one exclusion set.

### Telemetry: `phase` and `strategy` are orthogonal

`phase` is the **delivery stage**: `fast` for a deterministic result injected
at budget expiry, `refined` for the model-selected result. `strategy` is the
**selection method**: `none`, `heuristic`, or `model`. They are not redundant
and neither subsumes the other. A `fast` delivery is always `heuristic`, but a
`refined` delivery is `model` normally and `heuristic` when the selector failed
and the fallback ran. Reading delivery-stage behaviour off `strategy` alone
would silently merge "the deterministic result arrived first" with "the model
selector broke".

Improve the deterministic scorer, which now serves both the fast path and the
selector-failure fallback:

- normalize query and document text with Unicode NFKC;
- keep ASCII alphanumeric tokens of at least three characters;
- generate Unicode code-point bigrams for Han, Hiragana, Katakana, and Hangul
  runs;
- ignore isolated CJK characters;
- bound fallback query tokens while retaining tokens from both ends;
- score only the body window that can be surfaced in the prompt;
- require a title, description, or body lexical match before applying a type
  boost;
- weight each title and description token match above a body token match;
- break score ties by recency, then by input order, never by document type.
  An alphabetical type comparison orders `feedback` before `project` before
  `reference` before `user`, and `MAX_FAST_RECALL_DOCS` takes only the top
  two, so a type tie-break would systematically drop user-level memory from
  the fast result — the exact case the fast path exists to serve. Input order
  as the final key keeps the project-before-user precedence, because recall
  concatenates project documents ahead of user ones.

## Non-goals

- No second scan, second selector, or separate fast/refined budget accounting.
- No public recall timing or retrieval-mode setting.
- No new tokenizer or retrieval dependency.
- No change to memory writes, scopes, extraction, DREAM, forget, or compaction.
- No removal of the shared scanner's 200-document cap for non-recall callers.
  Recall alone uses the bounded broad-candidate design documented in
  `2026-08-09-bounded-memory-recall-candidates.md`.

## Verification

Recall quality is measured in `packages/core/src/memory/recall-eval.test.ts`
against a 48-case labeled corpus, scored both by the shipped scorer and by a
frozen copy of the pre-change one so "no regression" is reproducible rather
than asserted. Delivery is measured separately in `recall-delivery-eval.test.ts`,
because a correct selection that never reaches the model is worth nothing.

- Recall settling inside the budget is delivered initially.
- A budget expiry with deterministic candidates delivers that bounded result
  rather than nothing, and leaves recall alive for later ToolResult delivery.
- The later delivery never repeats a document the fast phase already sent.
- Cancellation ends the bounded wait and prevents stale delivery.
- A fast result never crosses a query boundary.
- No-result queries stay silent under both designs.
- A labeled set covers Chinese, English, Japanese, Korean, mixed text,
  NFKC normalization, body-only matches, no-result queries, and answerable
  queries that share no token with their document.
- Score ties are broken by recency rather than by document type, so a
  user-typed document is not pushed out of the two-document fast result by a
  tied feedback, project, or reference document.
- A result whose every document the fast phase already delivered is recorded
  as `already_delivered` wherever it is discarded, not only at the ToolResult
  consume point. A tool-free turn that delivered everything must not be
  counted in the `no_safe_delivery_point` bucket; a partial overlap still is,
  because the documents outside the fast set genuinely had no delivery point.
- Long CJK queries keep bounded scoring work and preserve both query ends.
- Existing active-tool noise filtering remains unchanged on the deterministic
  candidate path. The model-selector failure fallback still triggers and
  returns at most five documents; its scoring quality intentionally improves
  per the scorer changes above (measured by the frozen-scorer comparison in
  `recall-eval.test.ts`).

### Known limitations

- The delivery evaluation models selector latency rather than measuring it; a
  network round trip cannot be timed in a unit test. Results are reported per
  latency scenario, and the structural claim — that a selector slower than the
  budget leaves a tool-free turn with no delivery point under the single-path
  design — holds for every scenario above the budget.
- The fast result has no model judgement behind it. It is capped at two
  documents to bound the cost of being wrong, but on a tool-free turn where the
  selector never lands, a mis-ranked fast document is what the model sees.
- Scoring is substring-based, so a query token can match inside a longer word
  ("owner" inside "ownership"). The evaluation corpus records one such case
  rather than hiding it.
- The fast path closes the timing gap, not the matching gap. A query that
  shares no token with its document produces no deterministic result, so a
  tool-free turn asking it still ends with nothing delivered; only the model
  selector can serve those, and on a tool-free turn it never lands. The
  `semantic-no-lexical` slice of the corpus measures this directly — the
  shipped scorer and the frozen pre-change scorer both score 0% Recall@5 on
  it, so requiring a lexical match did not create the gap, but it does keep
  the fast path silent there. This is why the headline tool-free delivery
  figure is 92.3% and not 100%: the residual 7.7% is exactly that slice.
- Recall can see older documents outside the shared 200-document scanner cap,
  but non-recall callers, including Forget, keep the existing capped scanner.
  A broader manageability pass is separate from this recall-only change.
