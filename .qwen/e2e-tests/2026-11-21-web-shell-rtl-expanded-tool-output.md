# Arabic expanded tool output

1. Open Web Shell in Arabic and expand a completed AskUserQuestion row with Latin-first text and punctuation. The response should start on the left; the surrounding interface stays RTL.
2. Expand a Skill row with Arabic-first text. The details should start on the right. Repeating with Latin-first output should start on the left.
3. Verify both plain-text blocks use `dir="auto"`, not a shared LTR CSS override.

Baseline: this host has no global `qwen` executable. The focused DOM test verifies the rendered direction attribute before and after the fix.
