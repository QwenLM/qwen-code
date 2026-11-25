# Freeform Code Mode exec input

[English](freeform-exec-experiment.md) | [简体中文](freeform-exec-experiment.zh-CN.md)

## Problem and scope

Code mode currently exposes exec as a function with a JSON object containing
`source`. Generating nested JavaScript or shell code therefore includes an outer
JSON escaping layer. The global `tools.freeform` setting removes that layer for
OpenAI Responses requests when Code Mode Only is enabled. JavaScript string
evaluation inside exec remains.

## Design

`tools.freeform` opts into a Responses custom tool with text input for exec.
The setting is effective only when `tools.codeModeOnly` is true and the current
model uses `wireApi: "responses"`. Other tools and the default behavior remain
function tools. The Responses converter maps completed custom input to internal
`{ source }`, leaving scheduler validation, permissions, runtime execution,
tool-call display, and recording unchanged. The adapter replays exec history as matching
`custom_tool_call` and `custom_tool_call_output` items when enabled, including
requests without tools. Call/output orphan cleanup covers both wire kinds.
Completed items carry the full authoritative source; deltas do not execute
partial programs.

The setting is global and evaluated for each request. History remains in the
shared internal Content representation, so switching between Responses models,
or between Responses and Chat Completions, re-encodes the same history for the
selected wire. No history migration or per-model setting is required. The
setting is available in the settings schema but is intentionally hidden from
the Settings dialog; users configure it directly in the settings file.

The change is confined to the global tools setting, Config plumbing, Responses
types, converter, pipeline, and their tests. There is no automatic capability
detection, fallback, grammar constraint, or change to other provider adapters.
The caller enables the setting only on an endpoint that supports
[Responses Custom Tools](https://developers.openai.com/api/docs/guides/function-calling#custom-tools).
When `tools.codeModeOnly` is false, `tools.freeform` is stored but has no effect.

## Validation and acceptance

Focused tests cover raw source preservation, normal tool compatibility, custom
call/output pairing, setting plumbing, provider-switch history replay, and
exclusion from the Settings dialog. Acceptance requires the default and
non-Code-Mode behavior to remain function tools, completed custom input to
execute once with unchanged source, and call ids and outputs to survive
provider switching.

Real API tests completed in both directions in persistent CLI sessions:
Idealab `gpt-6-astra` with Responses Freeform to DashScope `qwen3.8-max` with
Chat Completions, and the reverse. Each first turn finished normally before
the model switch; the subsequent follow-up used tools and returned a normal
answer. Prior calls and tool outputs were retained. The forward run used the
original news-research task; the reverse run read package metadata with exec.

Neither main model produced API errors, retries, or empty final answers in
these runs. Endpoint compatibility remains the user's responsibility.

Status: implementation and bidirectional real API verification complete.
Detailed results are recorded under `.qwen/e2e-tests/freeform-original-task/`.
