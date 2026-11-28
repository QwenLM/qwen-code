# Exec Tool Calls as Highlighted JavaScript

[English](exec-tool-code-view.md) | [简体中文](exec-tool-code-view.zh-CN.md)

## Problem

The `exec` tool takes a single `source` argument: a JavaScript program run in
an isolated runtime. Every transcript surface renders tool arguments as JSON,
so the program shows up as one JSON string literal with `\n` escapes and no
syntax highlighting. A multi-line script becomes a single unreadable line.

## Current state

Three surfaces render an exec call's arguments, all as JSON:

- the message-list tool card (`GenericToolDetails` in
  `packages/web-shell/client/components/messages/ToolGroup.tsx`) via
  `formatJsonPayload`;
- the turn-calls panel (`TurnCallsPanel.tsx`) via `toolCallContent` →
  `ToolCallDetail`, which fences any text that parses as JSON;
- the trajectory inspector (`TrajectoryDetail.tsx`) via `formatRaw` →
  `ToolCallDetail`.

## Goals

- Show an exec call's `source` as syntax-highlighted JavaScript with real
  newlines on all three surfaces.
- Keep every other tool's rendering unchanged.

## Non-goals

- No reformatting or pretty-printing of the source.
- No change to result rendering, truncation caps, or the approval card.
- No new highlighting dependency.

## Proposed solution

- `getExecSource(tool)` in `toolFormatting.ts` returns `args.source`
  verbatim when the tool is `exec` and the value is a non-empty string;
  otherwise `undefined`. Unlike `getStringArg`, it never collapses
  newlines.
- `ToolCallDetail` accepts an optional `language`. With a language it
  renders a fenced code block through the existing Markdown + shiki
  pipeline; JSON auto-detection applies only when no language is given.
- `toolCallContent` returns `argumentsText = source` and
  `argumentsLanguage = 'javascript'` for exec calls; `TurnCallsPanel` and
  `TrajectoryDetail` pass the language through to `ToolCallDetail`.
- `GenericToolDetails` builds the arguments payload as
  `{ text: source, json: false, language: 'javascript' }`;
  `ToolPayloadBlock` fences with `payload.language ?? 'json'` and renders
  an explicit-language payload as code even when it is not JSON.

## Design decisions

- **JavaScript, not TypeScript.** The exec runtime executes plain JavaScript
  (top-level `await`, the `tools.*` bindings); shiki's `javascript`
  grammar already ships with the web shell and covers the syntax models
  write, including type-annotated-looking code.
- **Verbatim source.** The panel shows exactly the bytes the model ran.
  A browser-side formatter would add a dependency and could rewrite the
  program; real newlines plus highlighting already fix readability.
- **Fallback preserved.** An exec call whose input has no string `source`
  (malformed or future schema) keeps the JSON rendering, and every other
  tool keeps its current path.
- **Same budgets.** The source flows through the existing truncation and
  "Show more" limits; code larger than the Markdown budget falls back to
  plain text exactly as JSON does today. Control-character sanitization
  still applies (`\n` and `\t` are preserved).

## Validation plan

Unit tests (vitest, run on the PR lane):

- `ToolGroup.test.tsx`: exec arguments render as a `javascript` code block
  with the source verbatim; an exec call without `source` keeps JSON.
- `TurnCallsPanel.test.tsx`: expanded exec row shows the highlighted source
  and a plain-text result.
- `TrajectoryDetail.test.tsx`: the input section renders the source as
  `javascript` code.

## Acceptance criteria

- Expanding an exec call on any of the three surfaces shows its source as
  highlighted JavaScript with real newlines, not a JSON string literal.
- Copying the arguments yields the raw source.
- Non-exec tools, exec without a string source, and result rendering are
  unchanged.
