# Mod turn events

[English](2026-10-24-mod-turn-events.md) | [简体中文](2026-10-24-mod-turn-events.zh-CN.md)

Status: proposed. This stage follows the session facts in #15348 and is tracked in #13749. It follows the Claude Code 2.1.309 plugin API declarations of `turn.start`, `turn.complete` and `$.turn.abort`, which are unchanged since 2.1.308.

## Problem and current behavior

Mods written for Claude Code follow the turns of a session:

- Token Weather, the sample that marks the first milestone, reads `$.session.usage()` in a `turn.complete` hook to chart the context window after every turn.
- A Mod returns `{ text }` from `turn.complete` to show a line beneath the answer, such as a summary.
- A guard ends the running turn with `$.turn.abort` when one of its hooks decides the turn must stop.

Qwen Code skips these hooks at load and reports `Hooks for unsupported events will not run: turn.complete, turn.start`. `$.turn.abort` throws `Mod API not supported`.

## Goals and non-goals

Goals:

- Run `turn.start` and `turn.complete`, in Claude Code's shapes, for the main loop's turns in headless runs and in the Ink and OpenTUI terminals.
- Let a Mod end the running turn with `$.turn.abort`.
- Show a `turn.complete` hook's text beneath the answer.

Non-goals:

- Subagent and teammate turns, which Claude Code marks with `agentId`. They come with subagent support.
- `turn.step`, the streamed model request.
- `$.prompt.submit`, which Claude Code uses to send the next prompt after `$.turn.abort`.
- Turns the main loop starts on its own: scheduled prompts, background notifications, teammate messages and goal continuations.

## Proposed changes

### 1. What a turn is

A turn begins when the main loop sends a prompt. It ends when the model answers without calling more tools, when it is cancelled, or when it fails. Tool results and Stop hook continuations belong to the turn they continue.

Turn events cover the prompts a person submits:

- a typed or piped prompt, or one a command submits;
- a retry of the last prompt with Ctrl+Y, and the headless continuation of an interrupted turn. These have no typed prompt, and `$.session.turns()` does not count them, since the transcript records no new user turn for them.

### 2. `turn.start`

`turn.start` fires once the prompt is admitted, after UserPromptSubmit lets it through and before the first model request. A prompt that a hook blocks has no turn. Its input is:

- `text`: the prompt as the person submitted it, with pasted text expanded, or `""` for a retry or a continuation.
- `turnId`: a new id. The turn's `turn.complete` carries the same one.
- `isTextTruncated`: `true` when the prompt was too long for a Mod payload. Such a prompt keeps its beginning and end around the line `[... truncated for Mods ...]`, within 128 KiB as JSON, so the hooks still run. The field is absent otherwise.

The model request does not wait for the hooks. The turn's `tool.call` dispatches and its `turn.complete` queue behind them, so a hook that heard the start hears the end after it. Cancelling the turn also ends the `turn.start` hooks that are still running, as in Claude Code, so the turn's tool calls do not wait for them. The input is pinned, and a hook's return value changes nothing.

### 3. `turn.complete`

`turn.complete` fires once when the turn has ended. When the session closes, for example on `/quit`, other hooks are cancelled at once, but turn ends are not: a `turn.complete` already running, every one still queued, and that of a turn still running, which ends as `aborted`, run in order before `session.end`, within one budget of the same length as its. Its input is:

- `answer`: the visible text of the turn's last model response, trimmed, or `""` if there is none. After a cancel during streaming it is the text received so far.
- `durationMs`: how long the turn took.
- `isAborted` and `reason`:
  - `aborted` when a person or a Mod cancelled the turn;
  - `error` when an API error, a loop detection or a session limit ended it;
  - `answer` otherwise.
  - `refusal` does not occur.
- `turnId`.
- `usage`: the four API token counts of the turn's model responses, summed, and the model of the last response. It is absent when no response finished. Requests made by subagents, side queries and compaction are not counted.
- `isAnswerTruncated`: `true` when the answer was cut the way a long prompt is.

A hook that returns `{ text }` with a different, non-blank text shows it beneath the answer. The line is attributed to the plugins that have `turn.complete` hooks:

- in a terminal, as the transcript line `[Mod <plugins>] <text>`;
- in headless text mode, as the same line on stderr, after the answer;
- in JSON modes, as a `system` `ui_log` message before the result.

The text is kept up to 4,096 characters. The conversation record is not changed, and a hook that returns the answer it heard, cut or not, adds no line.

In a terminal the hooks run after the turn ends, and the next prompt can already start. A headless run waits for them before it writes its result.

### 4. `$.turn.abort`

`$.turn.abort({ turnId })` ends the running turn and its running tools, the way a cancel does. It leaves no cancel notice such as "Request cancelled." and does not put the prompt back in the composer. Queued prompts then run.

The call rejects when no turn is running, when `turnId` is not the running turn's id, or when the turn is already ending. Like the other `$` methods, it is an API event that other plugins can observe, rewrite or deny.

A person's Esc still counts when it comes too, before or after the Mod's call: the turn ends as their cancel, as it would without the Mod.

In a headless run the turn ends with the error result "A Mod ended the turn." and exit code 130, the code of an interrupted turn. A stream-json session goes on to its next message.

## Design decisions

- **Admission comes from core.** UserPromptSubmit runs inside the client's send, after the host has handed over the prompt. A new `onPromptAdmitted` option of `sendMessageStream` tells all three hosts when a prompt is admitted, so a blocked prompt never starts a turn. Hosts already pass per-send callbacks the same way.
- **The turn reads its own streams.** Each host hands the turn every event of its model streams. The answer, the failure and the usage come from those events, so every host reports them the same way. Headless runs do so on both loops: the current one and the shared agent loop behind `experimental.unifiedAgentLoop`.
  - Usage is summed from each response's finish event, so only the turn's own requests count.
  - The model comes from the session's record of each API response.
- **`turn.start` does not hold the request.** Claude Code does not delay the model request for these hooks. Queuing the turn's later dispatches behind the start keeps their order without adding latency.
- **Ink ends a turn when its stream goes idle.** Ink ends a turn on many paths, and idle is the one state that every path reaches. The cancel and failure paths record the reason on the way.
- **The note goes where the Mod's transcript logs go**, so no new output channel is needed.
- **The host judges `$.turn.abort`.** The worker asks the host, which owns the running turn, and answers the call with its verdict.

## Differences from Claude Code

These go into the user guide:

- Turn events cover only the main loop and only the prompts a person submits. `agentId` never appears.
- `reason` is never `refusal`.
- `usage.cache_creation_input_tokens` is 0 unless the provider reports cache writes separately, as Anthropic's does.
- A prompt or answer longer than 128 KiB as JSON reaches the hooks cut, with `isTextTruncated` or `isAnswerTruncated` set. Claude Code passes it whole.
- In headless text mode the note goes to stderr.
- `$.prompt.submit` does not exist yet, so a Mod cannot send a prompt after `$.turn.abort`.

## Validation and acceptance

- Real QuickJS worker tests:
  - which plugins hear the turn events;
  - pinned inputs;
  - `{ text }` results, and results of the wrong shape;
  - a prompt and an answer at the size the session cuts them to;
  - `$.turn.abort` asking the host, its rejections, and another plugin denying or rewriting it;
  - a `$.turn.abort` the host never answers, which the dispatch's end settles.
- A client test that `onPromptAdmitted` runs after admission and before the request, once for a send that continues itself, and never for a blocked prompt.
- Mod session tests:
  - `turn.start` runs beside the turn, and its end after the turn's tools;
  - cancelling the turn ends its `turn.start` hooks, not its `turn.complete` hooks;
  - the answer through retries, cancels and a continuation after MAX_TOKENS;
  - the reasons;
  - the usage sums, with reasoning counted once for each provider and a consistent total deciding, counts that are not whole counts, and the model of the turn's own prompt;
  - a prompt and an answer too long for a Mod payload;
  - the note, cut without splitting a character, kept to 4,096 characters in a terminal, and written beneath the answer in text mode, also when an exit ended the turn;
  - the rules of `$.turn.abort`, and a second try after the host failed to cancel;
  - a failed hook;
  - a turn whose session has ended;
  - a turn still running when the session closes, an end the close overtook, an end already running at the close, every queued end in order, and the budget that bounds them.
- Host tests:
  - headless, on the current and the shared agent loop: an answer, a structured-output answer, a blocked prompt, the continuation of an interrupted turn, a Mod abort in JSON and text and from a `tool.call` hook, a Goal turn that a tool ends before a continuation, a loop-detected turn that ends before the Mods close, and a failed request;
  - Ink: a turn from admission to idle, a Mod abort compared with Esc, a Mod abort of a retry before its admission renders, a Mod abort after an Esc that leaves a running side question (`?btw`) alone, a cancel without an Esc, a cancel in a later round that ends the `turn.start` hooks, a turn whose tools were cancelled or could not go on, a failed continuation, a slash command that waits for the Mods to start, a prompt sent without its composer provenance and a retry, and no hook without Mods;
  - OpenTUI: admission and a single end, interrupt and error, a Mod abort that lets the queue run, an Esc before or after a Mod abort, a turn whose tools were all declined, a retry with no typed prompt, and no hooks without Mods.
- The built CLI against a fixture server, in headless JSON and text and in the Ink and OpenTUI terminals:
  - the `turn.start` text;
  - the `turn.complete` answer, and usage that matches the fixture's counts;
  - the note beneath the answer;
  - a turn with a tool call;
  - Esc;
  - a Mod that ends its turn from a `tool.call` hook.

## Risks and open questions

- Ink ends a turn when its stream goes idle. A path that leaves the stream busy would delay `turn.complete` until it does. The next admitted prompt ends any open turn first.
- In a terminal, `turn.complete` hooks run after the answer. A slow hook delays the next turn's tool middleware by up to its budget.
