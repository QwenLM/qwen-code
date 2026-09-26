# Verification: models.dev model catalog (PR #11959)

## Final delivery scope

The catalog supplies inferred context windows and input modalities with bundled/offline fallback and background refresh. Output limits keep existing regex matches first; the catalog fills models without a table match. The [bilingual design](../../design/2026-08-23-models-dev-registry.md) incorporates the useful constraints from the closed design-only PR #9851.

The draft-only `model.customCatalog` was removed after real Config testing exposed late initialization and cross-session global state. Private/offline overrides use existing `modelProviders` or model generation settings. No custom catalog cache is read. Effort metadata and provider-aware catalog lookup remain deferred.

qwen3.8-max PDF support is **explicit opt-in**, not a catalog default. This removes an unverified, protocol-dependent behavior from the release scope while preserving explicit model configuration. The correction applies equally to bundled and refreshed metadata.

## Evidence collected on 2026-09-26

- Original head `7352766da9`: four focused unit files passed, 190 tests. Actual Config testing subsequently reproduced custom-catalog context 12,345 being ignored in favor of 1,048,576, followed by another Config resetting its global source. These observations motivated removal of the draft-only feature.
- After removal, a real Config lifecycle test covered both `settings.generationConfig` and `modelProviders[].generationConfig`: the first Config initialized and authenticated with context 12,345 and PDF enabled; a second Config used qwen3.8-max defaults of 1,000,000 and PDF undefined. The first Config retained its explicit values after the second initialized. No provider generation request or mocks were used.
- Catalog on/off/re-enabled behavior passed through the real resolution path. Explicit model settings remained authoritative; default Qwen PDF stayed disabled.
- Real `https://models.dev/api.json` refresh returned HTTP 200 and an ETag, writing 195 models. The immediate second refresh issued no request and preserved the timestamp. After simplification, two more refreshes against that fresh cache issued zero requests.
- Regeneration with the corrected conflict filter produced 195 entries, 25,363 bytes, below the 200 KiB budget. Counts describe this payload rather than a permanent contract.
- Regression sensitivity: the first closeout's new checks failed seven assertions with the old implementation. Disabling the Qwen PDF correction separately made its resolver test fail. Restored code passed the focused suites.

Local executable scripts and raw results are retained under `.qwen/e2e-tests/pr11959/` in the closeout worktree. The PR verification comment records final build, typecheck, focused test counts and CI URLs. The original build's export-budget failure was resolved by merging main's existing #12298 repair, not by changing an unrelated budget here.

## Data and protocol decisions

[Anthropic's current reference](https://platform.claude.com/docs/en/build-with-claude/context-windows) specifies Sonnet 4.5 at 200K context, while Sonnet 4.6/5 have a default 1M window without a beta header. The lookup corrects stale Sonnet 4.5 claims even in a newer cache. No paid long-context request was made.

[DashScope's PDF reference](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) supports qwen3.8-max through Chat Completions in Beijing and Singapore, with Base64 `file_data` plus `filename`; it explicitly excludes Responses API PDF delivery. A provider-independent catalog cannot infer this distinction safely. The default therefore leaves PDF disabled while preserving image/video and explicit PDF opt-in.

Live PDF recognition was not run: configured credential variables were absent. Automatic PDF enablement is deferred until endpoint/protocol-scoped resolution and a real recognition test exist. A future test should return a random marker present only inside a one-page PDF; HTTP 200 alone does not prove delivery to the model.

## Review follow-up: output precedence and small windows

Exact-head comparison at `4086a0c` reproduced GLM-4.7's default output increasing from 16,384 to 64,000, and a Qwen-VL-Max request of 16,384 being reduced to 8,192. Preserving existing output-table matches fixes both. Tests now iterate every bundled identifier to verify existing output limits remain unchanged and exercise the same precedence with refreshed data. Context corrections for Sonnet 4.6/5 remain intact. Restoring catalog-first output makes both new tests fail.

The suggested context bounds are not adopted. With an actual 4,096-token math model and a 2,000-token prompt, the reviewed catalog yields an output request of 3,072; the regex-only path yields 32,768 against the same physical window. Neither fits. Likewise, the existing clamp can request 4,000 output tokens for an explicitly configured 8,192-token window and a 5,000-token prompt. This is an existing small-window budgeting limitation, not evidence that replacing accurate metadata with a 128K/256K fallback is safe. Supporting these windows requires separately reviewing compaction and the send path's fixed estimation padding. This PR does not claim to add small-window model support. No arithmetic defect was observed for Qwen-Long's 10M context, so no arbitrary upper bound is added.

The local comparison scripts exercised the real token helpers and default provider; they did not send live generation requests. Raw results and the report are under `.qwen/e2e-tests/pr11959/`. A catalog-on/off golden copy of all metadata would not validate endpoint accuracy; the shipped-data regression test instead protects the output precedence contract directly.

## Reproducible checks

From the repository root, run `npm run build` and `npm run typecheck`. From `packages/core`, run:

```sh
npx vitest run src/models/model-catalog.test.ts src/models/model-catalog-refresh.test.ts src/core/tokenLimits.test.ts src/core/modalityDefaults.test.ts src/models/modelConfigResolver.test.ts src/models/modelsConfig.test.ts --coverage.enabled=false
```

These suites cover real bundled configuration resolution, explicit overrides, offline switches, invalid data, normalized conflicts, corrections, cache freshness, 304 revalidation, failed fetches and concurrent refreshes. Global suites retain regex-only setup; the catalog-specific suite explicitly enables the real catalog in an isolated QWEN_HOME.

For a real lifecycle check, resolve qwen3.8-max with an explicit context and modalities, construct and initialize Config, refresh authentication, then initialize a second Config without those explicit values. The first must retain its values and the second must receive the catalog defaults with no PDF capability. No live model request is necessary for this configuration invariant.
