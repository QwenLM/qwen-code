# Verification: models.dev model catalog (PR #11959)

CI on this branch is green, including `Lint & Static`, the full unit suite, and the integration lane. So the **mechanism** is covered by automation. What no test on this branch can cover is whether the **data** is right and whether a real CLI process behaves as described, because every unit test stubs `fetch` and the unit-test setups run with the catalog switched off.

This brief is that gap, and it is the handoff to a machine that can run the real CLI against real endpoints.

Every number below came from the authoring machine, which **never ran the CLI, never let it reach models.dev, and never talked to DashScope, Anthropic, or OpenAI**. The numbers come from a `tsx` probe that imported `tokenLimits.ts` and `modalityDefaults.ts` directly and called them against the committed snapshot. Treat them as "what the lookup layer computes", not "what the provider accepts".

## What was actually run here

| Ran                                                            | Result                                    |
| -------------------------------------------------------------- | ----------------------------------------- |
| `npm run generate:model-catalog` against a downloaded api.json | 192 models, 24,685 bytes, under budget    |
| `tsx` probe of `tokenLimit()` / `defaultModalities()`          | Numbers in the table below                |
| `tsx` probe of `refreshModelCatalog()` with a local overlay    | Overlay applied per field, cache written  |
| `prettier --experimental-cli --check`                          | Clean                                     |
| `eslint --max-warnings 0`                                      | Clean                                     |
| vitest, typecheck                                              | **Not run here.** CI ran both, both green |

## What to run

| #   | Covers                                  | Needs                       |
| --- | --------------------------------------- | --------------------------- |
| 1   | Catalog on/off A/B through the real CLI | Nothing but the binary      |
| 2   | Background refresh lands and throttles  | Network                     |
| 3   | Offline path and custom overlay         | Nothing                     |
| 4   | Failure degrades silently               | Nothing                     |
| 5   | Snapshot regeneration is reproducible   | Network                     |
| 6   | **Decide:** Anthropic 1M context        | Anthropic key, long context |
| 7   | **Decide:** qwen3.8-max PDF             | DashScope key, a PDF        |

Items 1 to 5 are pass/fail. Items 6 and 7 are decisions, not checks: they may change what the code should do, and they are the two highest-risk claims in the PR description.

Point `QWEN_HOME` at a scratch directory for all of it, so nothing touches your real configuration:

```bash
export QWEN_HOME=/tmp/qwen-catalog-test
```

## 1 — Catalog on/off, through the real CLI

Same binary, same model, one environment variable, two numbers. This is the single most informative run in the brief.

```bash
rm -rf "$QWEN_HOME"
QWEN_CODE_MODELS_DEV_REFRESH=off qwen --model qwen-flash
# then type: /context
```

`/context` prints the resolved context window. It reads `contentGeneratorConfig.contextWindowSize` and does not require sending a message, so no API key is needed for this number to be right.

Repeat with the catalog off:

```bash
QWEN_CODE_MODELS_DEV=off qwen --model qwen-flash
# then type: /context
```

Expected. Both columns were measured by the probe on the authoring machine against the committed snapshot, by flipping `QWEN_CODE_MODELS_DEV` in one process, so the contrast is measured rather than derived from reading the regex tables:

| Model              | Catalog on (input / output) | Catalog off (input / output) |
| ------------------ | --------------------------- | ---------------------------- |
| `qwen-flash`       | 1,000,000 / 32,768          | 262,144 / 32,768             |
| `qwen3-coder-plus` | 1,048,576 / 65,536          | 1,000,000 / 32,768           |
| `qwen3.8-max`      | 1,000,000 / 131,072         | 1,000,000 / 65,536           |
| `claude-fable-5-1` | 1,000,000 / 128,000         | 200,000 / 65,536             |
| `gpt-5`            | 272,000 / 128,000           | 272,000 / 131,072            |
| `unknown-model`    | 200,000 / 32,000            | 200,000 / 32,000             |
| `glm-5`            | 202,752 / 131,072           | 202,752 / 131,072            |
| `kimi-k2.6`        | 262,144 / 32,000            | 262,144 / 32,000             |

Modalities, same probe, same method:

| Model              | Catalog on        | Catalog off  |
| ------------------ | ----------------- | ------------ |
| `qwen3.8-max`      | image, pdf, video | image        |
| `qwen3-vl-plus`    | image, video      | image, video |
| `claude-fable-5-1` | image, pdf        | image, pdf   |

`qwen3-vl-plus` is the union at work: models.dev lists image only, the regex table adds video, and the merged result keeps both. If it ever reports image only, the union broke and that is a real regression, because attaching video to that model works today.

`glm-5` and `kimi-k2.6` are the other control. They are served by two providers with different limits, so the catalog records nothing for them and the regex tables keep their current answer. Both columns must be identical, exactly like `unknown-model`. If either moves, the conflict-dropping rule broke, and the numbers it would move to are wrong for DashScope users: that endpoint caps both at 16,384 output while the vendors allow 131,072 and 262,144.

`unknown-model` is the control for a model neither source knows. It must be identical in both columns.

## 2 — Background refresh lands, then throttles

```bash
rm -rf "$QWEN_HOME"
qwen            # normal start, network reachable; exit after it boots
cat "$QWEN_HOME/model-registry.json" | head -5
```

Expected: the file exists and carries `source`, `fetchedAt`, `etag`, and a `models` map. Its `fetchedAt` should be within seconds of the run.

Start again and compare. Expected: `fetchedAt` unchanged, because the 24-hour throttle short-circuits before any request.

Worth noting so it is not mistaken for a bug: the data downloaded by this run does **not** affect this run. `contextWindowSize` is resolved during `Config` initialization, and the refresh is fire-and-forget after that. The new numbers appear on the next start. Item 1 above is unaffected, because it reads the bundled snapshot.

## 3 — Offline path and the custom overlay

This is the air-gapped setup: no models.dev, only a file or an intranet URL.

```bash
echo '{"models":{"my-private-model":{"context":2000000,"output":65536,"modalities":{"image":true}}}}' > /tmp/my-models.json
```

Put `{"model": {"customCatalog": "/tmp/my-models.json"}}` in `$QWEN_HOME/settings.json`, then:

```bash
QWEN_CODE_MODELS_DEV_REFRESH=off qwen --model my-private-model
# then type: /context
```

Expected: 2,000,000, on the very first session. A local file is read synchronously at startup precisely so an offline user does not have to start twice. `$QWEN_HOME/model-registry.custom.json` should appear alongside.

The overlay is per field, not per model. On the authoring machine, overlaying `{"qwen-flash":{"output":16384}}` left `qwen-flash` at 1,000,000 input and moved only the output to 16,384. Worth confirming in the real CLI, because it is the property most likely to be broken by a careless refactor.

Then remove the setting and restart. Expected: the overlay is ignored, because the cache records the source it came from and no longer matches.

Also worth one run: point `customCatalog` at a URL while `QWEN_CODE_MODELS_DEV_REFRESH=off`. It should still be downloaded. That combination is the whole point of the feature, and it is easy to break by folding the two switches together.

## 4 — Failure degrades silently

```bash
QWEN_CODE_MODELS_DEV_URL=https://127.0.0.1:9/nope DEBUG=1 qwen
```

Expected: startup is not visibly slower, no error reaches the UI, and the debug log carries a `Model catalog refresh skipped` line. The fetch has a 10-second timeout, but it is never awaited on the startup path, so even a hanging endpoint should not be felt. If startup does stall, the fire-and-forget wiring is wrong and that is a blocking finding.

## 5 — Snapshot regeneration is reproducible

```bash
npm run generate:model-catalog
git diff --stat packages/core/src/models/generated/model-registry.json
```

Expected: only `fetchedAt` changes, plus whatever models.dev genuinely changed upstream since 2026-09-15. Key ordering must be stable; it uses a plain comparator rather than `localeCompare` specifically so that two machines with different locales produce the same file. If you see a large reordering with no value changes, that guarantee failed.

## 6 — Decide: does Anthropic actually serve 1M context by default?

models.dev lists `claude-sonnet-4-5`, `claude-sonnet-4-6`, and `claude-sonnet-5` at 1,000,000 context. The regex table caps every Claude model except Opus 4.6 and up at 200,000.

This matters beyond a display number. `contextWindowSize` drives the auto-compaction threshold. If the real limit is 200,000 and we believe 1,000,000, compaction fires too late and the request is rejected outright.

Anthropic's 1M window has historically required a beta header. If it still does, and qwen-code does not send it, then the catalog value is wrong for this client even though it is right for the model.

How to falsify: with an Anthropic key, select `claude-sonnet-4-6` and push a conversation past roughly 200,000 tokens. Either it keeps working, or it returns a context-length error well before the reported window.

If it fails, the fix is a small override table that pins Anthropic entries back to the regex behavior, not abandoning the catalog. Say so in the PR thread and I will add it.

## 7 — Decide: does DashScope accept PDF for qwen3.8-max?

models.dev advertises pdf input for `qwen3.8-max`; the regex table says image only. The OpenAI-compatible converter already has a PDF encoding path, so once the catalog asserts pdf, the CLI will genuinely attach PDFs to DashScope requests.

How to falsify: with a DashScope key, select `qwen3.8-max` and attach a small PDF. Either it is accepted, or the API rejects the content part.

If it is rejected, the same override table applies. The failure mode here is milder than item 6, because it surfaces as an immediate error rather than silently wrong compaction.

## What to report back

1. The two `/context` numbers from item 1, for at least `qwen-flash`, and whether `qwen3-vl-plus` kept video.
2. Whether the cache file appeared and whether the second start left `fetchedAt` alone.
3. Whether the custom overlay took effect on the first session, and whether the per-field behavior held.
4. Whether an unreachable URL delayed startup at all.
5. Outcomes of items 6 and 7, which are the two claims in the PR description most likely to be contradicted by a real run.

Anything in the PR description that your run contradicts is the description's problem, not yours. It was written from static analysis plus the probe above, and it says so.
