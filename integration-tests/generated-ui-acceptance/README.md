# Generated UI acceptance evaluation

Stage 1 of #14019. This directory turns the issue's four acceptance cases into checks that run through the real pipeline: a `qwen serve` daemon, the Web Shell it serves, the bundled Generated UI provider and Chromium. Only the model is replaced.

- **Replay** (`replay.test.ts`): a stand-in model answers with hand-written reference documents (`reference-documents.ts`) that implement each case as far as the current `ui.*` API allows. It measures what the runtime and host support, independent of generation quality. The expected status of every check is pinned in the test, so a later stage that adds a capability updates its entries on purpose.
- **Live** (`live.test.ts`): a recording proxy forwards to a real OpenAI-compatible endpoint. It produces a report per model, case, trial and check. It is an evaluation, not a gate. A Qwen model is the gating target; a second model can be added as non-gating comparison evidence.
- **Fixtures** (`fixtures.test.ts`): plain unit tests. They check that the fixture inputs and rules reproduce the figures stated in the issue.

## Cases and invariants

The issue states results without inputs. `fixtures.ts` chooses inputs so that the stated rules reproduce them, and every expectation is computed from the rule, in integer cents:

| Case          | Inputs                                                                                                                         | Rule                                                                                                                                 | Figures from the issue                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Bill splitter | food CNY 900, 6 people, CNY 60 discount, 10% service                                                                           | total = (food − discount) × (1 + fee); leftover cents go to the first people; shares sum to the total and differ by at most one cent | 924 / 154; with 7 people, CNY 61 and 15%: 964.85, 4 × 137.84 + 3 × 137.83 |
| Comparator    | CNY 39 / 69 / 99 per seat per month, annual billing 20% off the plan price, support CNY 12 per seat per month never discounted | actual payment per period is separate from its monthly equivalent                                                                    | 13 seats, annual, with support: 6739.20 / 10483.20 / 14227.20             |

The checklist and the activity form check behavior rather than figures:

- **Checklist:** add, check, filter, delete and repeated undo; then persistence after reload and after reopening the conversation; then isolation from a new conversation.
- **Activity form:** edits start no model request; one explicit submission sends every field once; the answer uses the values.

Checks observe behavior; none assumes a capability is missing. When a precondition fails, dependent checks report `not-applicable` with the reason. For example, isolation cannot be judged when nothing was persisted.

## Harness contract

The live prompts (`prompts.ts`) end with a contract that names the element IDs the checks drive and read, for example `subtotal`, `people`, `total` and `shares`. This makes generated views measurable without guessing their structure.

The contract also mentions the interactive view, so it overstates how often a model would choose a view unprompted. The report therefore records whether the model called `generated_ui_show` as its own column.

## Running

Both modes need a bundled CLI (`npm run build && npm run bundle`) and Playwright Chromium.

```sh
# Replay: deterministic, no credentials.
QWEN_GENERATED_UI_ACCEPTANCE=1 TEST_CLI_PATH="$PWD/dist/cli.js" \
  npx vitest run --root ./integration-tests generated-ui-acceptance/replay.test.ts

# Live: gating model, one trial per case, report written to ./genui-report.
QWEN_GENERATED_UI_LIVE=1 \
QWEN_GENERATED_UI_LIVE_BASE_URL=https://example.invalid/compatible-mode/v1 \
QWEN_GENERATED_UI_LIVE_API_KEY=... \
QWEN_GENERATED_UI_LIVE_MODEL=<qwen model id> \
QWEN_GENERATED_UI_ACCEPTANCE_OUT=./genui-report \
TEST_CLI_PATH="$PWD/dist/cli.js" \
  npx vitest run --root ./integration-tests generated-ui-acceptance/live.test.ts
```

Optional variables:

- `QWEN_GENERATED_UI_COMPARE_{BASE_URL,API_KEY,MODEL}` adds a comparison model.
- `QWEN_GENERATED_UI_LIVE_TRIALS` sets the number of trials per case.
- `QWEN_GENERATED_UI_LIVE_CASES` (`bill,checklist,form,comparator`) selects a subset.

The API key only reaches the local recording proxy. It is never written to the report.

Neither mode is part of the required no-AK integration gate. They start a daemon and a browser per case, and the no-AK job does not install Chromium.

The no-AK gate also runs `harness.test.ts`, which injects setup failures and checks resource cleanup without starting a daemon or browser. `cases.test.ts` exercises the evaluator with real Chromium DOM and controlled host data: repeated model requests in one user turn, identical duplicate submissions, ordered bill shares, both in-place and appended-card updates, and complete resets of choices and amounts. Run it separately from the full replay:

```sh
QWEN_GENERATED_UI_ACCEPTANCE=1 \
  npx vitest run --root ./integration-tests generated-ui-acceptance/cases.test.ts
```

## Not covered yet

Some #14019 gates are left to the stages that add their mechanisms:

- streaming and interrupted generation;
- light and dark themes, IME, narrow viewports;
- bridge failure injection;
- workspace-level (rather than conversation-level) isolation;
- Desktop WKWebView (#16766).
