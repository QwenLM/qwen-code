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

The cases also check behavior across edits and follow-ups.

- **Checklist.** Undo restores the original list after a rename. The harness then reapplies the rename and exercises persistence of item text, checked state and undo history after reload and reopen, plus isolation from a new conversation.
- **Activity form.** Edits start no model request. One explicit submission starts exactly one user turn and sends every field. The first reply uses the activity, date, participant count, per-person budget and notes. The harness holds the submit button for 150 ms to let the host finish applying the field that loses focus.
- **Comparator.** The harness looks for a new transcript card or changed comparator state after each follow-up. A revision must keep the original tool-call ID. The CSV check reads the selected plan's payment from the `plan,payment` columns and starts the download timeout after the export button has stopped moving.

Other controls are clicked once they have held their position for 1.2 s. A card moves for a second or two after it changes (it grows while the transcript stays pinned to the bottom, and the composer updates when the view's values reach the model context), and a click during that motion lands where the target was and is lost.

Amounts are read from the text a view renders. Commas (ASCII or full-width) and no-break spaces group thousands, a plain space does not (`Person 1 137.84` is a label and an amount), and percentages are ignored. A share row may also hold a label or a total; its share is the first amount written with a fraction.

The bill reset check verifies all input values, allocations and the chart against their defaults. Chart comparison uses normalized markup and canvas pixels so regenerated element IDs (including ARIA references and `<style>` selectors) and iframe scrolling do not count as a changed chart, while a chart drawn only on a canvas still counts as changing.

Checks observe behavior; none assumes a capability is missing. When a precondition fails, dependent checks report `not-applicable` with the reason, so every run reports the same check IDs. For example, isolation cannot be judged when nothing was persisted, and nothing can be checked or deleted when adding items failed. `checklist.save-acknowledged` is `not-applicable` until the host offers a save acknowledgement to observe.

## Harness contract

The live prompts (`prompts.ts`) end with a contract that names the element IDs the checks drive and read, for example `subtotal`, `people`, `total` and `shares`. This makes generated views measurable without guessing their structure.

The contract also mentions the interactive view, so it overstates how often a model would choose a view unprompted. The report therefore records whether the model called `generated_ui_show` as its own column.

The daemon starts from a blank environment: only `PATH`, `TMPDIR`, `LANG` and `LC_ALL` are inherited from the operator's shell, so a shell variable (an agent-loop flag, a provider key) cannot change what is measured. Both modes then set `QWEN_CODE_LEGACY_MCP_BLOCKING=1` so MCP discovery finishes before the first prompt and the Generated UI tool is offered from the first request. This guards a startup race; one A/B replay run without it passed too. These runs do not evaluate progressive MCP startup.

The daemon's permission rules allow the bundled `generated_ui_show` tool and its skill. The harness leaves permission prompts to the host. In live runs, the daemon authenticates to the loopback proxy with a random per-run bearer token. The proxy checks that token before forwarding and supplies the provider API key upstream.

A turn counts as finished when a model request followed the prompt, no response is still streaming, the composer shows no running turn and no request arrived for three seconds. The replay's stand-in model answers the form submission after three seconds: an instant answer finished the turn before the host reported the message as admitted, so the card showed the acceptance as unconfirmed.

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

With `QWEN_GENERATED_UI_LIVE=1`, an incomplete model configuration or an unknown case name fails the run instead of skipping it. The API key only reaches the local recording proxy. It is never written to the report.

Neither mode is part of the required no-AK integration gate. They start a daemon and a browser per case, and the no-AK job does not install Chromium.

The no-AK gate also runs `harness.test.ts`, `live-case.test.ts` and `live-config.test.ts`. They inject setup failures, verify that later cases still run and earlier results remain in the report, check resource cleanup, upstream cancellation and the daemon's blank environment, count tool use across sessions, and reject incomplete live settings, all without starting a daemon or browser. `cases.test.ts` exercises the evaluator with real Chromium DOM and controlled host data: repeated model requests in one user turn, identical duplicate submissions, ordered bill shares and split share labels, CSS and canvas chart updates, item editing, inert controls and missing elements, both in-place and appended-card updates, and complete resets of choices and amounts. Run it separately from the full replay:

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
