# Structured recall: split of #10183

Source: [#10183](https://github.com/QwenLM/qwen-code/pull/10183),
commit `38b9b7ce8f7cbc03537cd2bff2b294c8e1e267f4`.

The original PR spans retrieval, runtime delivery, migration, Dream changes,
and unrelated code. The split keeps each PR independently useful and avoids
landing model-facing infrastructure before it has a production caller.

## Delivery order

| Part                         | Behavior and boundary                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scan boundary hardening   | Accept regular Markdown files only, do not traverse symlinks inside managed-memory roots, reject repo-controlled symlink roots, and preserve user-owned private root symlinks. Keep the existing roots, prompt, and recall/forget behavior. |
| 2. Bounded retrieval         | Add structured metadata parsing, bounded metadata rendering, search/fetch/explore, scope-qualified references, and the model-facing tool together so every new API has a production consumer.                                               |
| 3. Runtime activation        | Switch CLI and ACP to metadata-first delivery. Keep body residency, invalidation, and compression cleanup together. Include only telemetry needed to verify delivery.                                                                       |
| 4. Existing-memory migration | Add metadata writers, background migration, readiness/activation, and the required Dream/Remember/Extraction integration. Keep old memories usable until conversion succeeds.                                                               |

Part 1 is [#12726](https://github.com/QwenLM/qwen-code/pull/12726).
It is a security and correctness prerequisite, not a token-saving change.
It deliberately does not scan an additional repo-local compatibility root,
add tree/rendering APIs without callers, or change the current prompt.

## Part 1 acceptance

- Existing project and user memory continue to scan from the same roots.
- Existing recall, forget, and index behavior stays unchanged.
- A Markdown file or directory symlink inside a memory root is ignored.
- A repo-controlled team memory root cannot redirect scanning through a
  symlink.
- A user-owned private memory root may remain a symlink for dotfile layouts.
- Missing roots remain an empty scan.

## Runtime correctness dependencies

A metadata-only prompt must not become active before its body-reading tool is
registered and reachable. Body residency and compression cleanup are one
contract: after a body leaves history, a later fetch must be able to return it
again.

The bounded retrieval PR must own the metadata parser and tree renderer it
uses. This avoids a foundation PR containing hundreds of lines of dormant
production code and keeps the review surface tied to reachable behavior.

## Token measurement

Part 1 has no session-token saving because it does not alter model input.
Measure savings only after runtime activation, using the same memory corpus,
task, model, and settings before and after. Report first-request memory input,
whole-session main-model usage, selector/migration/Dream usage, cache reads,
and uncached input separately.

Verify first-turn recall, irrelevant-memory controls, body fetch, repeated
fetch, changed files, compression followed by re-fetch, and CLI/ACP parity.
Do not transfer benchmark results from the original broad PR to any split PR.
