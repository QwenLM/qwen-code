# `/btw` session history and request lifecycle

[English](2026-11-06-btw-session-history.md) | [简体中文](2026-11-06-btw-session-history.zh-CN.md)

Status: implemented, pending manual verification.

## Problem

`/btw` answers a side question from a single-turn fork of the conversation.
The behavior had several gaps:

- Every side question stood alone. The model never saw earlier side answers,
  and a bare `/btw` only printed a usage error.
- The fork sent the last 40 history entries and stripped the tool list, so its
  request prefix differed from the main agent's. Long sessions lost context
  and the prompt cache could not be reused.
- A second `/btw` cancelled the first one.
- The fork ignored stream retries. A retry that restarted the request kept the
  failed attempt's partial text, so the answer could repeat a prefix. Remote
  streams had already sent that text to clients.
- The interactive answer appeared only after it completed; retries were
  invisible.
- A model reply that tried to call a tool came back as "No response received."
- The fork prompt did not rule out "Let me check..." style promises.

## Goals

1. Keep up to 20 answered side questions per session and add them, as
   user/model turns, after the main conversation in later side questions.
   Every surface (TUI, ACP, daemon, Web Shell, channels, SDK) shares the
   history of the session it targets.
2. Send the full curated history and keep the parent tool declarations with
   function calling disabled, so the fork's prefix matches the main request.
   Providers without a `NONE` function-calling mode (Anthropic) drop the tool
   declarations instead, because keeping them would re-enable tool calls.
3. Let side questions run concurrently. Only an explicit cancel (Esc, Ctrl+C,
   Ctrl+D) aborts the one on screen; showing another one does not.
4. A bare `/btw` in the TUI reopens the newest running side question, else the
   newest answer, else prints the usage hint.
5. Rewind streamed text when a retry restarts the request, and tell remote
   clients through a `reset` stream event.
6. TUI: stream the answer, show retry status with a countdown, browse earlier
   answers (←/→), copy the answer (`c`), clear earlier answers (`x`).
7. Suggest `/btw` in the loading indicator on turns of 30 seconds or more
   until the user has used it once.

## Non-goals

- Persisting side questions into the transcript or across restarts.
- A modal panel or new keybinding configuration. The existing bottom-area
  display keeps its layout.
- OpenTUI key actions. OpenTUI renders the same item, so it gets streaming,
  history and reopen, but not browse/copy/clear keys.
- Changing the Anthropic converter. It has no mapping for function calling
  mode `NONE`, so the Anthropic fork drops the parent tool declarations
  instead of keeping them with an implicit `tool_choice: auto`.

## Design

### Core

- `packages/core/src/agents/btw-session.ts` adds `BtwSession`, one per
  `Config` and session id (`getBtwSession(config)`). A changed session id
  (`/clear`, `/new`, resume) disposes the previous session, aborting its
  requests.
- `ask(question, { signal, onText, onReset })` starts a request and returns
  `{ id, done }`. The session accumulates streamed text and retry state,
  settles each request once, and appends only `answered` outcomes to the
  history. Other outcomes are `tool-call` (the model tried to call a tool),
  `empty`, `unavailable` (no conversation context), `failed` and `cancelled`.
- `buildBtwCacheSafeParams(config, exchanges, options)` returns the curated
  history followed by the exchanges. By default it reads the last 40 history
  entries (the `/advisor` shape); `{ fullHistory: true }` reads the whole
  curated history, which `runBtwQuery` passes. `buildBtwPrompt` uses the
  longer system reminder.
- `runForkedAgent` (cache path) gains `fullHistory`, `disableFunctionCalls`
  (function calling mode `NONE` while keeping tools) and `onRetry`. A retry
  without `isContinuation` clears the accumulated text. The result reports
  `toolCallName` when a preserved-tools fork emitted a function call.

### CLI TUI

- `btwCommand` asks the session and hands the request to `ui/utils/btw-view.ts`,
  which subscribes to the session and pushes the derived item through the
  existing `setBtwItem`. `btwAbortControllerRef` now belongs to the view:
  aborting it (`cancelBtw`) cancels the shown request if it is still running.
  Showing another request, or dismissing with Space/Enter, detaches without
  cancelling. Space/Enter never dismiss a view whose own request is still
  running, even while an earlier settled answer is browsed.
- With an empty input buffer and the btw area visible: ←/→ enter browse mode
  and browse earlier answers; while in it, `c` copies the shown answer and
  `x` removes the earlier answers; any other key leaves browse mode and is
  typed normally. The footer lists only the actions that apply.
- `TipHistory` stores `btwUseCount`. The command counts a use only when tips
  are enabled, so opting out never writes the file.

### Remote surfaces

- ACP `/btw`, the `sessionBtw` method and the btw generation stream all go
  through `getBtwSession`.
- Generation events gain `{ type: 'reset' }`. The bridge client forwards it;
  the serve btw stream clears its answer snapshot. Snapshot clients need no
  change. When a restarting retry leaves no visible text, the stream emits the
  same outcome notice the TUI shows.

## Risks

- Full history makes each side question as large as the main request. This is
  the cost of matching its cache prefix; threaded history adds at most 20
  answers. A request that overflows the context fails visibly, and `x` clears
  the threaded answers.
- Several clients attached to one daemon session share its side-question
  history.
- An arrow key enters browse mode, where the next `c` or `x` is taken as a
  shortcut instead of being typed. Any other key leaves the mode, and the
  footer shows the shortcut keys only while browsing. An arrow with nothing
  to browse does not enter the mode.

## Verification

- Unit tests: `btw-session.test.ts`, `forkedAgent.cache.test.ts` (function
  calling mode, restart vs continuation retries, tool-call name, full
  history), `btwUtils.test.ts`, `btw-view.test.ts`, `btwCommand.test.ts`,
  `btw-generation.test.ts`, `btw-stream.test.ts`, `BtwMessage.test.tsx`,
  `tipHistory.test.ts`, `btw-tip.test.ts`, `bridgeClient.test.ts`.
- Manual: ask two side questions in a row and confirm the second can refer to
  the first; run a bare `/btw`; start a second `/btw` while the first is
  running; press Esc on a running one; browse, copy and clear.

## Acceptance criteria

1. A second side question's request contains the first question and answer
   after the main conversation.
2. A bare `/btw` reopens the running question, else the last answer.
3. A newer `/btw` does not cancel an older running one; Esc cancels the one on
   screen and records nothing.
4. A restarting retry leaves no text from the failed attempt, locally or in
   remote streams.
5. A model reply that only calls a tool shows the tool-call notice and is not
   recorded.
6. The loading indicator suggests `/btw` on turns of 30 seconds or more until
   the first use, and never when tips are disabled.
