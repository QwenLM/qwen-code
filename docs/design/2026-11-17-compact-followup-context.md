# Compact follow-up suggestion context

[English](2026-11-17-compact-followup-context.md) | [简体中文](2026-11-17-compact-followup-context.zh-CN.md)

## Problem and scope

Ink, OpenTUI and ACP pass up to 40 curated `Content` entries to the shared
suggestion generator. Entry counts do not bound tool payloads. Cache sharing is
enabled by default, but the suggestion fork can select a different fast model
while retaining the parent system instruction and history. Such requests cannot
rely on the parent's model cache.

This change bounds ordinary suggestion context and sends cross-model suggestions
through the existing side-query client. It preserves the same-model cache fork,
the suggestion prompt, output filtering, cancellation, retry policy and caller
interfaces. Preview's architecture is only a reference; its services, transcript
protocol and rollout gates are not imported.

## Design

The shared generator resolves the requested model using the existing precedence:
explicit override, configured fast model, then configured main model. A session-owned
cache snapshot is eligible for the existing fork only when its model matches
the requested model. Different or uncertain model identifiers use a compact side
query; they never inherit the parent system instruction or tool declarations.
The session ownership check remains mandatory. This change does not add a new
cache API or try to resolve aliases by changing provider routing.

The side-query path converts the supplied `Content[]` into plain text locally,
without an extra model call. Its total conversation budget is 4,000 UTF-16 code
units, including labels, truncation markers and separators. This is a character
budget, not a tokenizer guarantee; the fixed suggestion prompt is additional.

| Evidence                      | Budget and priority                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Latest visible user request   | Up to 1,000 characters, first priority                                                             |
| Final visible assistant text  | Up to 1,800 characters, retain beginning and end                                                   |
| Current-turn tool results     | Up to 400 characters total, latest first; retain tool name, completion/error and a small text tail |
| Earlier visible user requests | Up to 600 characters each, latest first, within remaining space                                    |

Exclude thinking, inline/file data, function-call arguments and system reminders.
Tool response entries are not user requests. Tool summaries are plain text, so
there are no orphan protocol tool results after pruning. A shell result without
an explicit error is described as completed, not proven successful. Do not mutate
the supplied history or the parent cache snapshot. Retain chronological order
after selecting evidence. Empty usable context skips the optional request.

The original user goal is included only if present in the supplied history tail.
This change does not retrieve or copy a full session to reconstruct it. The
same-model fork remains unchanged, including its existing 40-entry history tail.

## Files and consumers

Implementation and collocated tests live in
`packages/core/src/followup/suggestionGenerator.ts` and
`packages/core/src/followup/suggestionGenerator.test.ts`. The consumers are Ink's
`AppContainer`, OpenTUI's follow-up generation hook, and ACP's `Session` (which
also delivers daemon/Web Shell suggestions). Their interfaces remain the same.

## Validation and acceptance

Focused tests verify long Chinese/English input, latest user constraints, both
ends of the final answer, current-turn tool errors, huge payload exclusion,
thinking/images/reminders, chronological ordering, no history mutation, explicit
model overrides, cache-disabled/missing/foreign snapshots, and the unchanged
same-model fork. A cancelled request must not generate a suggestion.

Run build, typecheck, bundle, focused Core tests, and the affected caller tests.
Attempt the global CLI baseline before implementation; where the interactive
suggestion path is inaccessible, document a direct-generator test fallback.

Replay complete real online inputs in paired baseline/modified requests using
the same model. Record provenance and input completeness, reported token usage,
latency and manual checks of suggestion relevance and preserved constraints.
Keep raw samples outside Git. Do not equate character reduction with tokenizer
usage, cached input savings with total cost, or background latency with user task
latency. Small samples establish feasibility, not production-wide quality.

Verification against main `10f05043c2` passed build, typecheck, bundle, 42 Core
tests and 32 caller regression tests. Built CLI ACP checks confirmed compact
cross-model requests and the unchanged same-model parent context, with one
suggestion notification per run.

Six complete online turns replayed on `qwen3.8-flash` used 168,701 input tokens
before projection and 8,843 afterward (94.8% less), with no cache hits in either
group. This compares the ordinary side-query path, not the previous cross-model
fork including its parent system prompt. Some suggestions remained redundant or
guessed unsupported details; this sample does not establish quality non-regression
or production-wide latency improvement.

## Risks and open questions

Clipping can omit an old constraint or useful tool evidence. Head/tail retention
and high-priority user requests reduce that risk; replay must check it. Literal
model equality is conservative and does not prove a same-model cache hit. This
change deliberately leaves same-model cache economics and output/timeout tuning
for separate evaluation. There are no blocking design questions.
