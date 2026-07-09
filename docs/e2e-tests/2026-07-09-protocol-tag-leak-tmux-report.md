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

## Screenshots

Ready state:

![Ready state](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-mock-ready-20260709-214730.png)

Filtered summary state:

![Filtered summary state](https://raw.githubusercontent.com/yiliang114/img-host/main/assets/protocol-tags-mock-summary-20260709-214730.png)

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

## Verification Commands

```bash
grep -q "VISIBLE_TMUX_SUMMARY_DONE" tmp/protocol-tags-mock-tmux-20260709-214730/tmux-readable-full.log
! grep -E "</?analysis|</?summary|internal scratchpad" tmp/protocol-tags-mock-tmux-20260709-214730/tmux-readable-full.log
```
