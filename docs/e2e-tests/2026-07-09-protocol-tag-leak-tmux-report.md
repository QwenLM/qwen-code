# Protocol Tag Leak Tmux Mock Report

Date: 2026-07-09

PR: <https://github.com/QwenLM/qwen-code/pull/6603>

## Scope

This report verifies the interactive TUI behavior for a deterministic OpenAI-compatible SSE response that splits top-level protocol wrappers across streamed content chunks:

```text
<analysis>internal scratchpad that must not render</analysis><summary>VISIBLE_TMUX_SUMMARY_DONE</summary>
```

Expected TUI result:

```text
VISIBLE_TMUX_SUMMARY_DONE
```

The TUI must not render `<analysis>`, `</analysis>`, `<summary>`, `</summary>`, or `internal scratchpad`.

## Command

```bash
node dist/cli.js \
  --no-chat-recording \
  --approval-mode yolo \
  --auth-type openai \
  --openai-api-key fake-key \
  --openai-base-url "$FAKE_BASE_URL" \
  --model fake-model
```

The fake server returned the content as three separate streamed deltas:

```text
<analysis>internal scratchpad that must not render
</analysis><summary>VISIBLE_TMUX_SUMMARY_DONE
</summary>
```

## Result

PASS.

- The tmux-readable log contains `VISIBLE_TMUX_SUMMARY_DONE`.
- The tmux-readable log does not contain leaked protocol tags.
- The tmux-readable log does not contain `internal scratchpad`.
- The final TUI frame shows only the visible summary marker.
- A separate retry mock shows request #1 returning HTTP 500 and request #2 streaming the tagged SSE chunks that the TUI filters after the HTTP-level retry.
- The checked-in interactive mock server test covers multiple HTTP retries: requests #1 and #2 return HTTP 500, request #3 streams the tagged SSE chunks, and the TUI still renders only the visible summary marker.
- Focused core unit tests verify that buffered tagged content is dropped across retry events and that tagged partial content from a failed attempt is discarded before persistence.
- Retry caps are explicit: OpenAI-compatible HTTP retry defaults to `DEFAULT_MAX_RETRIES = 3`; Qwen stream anomaly retry caps are invalid stream `2`, transport stream `2`, invalid content `2` attempts, and rate-limit stream retry `10`.

## Screenshots

The first two screenshots only show the user-visible TUI state. They prove the final TUI output is filtered; they do not prove retry on their own.

Ready state:

![Ready state](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-mock-ready-20260709-214730.png)

Filtered summary state:

![Filtered summary state](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-mock-summary-20260709-214730.png)

## Retry Evidence

The retry-specific tmux mock used a fake server that returned HTTP 500 for request #1 and then returned protocol-tagged SSE chunks for request #2. The server-side trace is the evidence for HTTP-level retry and for the raw tagged chunks:

![Retry server trace](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-retry-server-trace-20260709-220220.png)

The retry run's final TUI frame still shows only the visible summary marker:

![Retry filtered TUI](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-retry-tui-summary-20260709-220220.png)

The focused retry unit test covers the stricter in-memory/persistence behavior: tagged partial content from the failed attempt is discarded, and tagged content from the successful retry is stripped to the summary text before entering history. A separate `Turn` unit test covers the UI event layer by resetting a buffered protocol prefix on retry before the successful attempt emits content.

The automated interactive regression extends this to multiple HTTP retries by returning HTTP 500 twice before the successful SSE response:

```bash
cd integration-tests
npx vitest run interactive/protocol-tags-interactive.test.ts --test-name-pattern "retries HTTP failures" --retry 0
```

That test asserts the fake server observed at least three requests and that the final TUI output contains `VISIBLE_TMUX_RETRY_SUMMARY_DONE` without protocol tags or retry scratchpad text.

![Focused retry unit test](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-retry-unit-test-20260709-220220.png)

## Local Artifacts

The local run generated these artifacts under:

```text
tmp/protocol-tags-mock-tmux-20260709-214730/
```

- `tmux-readable-full.log`: primary readable tmux transcript.
- `tmux-final-capture.log`: final pane capture.
- `screenshot-ready.png`: rendered ready-state screenshot.
- `screenshot-summary.png`: rendered filtered-summary screenshot.
- `report.md`: run-local summary.

The retry-specific tmux run generated these artifacts under:

```text
tmp/protocol-tags-retry-mock-tmux-20260709-220220/
```

- `server-trace.txt`: raw fake server trace showing request #1 HTTP 500, request #2 HTTP 200 SSE, and the tagged content chunks.
- `tmux-readable-full.log`: rendered TUI transcript showing filtered retry output.
- `focused-retry-test-output.txt`: output for the focused core retry unit test.
- `protocol-tags-retry-server-trace-20260709-220220.png`: rendered server trace screenshot.
- `protocol-tags-retry-tui-summary-20260709-220220.png`: rendered retry TUI screenshot.
- `protocol-tags-retry-unit-test-20260709-220220.png`: rendered focused unit test screenshot.

## Verification Commands

```bash
grep -q "VISIBLE_TMUX_SUMMARY_DONE" tmp/protocol-tags-mock-tmux-20260709-214730/tmux-readable-full.log
! grep -E "</?analysis|</?summary|internal scratchpad" tmp/protocol-tags-mock-tmux-20260709-214730/tmux-readable-full.log
grep -q "RESPONSE #1 HTTP 500" tmp/protocol-tags-retry-mock-tmux-20260709-220220/server-trace.txt
grep -q "REQUEST #2" tmp/protocol-tags-retry-mock-tmux-20260709-220220/server-trace.txt
grep -q "VISIBLE_TMUX_SUMMARY_DONE" tmp/protocol-tags-retry-mock-tmux-20260709-220220/tmux-readable-full.log
! grep -E "</?analysis|</?summary|internal scratchpad" tmp/protocol-tags-retry-mock-tmux-20260709-220220/tmux-readable-full.log
cd integration-tests
npx vitest run fake-openai-server.test.ts --test-name-pattern "serves configured HTTP errors"
npx vitest run interactive/protocol-tags-interactive.test.ts --test-name-pattern "retries HTTP failures" --retry 0
(
  cd ../packages/core
  npx vitest run src/core/geminiChat.test.ts --test-name-pattern "discard tagged partial content"
  npx vitest run src/core/turn.test.ts --test-name-pattern "drops buffered protocol text"
)
```
