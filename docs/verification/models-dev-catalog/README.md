# Verification: models.dev model catalog (PR #11959)

## Delivery status

Draft. The catalog lookup and refresh are implemented, but `model.customCatalog` has two reproduced integration defects: it is loaded after initial model resolution, and one Config can overwrite another Config's process-global catalog source. These must be fixed or the custom-catalog feature removed before delivery. Existing `modelProviders` can explicitly configure private model limits and capabilities without that feature.

The [design](../../design/2026-08-23-models-dev-registry.md) incorporates the useful constraints from design-only PR #9851. Effort metadata and provider-aware lookup remain deferred.

## Evidence collected on 2026-09-26

- Original head `7352766da9`: four focused unit files passed, 190 tests. That did not cover real Config initialization.
- Actual Config lifecycle, no mocks: an isolated local catalog specified context 12,345 for qwen3-coder-plus. CLI resolution → Config construction → initialization → authentication still produced context 1,048,576, while direct catalog lookup returned 12,345. Initializing a second Config without a custom source reset the first Config's lookup to 1,048,576.
- Real `https://models.dev/api.json` refresh: HTTP 200 with ETag; cache written with 195 models. A second refresh issued no request and preserved the cache timestamp. No credential was needed.
- Regeneration with the corrected conflict filter: 195 entries, 25,363 bytes, below the 200 KiB budget. Counts are observations of this payload, not a permanent contract.
- Original-head local full build hit a pre-existing document-export size budget. The PR now merges main, which contains the budget repair from #12298. No unrelated budget increase was added here.

Local scripts and raw results are retained under `.qwen/e2e-tests/pr11959/` in the closeout worktree. That directory is intentionally not a release artifact. The PR closeout comment records the final build, typecheck, test, and regression-sensitivity results.

## Data and protocol decisions

[Anthropic's current reference](https://platform.claude.com/docs/en/build-with-claude/context-windows) specifies 200,000 context tokens for Sonnet 4.5, while Sonnet 4.6 and Sonnet 5 have a default 1M window without a beta header. The lookup now corrects Sonnet 4.5 even if a newer runtime cache advertises 1M. No paid long-context request was made.

[DashScope's PDF reference](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) lists qwen3.8-max PDF support on Chat Completions in Beijing and Singapore. The documented Base64 shape (`type: file`, `file_data`, `filename`) matches the existing converter. Responses API PDF delivery is explicitly unsupported by that reference.

**Live PDF recognition is not verified.** Local DashScope settings reference credential environment variables that are absent. The prepared one-page random-marker test therefore stopped before sending a request. To complete it, use an authorized credential with qwen3.8-max on a supported endpoint, attach the one-page PDF through Qwen Code, and confirm the returned marker. A successful HTTP response without correct PDF contents is insufficient.

## Regression checks

- Keep the catalog enabled with an isolated `QWEN_HOME` and resolve qwen-flash: the real bundled context should be used. Disable it with `QWEN_CODE_MODELS_DEV=off`: the regex value should be restored. Explicit model settings must win in both cases.
- Feed conflicting bare, dated, and provider-qualified entries into the shared projection: the normalized key must be absent. In particular a larger bare-model output limit must not replace a smaller qualified endpoint limit.
- Feed malformed numeric limits and modalities into the cache parser: they must not override usable defaults.
- Supply a newer cache claiming Sonnet 4.5 has 1M context: lookup must still report 200,000; Sonnet 4.6 must retain 1M.
- Refresh twice against a reachable source: the first request writes the cache; the second is throttled. Existing tests also cover 304 revalidation, offline mode and failed downloads retaining previous data.

Required CI and the custom-catalog scope decision remain delivery gates. Do not treat the original green CI or the presence of a verification document as evidence that these gates have passed.
