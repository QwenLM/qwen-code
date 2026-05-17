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
{ "summary": "…", "risk_level": "low" }
```

The line is exactly the JSON-stringified payload + newline — no
envelope, no event log. Pipe it straight into `jq` or another consumer.

In **text** mode, stdout is reserved for the JSON payload on success
and is empty on failure; error messages and log lines go to stderr.
That makes `$(qwen --json-schema …) || exit 1` capture patterns safe
under text mode — failures land in stderr, not mixed into the captured
variable. The model's incidental prose during planning is **not**
mirrored to stderr either — text mode discards it; reach for
`--output-format json` or `stream-json` if you need to see it.

In `--output-format json` and `stream-json`, the failure result
message is emitted on **stdout** alongside the success path (as the
final element of the JSON array, or the terminating `result` line on
the JSONL stream). Not all failure modes emit a result to stdout —
max-session-turns (exit 53) and signal interrupts (exit 130) exit with
stderr output only. Check the exit code first; `is_error` on the
result object disambiguates within the subset of failures that do
produce a result event.

> **Empty schema:** Passing `{}` produces `{}` (an empty JSON object)
> on stdout. The model calls `structured_output` with no arguments;
> the upstream argument-normalisation path turns the empty function
> call into an empty-object payload, which passes validation against
> the empty schema and is emitted verbatim.

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

> **Latency note:** Successful runs incur a shutdown holdback **capped
> at ~500 ms** while in-flight background agents flush their final
> notifications before the result is emitted. The holdback exits early
> if no background tasks are pending, so simple runs barely notice it;
> batch pipelines that fan out hundreds of `--json-schema` invocations
> against busy agents should account for this upper bound.

> **Security note:** Schemas may contain user-supplied regular
> expressions in `pattern` keywords. Ajv compiles these with the
> ECMAScript regex engine, which is vulnerable to catastrophic
> backtracking. Because tool arguments are always objects, the
> `pattern` keyword only fires inside string properties — a malicious
> schema like
> `{"type":"object","properties":{"value":{"type":"string","pattern":"(a+)+b"}}}`
> can hang the CLI when the model supplies a moderately long
> matching value. Only run `--json-schema` with schemas from sources
> you trust.

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
> { "$ref": "#/$defs/MyObj", "$defs": { "MyObj": { "type": "object", "properties": { "name": { "type": "string" } } } } }
>
> // Accepted (root accepts objects via the allOf branch):
> { "allOf": [{ "$ref": "#/$defs/MyObj" }], "$defs": { "MyObj": { "type": "object", "properties": { "name": { "type": "string" } } } } }
> ```
>
> `$ref` inside `anyOf` / `oneOf` / `allOf` is deferred to Ajv at
> runtime, so the wrapped form passes the root-acceptance check.

## Output shape per format

| `--output-format` | What goes to stdout                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text` (default)  | `JSON.stringify(payload) + "\n"` — one line, the validated object.                                                                                                                                                    |
| `json`            | A single JSON **array** of message objects (the full event log). The final element is the `type: "result"` message, which carries both `result` (`JSON.stringify(payload)`) and `structured_result` (the raw object). |
| `stream-json`     | Each event on its own line as JSONL. The terminating `result` line carries `result` (stringified) and `structured_result` (raw object).                                                                               |

In both JSON formats, prefer reading `structured_result` over `result`
when you want the object; `result` is the stringified form provided for
consumers that always expect a string in that field. For `--output-format
json`, read the last element of the array and pull `structured_result`
from there (e.g. `jq '.[-1].structured_result'`); for `stream-json`,
read the final `type: "result"` line on the stream.

## Restrictions

| Combination                                       | Behavior                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json-schema` + `-i` / `--prompt-interactive`   | Rejected at parse time. The synthetic tool's "session ends now" message has no terminator in the TUI loop.                                                                                                                   |
| `--json-schema` + `--input-format stream-json`    | Rejected at parse time. The single-shot terminal contract is incompatible with the long-lived stream-json input protocol.                                                                                                    |
| `--json-schema` + `--acp` / `--experimental-acp`  | Rejected at parse time. ACP runs its own turn loop that doesn't honor the synthetic-tool terminal contract.                                                                                                                  |
| `--json-schema` with no prompt and no piped stdin | Rejected at parse time. Headless mode needs a prompt — pass `-p`, a positional argument, or pipe one in.                                                                                                                     |
| `--bare` + `--json-schema`                        | Supported. The synthetic tool is registered alongside the bare three (`read_file`, `edit`, `run_shell_command`).                                                                                                             |
| `--json-schema` inside a subagent                 | Tool is NOT registered. Only the main / drain turns of the top-level run honor the terminal contract; a subagent calling the tool would receive "session ends now" and then keep running because its loop has no terminator. |

## Retry and failure modes

> **Cost note.** Two things multiply token spend in a `--json-schema`
> run, both worth designing for:
>
> - **Schema embedded in every turn.** The schema ships as the
>   `structured_output` function declaration's `parameters` block on
>   every model request, not just the first. Large schemas (up to the
>   4 MiB parse cap) proportionally increase per-turn input tokens
>   for the entire run.
> - **Each validation retry is a full model turn.** A schema the
>   model misses repeatedly is multiplied per failure (request +
>   inference + response). Keep schemas constrained enough to guide
>   the model and simple enough to nail on the first try; raise
>   `--max-session-turns` when retries are expected.

The session ends on the first valid call. Until then:

- **Args fail validation.** `structured_output` returns a tool-result
  error with Ajv's message, the model sees it on the next turn, and
  may correct the arguments and call again.
- **Model calls a side-effecting tool in the same turn as
  `structured_output`.** The pre-scan suppresses the sibling — it
  never runs, regardless of whether the structured call ultimately
  validates. The two paths split on what the model sees next:
  - **Validation succeeds:** the run ends immediately, and the model
    never gets another turn — the suppressed sibling is silently
    discarded.
  - **Validation fails:** the model gets another turn and sees a
    synthesised "Skipped:" `tool_result` for the suppressed call,
    so it can re-issue that call in a **separate turn** (one that
    does not include `structured_output`).
- **Model emits plain text instead of calling
  `structured_output`.** Exit code `1`. The error message includes
  the turn count and a truncated preview of the model's output so
  you can see what it actually said.
- **Run reaches `maxSessionTurns`.** Exit code `53`. Standard
  "Reached max session turns" exit, plus a `--json-schema`-specific
  hint that points at the three common stuck-run causes: model never
  called the tool, `structured_output` is denied by permission rules,
  or the schema is unsatisfiable.
- **Run is interrupted (SIGINT / Ctrl-C).** Exit code `130`. The
  structured result is normally not emitted, but the shutdown
  holdback loop does not poll the abort signal, so a SIGINT that
  arrives after a successful call has been captured but before the
  result reaches stdout may still land on stdout. Treat the exit
  code as the source of truth.

## Privacy

The args you submit through `structured_output` ARE the structured
payload — already emitted on stdout. To avoid persisting the same
payload a second time into on-device surfaces that may be exported off
the machine, args are redacted with the placeholder
`{ __redacted: 'structured_output payload (see stdout result)' }` on:

- The `ToolCallEvent` telemetry path (OTLP exports, QwenLogger,
  ui-telemetry stream, chat-recording UI event mirror).
- The on-disk chat-recording JSONL at
  `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` (re-fed
  into model context on `--continue` / `--resume`), including every
  validation-failure retry.

Tool-call metrics (duration, success, decision) and surrounding event
metadata are preserved.

> **Schema is sent to the model provider.** Redaction covers the
> _call arguments_ on local surfaces only. The schema itself rides
> on every model request as the `structured_output` function
> declaration's `parameters` block — so any literal values you put
> inside it (`enum`, `const`, `default`, `examples`, `description`,
> `$comment`, etc.) reach the provider in cleartext just like prompt
> text. Schemas should describe shape and constraints; treat them as
> public toward the provider and keep secrets, customer records, and
> other sensitive payloads out of the schema body.

> **Hooks see raw args.** The redaction described above only applies
> to telemetry and chat-recording. `PreToolUse`, `PostToolUse`, and
> `PostToolUseFailure` hooks (including HTTP hooks that can forward
> payloads off-device) receive the unredacted `tool_input` for
> `structured_output`, since the hook contract is "see what the tool
> sees." If you operate audit-style catch-all hooks, either disable
> them for `structured_output` (filter on `tool_name`) or add
> hook-side redaction before running `--json-schema` against
> sensitive data.

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

Explicit `permissions.deny` rules and `--exclude-tools` settings DO
take effect — both use the same deny mechanism and both prevent
`structured_output` from being registered, so the model never sees
the tool declaration. The typical result is that the model answers in
plain text (exit 1). If the model loops through other tools without
ever producing text, it will eventually hit `maxSessionTurns`
(exit 53) and the `--json-schema` hint in the error message tells you
where to look.

> **`--bare` caveat.** Bare mode ignores most settings-derived inputs,
> including settings-level `permissions.deny` and `tools.exclude`. The
> synthetic tool stays registered, so a settings-only deny of
> `structured_output` will silently no-op under `--bare`. Argv-level
> `--exclude-tools structured_output` still applies in bare mode — use
> the flag rather than settings if you need to lock down a bare run.

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
- [Dual Output](dual-output.md) — records a JSON-event sidecar
  alongside the TUI (a different approach to machine-readable output;
  does not require `--json-schema`).
