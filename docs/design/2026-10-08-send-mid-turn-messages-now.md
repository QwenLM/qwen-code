# Send queued mid-turn messages now

[English](2026-10-08-send-mid-turn-messages-now.md) | [简体中文](2026-10-08-send-mid-turn-messages-now.zh-CN.md)

Status: implemented.

## Problem

A message the user types while a turn is running goes to
`POST /session/:id/mid-turn-message`. The daemon queues it in
`SessionEntry.midTurnMessageQueue`, and the ACP child pulls it with
`craft/drainMidTurnQueue` only after a tool batch finishes, or at a Stop
check. The message therefore waits for the model response that is streaming
and for that response's tool batch. When the response is a plain answer, the
message waits for the whole answer and then runs as a new prompt.

Measured with `qwen serve`, Web Shell and a scripted provider (times run from
the insert to the request that carries the message):

| Situation at insert time                   | Delay  | Waiting for                |
| ------------------------------------------ | ------ | -------------------------- |
| Model streams a 10 s answer, no tool calls | 8.3 s  | the answer, then promotion |
| Model streams 6 s, then one quick tool     | 5.1 s  | the response and the tool  |
| Short steps (1.5 s response, 1 s tool)     | 1.35 s | the next tool boundary     |
| Silent 5 s before the first token          | 3.9 s  | the response               |
| One 8 s shell command running              | 6.1 s  | the command                |

The daemon and the browser add little: the POST answers in 2–4 ms and a drain
reaches the next request in 10–50 ms. A real model's response can stream for
tens of seconds, so an urgent correction has no fast path. The only one is
Stop, which ends the turn and cancels running tools.

## Prior art

- Claude Code: Enter queues the message, and it joins the turn at the next
  tool boundary. A separate send-now key (Ctrl+Enter) interrupts the turn and
  runs the message at once, after moving running shells to the background
  where it can. An opt-in mode makes Enter interrupt instead.
- Codex: Enter steers into the running turn and, with `instant_interrupt` on
  by default, cancels the streaming response; Tab queues the message for
  after the turn.

The default stays as it is: a message that adds context should not cut a long
answer or a large tool call short, and a queued row stays editable until it
is delivered. Interrupting becomes an explicit action.

## Goals and scope

- Typing during a turn keeps tool-boundary delivery, unchanged.
- A send-now action delivers the queued messages within one round trip while
  a foreground turn streams a model response. Goal continuations are
  foreground turns and are covered too.
- Running tools are never interrupted; their results go out with the
  messages.

Out of scope: channel turns (each response block is delivered as it ends),
cron and background-notification turns, and a composer shortcut. Web Shell
binds Ctrl/Cmd+Enter to a newline today.

## Design

### Daemon

`POST /session/:id/mid-turn-messages/send-now`, advertised by
`session_mid_turn_send_now`, calls the bridge's `sendMidTurnMessagesNow`. It
authorizes the client like the sibling mid-turn routes. When user messages
wait in the queue it sends the agent `MID_TURN_SEND_NOW_METHOD`
(`craft/midTurnSendNow`, `{ sessionId }`) without waiting and answers
`{ requested: true }`; otherwise it answers `{ requested: false }`.
Queue-only steering alone does not count, since it is not the user's to send,
and the agent's send-now drain (`craft/drainMidTurnQueue` with
`userInputOnly: true`) leaves it queued. It goes out with the next request to
the model (after a cut, the same turn's next request), or through the settle
path its caller drives if the turn ends first. The request is advisory: an agent that
does not know the method answers `-32601`, and the queue is still drained at
the next tool boundary.

### Agent

`acpAgent` routes the request to `Session.sendMidTurnInputNow()`, which
records it for the running turn and wakes the response currently open to
interruption. A request that arrives before the response opens waits for it.
`#openResponseInterrupt` opens each model response in the main prompt loop
and in Stop continuations of foreground, non-channel turns:

1. The send uses a signal that combines the turn's signal with a
   per-response controller, and the stream is read through `watch`.
2. While the stream is open, has not started a tool call, and a request is
   recorded for its turn, one early drain for the user's messages goes out
   through the existing drain request. The drained messages go to the buffer
   every later drain reads first (`midTurnRecoveredMessages`). If that drain
   times out and the host answers later while the response still streams,
   the late answer is handled the same way.
3. Only when the drain returned input, the response is still open, and it has
   not started a tool call (complete, or with its arguments still streaming),
   the controller aborts with `MID_TURN_INPUT_ABORT_REASON`. LlmChat treats
   this like a cancel: the part already delivered stays in history and the
   transcript. `watch` absorbs the abort and ends like a normal end of
   stream.
4. After a response without function calls, `takeInput` waits for an early
   drain still in flight and, only when this response's drain took input,
   drains the buffer and the queue and returns the user message. The loop
   sends it in the same turn. When the response was cut short the message
   carries the prefix
   `[User message received while you were responding; your response was interrupted]`,
   and when the response had already ended,
   `[User message received while you were responding]`. Otherwise delivery
   stays at the next tool boundary, as before. A turn stopped by then takes
   nothing more from the host, which promotes what is still queued. Input
   answered this way inside a Stop-hook continuation replaces that turn, as
   input drained before a Stop check does: the next Stop check is not
   hook-forced, and the count of consecutive blocks restarts.
5. If the turn ends before it sends input an early drain took (it is
   cancelled, fails, or a tool ends it), the turn records that input in the
   conversation and the transcript, as a stopped tool run already does with
   input the host handed over. The turn has ended and only records the input,
   so resolving its attachments gets a 2 s deadline of its own, past which
   the input is kept as text. The deadline also cancels media bridges, so no
   conversion runs on or reports after the turn; their per-turn image limit
   then counts this input on its own.

### Web Shell

A queued mid-turn row that the daemon owns shows a Send now action next to
delete and edit when the daemon advertises the capability. It calls the route
through the SDK's `sendMidTurnMessagesNow` (the session client, or the daemon
client with the persisted client id for a row restored after a session
switch). The row then clears on the usual `mid_turn_message_injected` echo.
When the daemon answers `{ requested: false }`, the row's message has already
left the queue, so the row is reconciled against the daemon's queue instead,
where the daemon supports the mid-turn query and the row has a session.
A second click on the row while the request is out is ignored.

### Decisions

- **Explicit, not default.** Enter keeps the edit window and never cuts a
  response for an aside; the user decides when a message is urgent.
- **Session-wide.** Send now on one row serves the session's user input, not
  only that row: the drain takes the user's queued messages, in queue order,
  within the drain limit listed under Risks.
  Queue-only steering keeps its own delivery; when it goes out in the same
  request, it follows the user's messages.
- **Drain before abort.** Aborting first could leave nothing to send: the
  message may already be gone (deleted, or taken by another drain), and the
  turn would end with a truncated answer. Draining first means an extra
  request costs one in-memory round trip and never cuts a response for
  nothing.
- **No cut once a tool call starts.** A response that has started a tool
  call, even one whose arguments are still streaming, keeps running, and the
  queue stays with the host. The boundary drain then delivers the messages
  with the tool results, or, when a tool ends the turn, the host promotes
  them to the next prompt as before. No tool call is left without a result,
  and no call the provider has announced is thrown away.
- **Scoped to the turn.** A request is bound to the turn it arrived in and is
  cleared whenever a drain request goes out, since that request takes
  everything queued before it, and when that turn ends, whether it finished,
  failed or was stopped. A request that arrives between turns is ignored. A
  request the turn never served therefore cannot cut a later turn short for
  messages typed with plain Enter.
- **Taken input is never stranded.** Once the host hands queued input over,
  the user sees it as delivered and the host will not promote it. Input a
  send-now drain took but the turn never sent is kept in that turn's
  conversation rather than dropped, also when the turn is stopped while a
  tool boundary resolves it. Only a drain that timed out and is answered
  after the response it was meant to interrupt has ended falls back to the
  existing late-recovery path, which delivers the input with a later drain,
  possibly in a later turn. The limits listed under Risks still apply.
- **Partial output is kept.** The cut-off text stays in the transcript (Web
  Shell shows it inside the turn's collapsed processing group) and in
  context, so the model can resume or change course. When the cut comes
  before the first token, history holds two user contents in a row; the
  OpenAI-compatible request was verified to send them as one user message.

## Compatibility

- New Web Shell, older daemon: the capability is missing, so no Send now
  action is shown.
- New daemon, older agent: the request fails with `-32601`, which the daemon
  logs and otherwise ignores. Delivery stays at tool boundaries.
- The desktop ACP client and the standalone channels host answer drains from
  their own queues and never send the request, so their behavior is unchanged.

## Validation

- Unit: `Session.test.ts` covers a cut-off response answered in the same
  turn; a request that arrives before the response opens; a request that
  finds an empty queue; a response that already called a tool, whose tool
  call is still streaming (in the main loop and in a Stop continuation),
  whose tool call starts while the drain is out, or whose tool ends the turn;
  a drain that answers after the response ended; late answers from a
  timed-out send-now drain during the response, after it, and after the turn;
  input recovered from a timed-out drain; a host that cannot answer drains; a
  Stop-hook continuation, and the Stop-hook state after input cut one short;
  a Goal continuation; channel turns, their Stop continuations, and
  background-notification turns; repeated requests while a drain
  is out; a tool-boundary drain that waits for an early drain; input kept
  when the turn is cancelled (as text when its attachment cannot be resolved
  then) or when a tool ends it while the drain is out (within the keep
  deadline when a file read or a media bridge hangs, the bridge being
  cancelled at the deadline), or when the turn is stopped while a tool
  boundary resolves it; no further
  drain once the turn is stopped, also while its response still streams; a
  request between turns; a request its turn never served; and a request left
  over from a stopped turn. `acpAgent.test.ts` covers routing and the
  session context. `bridge.test.ts` and `bridgeClient.test.ts` cover that
  typing alone sends nothing, that send-now sends the request only when user
  messages wait, that a rejected request is logged and changes nothing, that
  the send-now drain leaves queue-only steering queued, that a failed
  send-now drain requeues in the original order without what left the queue
  meanwhile, and client authorization.
  `server.test.ts` and `multi-workspace-sessions.test.ts` cover the route,
  its owner routing and its failure statuses, the SDK tests cover both
  clients, and the Web Shell tests cover the row action, its wiring in the
  app and the chat pane, the hook (including a row already gone from the
  queue and a repeated click) and the session action. Removing any one of
  the agent guards behind the decisions above fails a test, with two
  exceptions: the turn binding and the end-of-turn reset back each other up,
  and the check that keeps a superseded Stop-hook continuation from undoing
  a restarted block count has no test of its own.
- End to end, same harness as above; Enter then Send now right away:

| Situation at insert time          | Enter only | Send now |
| --------------------------------- | ---------- | -------- |
| 10 s answer streaming             | 8.29 s     | 15 ms    |
| 6 s response before a quick tool  | 5.12 s     | 10 ms    |
| Short steps                       | 1.35 s     | 11 ms    |
| Silent 5 s before the first token | 3.97 s     | 11 ms    |
| 8 s shell command running         | 6.10 s     | 6.10 s   |

In Web Shell the typed message stayed queued with its Send now action, and the
click reached the model 47 ms later. The interrupted request carries the
partial answer as an assistant message followed by the prefixed user message,
and the transcript keeps that order after a reload.

## Risks

- An interrupted response is billed for the tokens it produced, and the next
  request resends the context. Send now is an explicit action, and prompt
  caching keeps the resend cheap.
- A response cut short may end before the provider reports its token usage.
  As on a cancel, that usage is then missing from the turn's usage report.
  The next request's prompt count includes the partial answer, so the
  context-size accounting catches up with it.
- While a tool runs, Send now has no visible effect until the tool finishes.
  Claude Code moves running shells to the background in this case; that is
  left for later.
- A tool call is recognized only once the provider announces it. A provider
  that streams tool-call arguments without a call id, one that announces a
  call only when its arguments are complete (the OpenAI Responses path
  today), or a model that writes tool calls as text, can still have a
  half-written call cut short.
- In the narrow window where a drain is already out when a tool call starts,
  and that tool then ends the turn, or when the turn is stopped, the taken
  input is kept in the conversation and transcript but is not answered in
  that turn. When the send-now drain itself times out (the agent waits 2 s,
  and the daemon may still be reading attachments) and the host answers
  after the response ended, the input is delivered with a later drain,
  possibly in a later turn. As for any timed-out drain, it is lost if the
  answer comes more than 30 s after the timeout, or if the turn is stopped
  while that later drain resolves its attachments.
- The agent reads at most 10 messages from one drain answer, while the
  daemon's queue holds up to 20 and a drain hands all of them over. With
  more than 10 user messages queued, the rest are settled but never
  delivered. A tool-boundary drain does the same today; aligning the two
  limits is left for a follow-up.
- When the turn is stopped while a tool-boundary drain resolves an
  attachment, the messages it has not built yet are still dropped, as before
  this change. Only input a send-now drain took is kept then, and not when
  that drain timed out and answered after its response ended.
