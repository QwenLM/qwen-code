# Structured Output (`--json-schema`)

Constrain the model's final answer to a JSON Schema you supply. Qwen
Code registers a synthetic terminal tool the model is required to call,
parses the call's arguments against your schema, and exposes the
validated payload on stdout (or in the JSON / stream-json result
envelope). The first valid call ends the run.

Headless only — works with `qwen -p`, a positional prompt, or a prompt
piped via stdin.

## Quick start

```bash
qwen --prompt "Summarize the changes in HEAD with risk_level" \
  --json-schema '{
    "type": "object",
    "properties": {
      "summary":    { "type": "string" },
      "risk_level": { "type": "string", "enum": ["low", "medium", "high"] }
    },
    "required": ["summary", "risk_level"],
    "additionalProperties": false
  }'
```

Output on stdout (default `--output-format text`):

```json
{"summary":"…","risk_level":"low"}
```

The line is exactly the JSON-stringified payload + newline — no
envelope, no event log. Pipe it straight into `jq` or another consumer.

All error messages, log lines, and the model's incidental prose go
to **stderr**. Stdout in text mode is reserved for the JSON payload on
success and is empty on failure, so `$(qwen --json-schema …)` capture
patterns are safe — failures land in stderr, not mixed into the
captured variable.

> **Empty schema:** Passing `{}` always produces `null` on stdout. The
> model calls `structured_output` with no arguments, and `undefined`
> payloads normalize to literal JSON `null`.

## Supplying the schema

Two equivalent forms:

```bash
# Inline JSON literal
qwen -p "…" --json-schema '{"type":"object", "properties":{…}}'

# Read from a file
qwen -p "…" --json-schema @./schemas/summary.json
```

The `@path` form expands `~`, normalizes the path, and reads the file
with `utf8` encoding.

> **Latency note:** Successful runs incur a fixed ~500 ms shutdown
> holdback while in-flight background agents flush their final
> notifications before the result is emitted. Single runs barely
> notice it; batch pipelines that fan out hundreds of `--json-schema`
> invocations should account for this floor.

> **Security note:** Schemas may contain user-supplied regular
> expressions in `pattern` keywords. Ajv compiles these with the
> ECMAScript regex engine, which is vulnerable to catastrophic
> backtracking — a malicious schema like `{"pattern": "(a+)+b"}` can
> hang the CLI on a moderately long input. Only run `--json-schema`
> with schemas from sources you trust.

Validation at parse time:

- The file must be a regular file (no FIFOs, character devices, or
  directories).
- File size is capped at 4 MiB. Real-world JSON schemas are well under
  this; multi-MiB files almost always indicate a wrong-path mistake.
- The schema must be valid JSON. For `@path` input, the parse error is
  generic ("content of `<path>` is not valid JSON") rather than echoing
  the SyntaxError detail, so a wrapping process that surfaces stderr
  can't read a prefix of the file's contents back from the error.
- The schema must compile under the strict Ajv configuration —
  typos like `propertees` are surfaced, but spec-valid patterns
  (e.g. `required` without listing every key in `properties`) are
  accepted.
- The schema root must accept object-typed values. Function-calling
  APIs (Gemini, OpenAI, Anthropic) all require tool arguments to be
  JSON objects, so a non-object root would register an unusable tool.

The root-acceptance check walks `type`, `const`, `enum`, `anyOf`,
`oneOf`, `allOf`, `not`, and `if`/`then`/`else` (best-effort for the
decidable cases). When in doubt it defers to Ajv at runtime.

> **Root `$ref` is rejected** by the parse-time check. If your schema
> reuses a definition via `$ref`, wrap it in `allOf`:
>
> ```jsonc
> // Rejected:
> { "$ref": "#/$defs/MyObj", "$defs": { … } }
>
> // Accepted (root accepts objects via the allOf branch):
> { "allOf": [{ "$ref": "#/$defs/MyObj" }], "$defs": { … } }
> ```
>
> `$ref` inside `anyOf` / `oneOf` / `allOf` is deferred to Ajv at
> runtime, so the wrapped form passes the root-acceptance check.

## Output shape per format

| `--output-format` | What goes to stdout |
| --- | --- |
| `text` (default) | `JSON.stringify(payload) + "\n"` — one line, the validated object. |
| `json` | A single JSON document containing the full event log plus a `result` (`JSON.stringify(payload)`) AND a top-level `structured_result` field carrying the raw object. |
| `stream-json` | Each event on its own line as JSONL. The terminating `result` line carries `result` (stringified) and `structured_result` (raw object). |

In both JSON formats, prefer reading `structured_result` over `result`
when you want the object; `result` is the stringified form provided for
consumers that always expect a string in that field.

## Restrictions

| Combination | Behavior |
| --- | --- |
| `--json-schema` + `-i` / `--prompt-interactive` | Rejected at parse time. The synthetic tool's "session ends now" message has no terminator in the TUI loop. |
| `--json-schema` + `--input-format stream-json` | Rejected at parse time. The single-shot terminal contract is incompatible with the long-lived stream-json input protocol. |
| `--json-schema` + `--acp` / `--experimental-acp` | Rejected at parse time. ACP runs its own turn loop that doesn't honor the synthetic-tool terminal contract. |
| `--json-schema` with no prompt and no piped stdin | Rejected at parse time. Headless mode needs a prompt — pass `-p`, a positional argument, or pipe one in. |
| `--bare` + `--json-schema` | Supported. The synthetic tool is registered alongside the bare three (`read_file`, `edit`, `run_shell_command`). |
| `--json-schema` inside a subagent | Tool is NOT registered. Only the main / drain turns of the top-level run honor the terminal contract; a subagent calling the tool would receive "session ends now" and then keep running because its loop has no terminator. |

## Retry and failure modes

The session ends on the first valid call. Until then:

- **Args fail validation.** `structured_output` returns a tool-result
  error with Ajv's message, the model sees it on the next turn, and
  may correct the arguments and call again.

  > **Cost note:** every retry is a full model turn (request +
  > inference + response). A schema that the model misses repeatedly
  > will multiply your token spend and latency for that run. Constrain
  > schemas enough to guide the model, simple enough to nail on the
  > first try; consider raising `--max-session-turns` when retries are
  > expected.

- **Model calls a side-effecting tool in the same turn as
  `structured_output`.** The pre-scan suppresses the sibling — it
  never runs, regardless of whether the structured call ultimately
  validates. The two paths split on what the model sees next:
  - **Validation succeeds:** the run ends immediately, and the model
    never gets another turn — the suppressed sibling is silently
    discarded.
  - **Validation fails:** the model gets another turn and sees a
    synthesised "Skipped:" `tool_result` for the suppressed call,
    so it can re-issue that call in a separate turn alongside the
    retried structured call.
- **Model emits plain text instead of calling
  `structured_output`.** Exit code `1`. The error message includes
  the turn count and a truncated preview of the model's output so
  you can see what it actually said.
- **Run reaches `maxSessionTurns`.** Exit code `53`. Standard
  "Reached max session turns" exit, plus a `--json-schema`-specific
  hint that points at the three common stuck-run causes: model never
  called the tool, `structured_output` is denied by permission rules,
  or the schema is unsatisfiable.
- **Run is interrupted (SIGINT / Ctrl-C).** Exit code `130`. No
  structured result is emitted, even if one had been captured during
  the shutdown holdback.

## Privacy

The args you submit through `structured_output` ARE the structured
payload — already emitted on stdout. To avoid persisting the same
payload a second time into on-device surfaces that may be exported off
the machine, args are redacted with the placeholder
`{ __redacted: 'structured_output payload (see stdout result)' }` on:

- The `ToolCallEvent` telemetry path (OTLP exports, QwenLogger,
  ui-telemetry stream, chat-recording UI event mirror).
- The on-disk chat-recording JSONL at
  `<projectDir>/chats/<sessionId>.jsonl` (re-fed into model context on
  `--continue` / `--resume`), including every validation-failure retry.

Tool-call metrics (duration, success, decision) and surrounding event
metadata are preserved.

## Session resumption (`--continue` / `--resume`)

`--json-schema` is a per-run flag, not a per-session property. The
synthetic tool is registered when the CLI parses its arguments, so:

- Re-pass `--json-schema` on every `--continue` / `--resume` you want
  the terminal contract to apply to. The same schema as the original
  run is the safe default — a mid-session schema swap is allowed but
  changes the contract the model is being held to.
- If you `--continue` without `--json-schema`, the resumed run is an
  ordinary headless session: `structured_output` simply doesn't
  exist as a tool, and the model will respond in free-form text.
- The `__redacted` placeholder in the resumed chat-recording does
  not affect resumability in practice. A successful `structured_output`
  call terminates the session immediately, so the only redacted args
  a resumed run could see are from failed attempts. The model still
  has each attempt's Ajv validation error in the recorded `tool_result`
  and the live parameter schema (re-registered from `--json-schema`),
  which is enough to retry.

## Permission gating

`structured_output` deliberately bypasses the `--core-tools` allowlist:
the tool only exists when `--json-schema` is set, so excluding it
would leave the run with no terminal contract.

Explicit `permissions.deny` rules or `--exclude-tools` settings DO take
effect. If you deny the tool, the model can't call it and the run will
hit `maxSessionTurns` — at which point the `--json-schema` hint in the
error message tells you exactly where to look.

## Conflict with MCP tools

If an MCP server registers a tool literally named `structured_output`,
the tool-registry collision check renames the MCP tool to
`mcp__<server-name>__structured_output` so the synthetic tool keeps
the bare name. The user-supplied schema is always the one the model
sees.

## Example: gating a multi-step run on the structured output

```bash
RESULT=$(qwen --prompt "Audit this diff and rate its risk." \
  --json-schema @./schemas/audit.json) || exit 1

risk=$(jq -r '.risk_level' <<<"$RESULT")
if [ "$risk" = "high" ]; then
  echo "High-risk diff; pausing pipeline." >&2
  exit 2
fi
```

## See also

- [Headless Mode](headless.md) — the `-p`-based flow `--json-schema`
  builds on.
- [Dual Output](dual-output.md) — when you want both the TUI and a
  structured JSON-event sidecar for the same run.
