Send queued mid-turn messages now

## Baseline

No global `qwen` is installed on the verification host, so the baseline is a
local bundle of `main` (`npm run bundle`) run as
`node dist/cli.js serve --port <port> --token <token> --workspace <ws>` with an
isolated `HOME` whose `settings.json` selects the `openai` auth type and
`tools.approvalMode: "yolo"`. `OPENAI_BASE_URL` points at a scripted
OpenAI-compatible mock that timestamps every request. The mock streams a 10 s
plain answer, a 6 s response followed by a quick tool call, or an 8 s shell
command, chosen by a marker in the prompt. On that build a message posted to
`POST /session/:id/mid-turn-message` 2 s into the 10 s answer reaches the mock
8.2 s later, as a new prompt after the answer ends, and there is no way to
deliver it sooner without stopping the turn.

## Manual check

1. Start the daemon and the mock as above, open Web Shell at
   `http://127.0.0.1:<port>/?token=<token>`, and send a prompt the mock answers
   with the 10 s stream.
2. Two seconds in, type a second message and press Enter. Verify the row shows
   `Queued...` with Send now, delete and edit actions, and that the mock has
   not received the message 1.5 s later.
3. Click Send now. Verify the mock receives a request carrying the message
   within about 100 ms, as a user message that starts with `[User message
   received while you were responding; your response was interrupted]` and
   follows the partial answer as an assistant message, and that the row
   disappears.
4. Verify the transcript shows, in order, the partial answer, the message and
   the new answer. Reload the page and verify the same order.
5. Send a prompt the mock answers with the 8 s shell command, type a message
   and click Send now while it runs. Verify the command is not interrupted and
   the message arrives with its result.
6. Call `POST /session/:id/mid-turn-messages/send-now` with nothing queued and
   verify it answers `{ "requested": false }`.

## Automated coverage

`Session.test.ts` (queued input during a streaming response) pins the cut and
the same-turn answer, no cut when the queue is empty, no early drain once a
tool call has started (complete, still streaming, or ending the turn),
delivery when the drain answers after the response ended, no cut when a tool
call starts while the drain is out, late answers from a timed-out send-now
drain (during the response, after it, and after the turn), a Stop-hook continuation, channel turns, input
recovered from a timed-out drain, one drain at a time, a tool-boundary drain
that waits for an early drain, input kept when the turn is cancelled, a
request between turns, a request its turn never served, and a request left
over from a stopped turn.
`acpAgent.test.ts` pins routing of `craft/midTurnSendNow`. `bridge.test.ts`
pins that typing alone sends nothing, that send-now sends the request only
when user messages wait, and that the send-now drain leaves queue-only
steering queued. `server.test.ts` pins the route, the SDK unit tests pin
both clients, and the Web Shell tests pin the row action, the hook and the
session action.
