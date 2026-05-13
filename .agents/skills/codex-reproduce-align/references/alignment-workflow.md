# Alignment Workflow Reference

The alignment phase starts after Qwen Code has a candidate implementation. Use it to create a tight loop: run both tools, compare traces, patch the target, and rerun only the failing scenario.

## Trace Inputs

Expected raw capture layout:

```text
.repro-runs/<scenario>/
  codex/
    http.jsonl
    command.stdout
    command.stderr
    command.exit
  qwen/
    http.jsonl
    command.stdout
    command.stderr
    command.exit
```

Use capture scripts from `$codex-reproduce-feature` for raw capture, or use `run_pair_capture.sh` for simple non-interactive shell scenarios.

## Normalization

`normalize_trace.py` reads mitm JSONL output and emits stable JSON:

- request method and URL path
- JSON request body summary
- message role order and brief content hashes
- tool/function names
- schema required fields
- response status code

It intentionally drops:

- timestamps
- authorization and cookie headers
- provider request IDs
- full message text unless needed for a hash

## Diff Triage

High priority:

- missing request entirely
- wrong endpoint family
- missing tool/function schema
- incompatible required fields or enum values
- slash command not routed to the same behavior class

Medium priority:

- prompt role ordering differences
- terminal output phrasing differences
- streaming versus non-streaming if users can observe it

Low priority:

- timestamps, IDs, token counts
- harmless wording differences
- extra target-side metadata ignored by the provider

## Iteration Loop

1. Pick the highest-priority unexplained mismatch.
2. Patch only the likely owner module in Qwen Code.
3. Run the focused test/smoke path.
4. Capture only the affected scenario again.
5. Normalize and compare again.

Stop when the target behavior is compatible and remaining differences are either irrelevant or explicitly documented.
