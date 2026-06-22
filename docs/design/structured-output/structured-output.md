# Structured Output (`--json-schema`) — Design

This document captures the implementation decisions behind the
`--json-schema` headless feature. User-facing usage lives in
[`docs/users/features/structured-output.md`](../../users/features/structured-output.md).

## Goal

In headless runs (`qwen -p`, piped stdin, or positional prompt), let
the caller constrain the model's final answer to a user-supplied JSON
Schema and surface the validated payload as machine-readable output
that scripts and downstream tooling can consume directly. The model's
incidental prose during planning is allowed, but the run must
terminate with a payload that conforms to the schema, not with
free-form text.

## Approach: synthetic tool whose parameter schema IS the user schema

When `--json-schema` is set, `Config.createToolRegistry` registers a
synthetic `structured_output` tool
([`syntheticOutput.ts`](../../../packages/core/src/tools/syntheticOutput.ts)).
Its `parametersJsonSchema` is exactly the schema the user passed; its
`execute()` returns a stop-message `llmContent`. The tool-call
infrastructure already validates args against `parametersJsonSchema`
client-side (via Ajv in `BaseDeclarativeTool.build()`), so "the model
returned an answer conforming to the schema" reduces to "the model
successfully called `structured_output`."

Three properties fall out of this for free:

1. **No bespoke validator path.** Ajv-backed `validateToolParams`
   already runs inside `BaseDeclarativeTool.build()` and rejects
   non-conforming args before `execute()` ever fires.
2. **Standard retry behavior.** A validation failure surfaces to the
   model as a tool-call error the same way any other tool's args error
   does. The model sees the Ajv message and can correct in the next
   turn.
3. **Provider-agnostic.** Gemini, OpenAI, and Anthropic all serialize
   tool param schemas the same way (via the `DeclarativeTool`
   abstraction); the synthetic tool plugs into all three.

The tool is registered with `alwaysLoad: true` so the ToolSearch
on-demand-loading infrastructure (introduced in #3589 — keeps the
exposed tool surface small by deferring rarely-used tools behind a
search call, only mounting their full schemas when the model asks)
never hides it from the model. Without that flag, the model wouldn't
know the terminal contract exists.

## Parse-time validation pipeline

`resolveJsonSchemaArg(raw)` in
[`packages/cli/src/config/config.ts`](../../../packages/cli/src/config/config.ts)
runs four checks before the schema reaches `Config.createToolRegistry`:

1. **Source resolution.** Accept either an inline JSON literal or
   `@path/to/file`. The `@path` form `stat`s the resolved path first,
   refuses non-regular files (FIFOs, character devices, directories),
   caps size at 4 MiB, and on JSON parse failure emits a generic error
   (no file-content prefix in stderr).
2. **JSON shape.** Parsed result must be a non-array object —
   primitives, booleans, and arrays are rejected with a clear
   message.
3. **Root accepts objects** —
   [`schemaRootAcceptsObject`](../../../packages/cli/src/config/config.ts).
   Function-calling APIs always pass objects as tool args; a root
   schema like `{type: "array"}` would register an unusable tool.
   The walk handles `type`, `const`, `enum`, `anyOf`, `oneOf`,
   `allOf`, `not`, `if` / `then` / `else`, and root `$ref`.
4. **Strict Ajv compile** —
   [`SchemaValidator.compileStrict`](../../../packages/core/src/utils/schemaValidator.ts).
   A dedicated Ajv instance with `strictSchema: true` surfaces
   typos like `propertees` that the lenient runtime validator would
   silently swallow.

### `schemaRootAcceptsObject` boundaries

The walk is intentionally best-effort. It catches the unambiguous
"this can never accept an object" cases, and defers anything that
needs whole-schema satisfiability analysis to Ajv at runtime.

**Decided at parse time:**

| Pattern                                                | Outcome                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `type` present, doesn't include `"object"`             | reject                                                            |
| `type: ["object", "null"]` etc.                        | accept                                                            |
| `const`: non-object value                              | reject                                                            |
| `enum`: no object members (incl. empty)                | reject                                                            |
| `anyOf`/`oneOf`: empty array                           | reject                                                            |
| `anyOf`/`oneOf`: no branch admits object               | reject                                                            |
| `allOf`: any branch is `false` or rejects object       | reject                                                            |
| Root `$ref` (with or without sibling `type`)           | reject                                                            |
| `not`: bare `{type: "object"}` (no narrowing keywords) | reject                                                            |
| `not`: `{type: "object", required: […], …}` etc.       | accept (narrowing keywords leave some objects satisfiable; defer) |
| `if: true` + `then` rejects object                     | reject                                                            |
| `if: false` + `else` rejects object                    | reject                                                            |

**Deferred to Ajv at runtime:**

- `$ref` inside `anyOf` / `oneOf` / `allOf` branches (opaque — local
  `$ref` resolution would need cycle detection, JSON Pointer escapes,
  and `$defs` vs `definitions` handling; the cost outweighs the
  benefit for a parse-time best-effort check).
- `if` whose value is an object schema (decidable only against a
  candidate value).
- Negated `anyOf` / `oneOf` / `const` patterns more complex than
  `not.type`.
- Arbitrary `pattern` ReDoS exposure (user-supplied; the threat model
  is narrow because the flag is a CLI argument, not a network input).

The `maxSessionTurns` exit path appends a `--json-schema`-specific
hint pointing users at the common stuck-run symptom (model never
called `structured_output`) and its two likely causes (tool denied
via permissions / schema unsatisfiable) so the runtime fallthrough
has user-visible diagnostics.

## Runtime: turn dispatch

[`packages/cli/src/nonInteractiveCli.ts`](../../../packages/cli/src/nonInteractiveCli.ts)
handles the runtime dispatch. The structured-output specifics:

### Pre-scan + sibling suppression

When the model emits `structured_output` alongside other tools in the
same assistant turn, the synthetic call is the terminal contract. The
pre-scan in `processToolCallBatch` filters `requestsToExecute` to
**only** `structured_output` calls, so side-effecting siblings
(`write_file`, `run_shell_command`, `edit`, …) never run.

Example batches (when `--json-schema` is active):

| Model emits                                              | Behavior                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[write_file(…), structured_output(…)]`                  | `write_file` is skipped. `structured_output` validates, run ends.                                                                                                                                                                                                                                                |
| `[structured_output(bad-args), structured_output(good)]` | First fails Ajv validation; second succeeds. Run ends with the second call's args.                                                                                                                                                                                                                               |
| `[structured_output(bad-args), write_file(…)]`           | `structured_output(bad)` fails. `write_file` is also skipped (it was suppressed up front). The model sees both: Ajv's error message for the structured call, and a synthesised `"Skipped: …"` tool_result for the side-effect call. Next turn, the model may re-issue both or correct the structured call alone. |
| `[other_tool_a, other_tool_b]` (no `structured_output`)  | Pre-scan is inert. Both tools run normally; the run does NOT terminate.                                                                                                                                                                                                                                          |

The synthesised "Skipped:" body has two variants:

- **Success path** (a structured call captured the contract this turn):
  `"Skipped: this turn's structured_output contract took precedence as
the terminal output."` — short, because the session terminates
  immediately and no consumer (model or SDK) acts on it.
- **Retry path** (no structured call captured, the model gets another
  turn): adds `"Re-issue this call in a separate turn if needed."` —
  this is the only model-actionable case.

### Main-turn / drain-turn parity

`processToolCallBatch(batchRequests, setModelOverride)` is defined
inside `runNonInteractive` and called from both:

- The main-turn loop (top of the function).
- `drainOneItem` (cron-prompt / background-task notification reply
  loop).

The drain turn matters because `structured_output` is registered for
the whole session, so a cron job or a notification reply MIGHT also
fire the tool. The helper handles both call sites identically at
invocation time; the only call-site-specific binding is which
`modelOverride` variable to write to — passed in as a setter.

The **post-helper termination flow** differs between the two sites:
the main-turn path directly calls `return emitStructuredSuccess()`,
while the drain-turn path requires a two-hop termination
(`processToolCallBatch` captures the result into the closure-scoped
`structuredSubmission`; `drainLocalQueue` checks it to stop the drain
loop, then the holdback loop checks it to break out and call
`emitStructuredSuccess`). Both converge on the same terminal block,
but the extra indirection in the drain path is load-bearing —
without it the drain loop would continue processing queued items
after the structured result was captured.

### Structured success terminal block

`emitStructuredSuccess()` (also defined inside `runNonInteractive`) is
the shared "we got a valid call, shut down" path:

1. `registry.abortAll()` aborts in-flight background agents — the
   structured-output contract is single-shot and shouldn't race
   `task_notification`s into the terminal emit.
2. Bounded holdback (`STRUCTURED_SHUTDOWN_HOLDBACK_MS = 500` ms) so
   the natural cancel handlers of just-aborted agents have a chance
   to emit their terminal `task_notification` and land it in
   `localQueue`. The loop guard is
   `Date.now() < deadline && registry.hasUnfinalizedTasks()`, so the
   wait exits immediately when nothing is in flight (typical path)
   and never blocks longer than the cap. The 500 ms ceiling is
   best-effort — orphaned `task_started` events remain possible under
   load if a particular agent's abort handler exceeds the budget.
   The loop does **not** poll the abort signal: a SIGINT received
   during holdback or during the emit path that follows will not
   short-circuit the result that was already captured. Without the
   holdback, stream-json consumers would routinely see `task_started`
   events without matching `task_notification`.
3. `flushQueuedNotificationsToSdk(localQueue)` drains everything still
   queued.
4. `finalizeOneShotMonitors()` (idempotent — safe to call twice; the
   drain-turn path already invoked it).
5. `adapter.emitResult({ structuredResult: …, isError: false, … })`.

### Failure paths

| Cause                                                             | Exit code                     | Surface                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model emits plain text only                                       | 1                             | Error with turn count + truncated `Output preview`.                                                                                                                                                                                                                                |
| Model never calls `structured_output` for `maxSessionTurns` turns | 53                            | `Reached max session turns` + `--json-schema` hint pointing at the common stuck-run symptom and its two likely causes.                                                                                                                                                             |
| Validation fails repeatedly                                       | (eventually 53 via max-turns) | Each failure surfaces to the model on the next turn with the Ajv message.                                                                                                                                                                                                          |
| Abort / SIGINT                                                    | 130                           | Cancellation path. A structured result is normally not emitted, but `emitStructuredSuccess()`'s holdback loop does not poll the abort signal — a SIGINT that arrives after capture but before/during the stdout emit may still flush the result. Exit code is the reliable signal. |

## Output envelope

The adapter pipeline in
[`BaseJsonOutputAdapter.buildResultMessage`](../../../packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts)
treats the presence of `structuredResult` (tracked via `'structuredResult' in options`,
not `!== undefined`, so the contract is preserved even when the model
called `structured_output` with no args under an empty schema):

- `result` is forced to `JSON.stringify(payload)` — overriding any
  free-text summary the adapter accumulated.
- A top-level `structured_result` field carries the raw object for
  consumers that don't want to re-parse the stringified form.
- `undefined` payloads normalize to `null` (rendered as the literal
  JSON `null` in both fields) so the field can't silently disappear.
  In practice this fallback is rarely reached: upstream, `turn.ts`
  applies `(fnCall.args || {})` before storing the submission, so a
  zero-arg call against an empty schema lands as `{}` and renders as
  `{}` on stdout, not `null`. The `?? null` step is defence-in-depth
  for the strictly-undefined case.

TEXT mode writes just the `result` field + newline to stdout (any
incidental assistant prose accumulated during the run is discarded —
not mirrored to stderr). JSON mode emits the full event log as a
JSON array; `structured_result` lives on the final `type: "result"`
element of that array, not at the document root. Stream-json mode
emits each message on its own line as JSONL; the terminating `result`
line carries `structured_result`.

## Privacy: cross-surface redaction

The args submitted via `structured_output` ARE the structured payload.
On the success path they're already on stdout; on validation-failure
retries they may never reach stdout at all. Either way, persisting
them on durable on-device surfaces (or exporting them off-device
through telemetry) is duplication that leaks the payload into
longer-lived storage than the user asked for. The redaction rule is
therefore "never persist any args from this synthetic tool, regardless
of outcome," not just "dedup what's already on stdout."

Two surfaces have to redact, and both share the same placeholder
constant
[`STRUCTURED_OUTPUT_REDACTED_ARGS`](../../../packages/core/src/tools/syntheticOutput.ts):

- `ToolCallEvent.function_args` (telemetry) — covers OTLP exports,
  QwenLogger, ui-telemetry, and the chat-recording UI event mirror.
- `redactStructuredOutputArgsForRecording` (used by
  `recordAssistantTurn` in `geminiChat.ts`) — covers the on-disk
  chat-recording JSONL at
  `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`.
  Validation-failure retries land here too — each retry's args also
  get the same placeholder.

The shared constant prevents drift between the two surfaces. Tool-call
metrics (duration, success, decision) are preserved.

Hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) are
intentionally **not** redacted — they receive the raw `tool_input`
because the hook contract is "see what the tool sees." This is
documented in the user-doc Privacy section as a "Hooks see raw args"
callout so operators can filter on `tool_name` or add hook-side
redaction before running `--json-schema` against sensitive data.

The redaction is intentionally scoped to **on-device** persistence
surfaces (telemetry exports + chat-recording JSONL). The schema
itself still travels to the model provider on every request as the
`structured_output` function declaration's `parameters` block — no
provider-side redaction is possible, since the model needs the
schema to satisfy the tool-call contract. The user-doc Privacy
section warns users to keep `enum` / `const` / `default` /
`examples` / `description` payloads free of secrets for the same
reason.

## Permission gating

`structured_output` is deliberately excluded from
`PermissionManager.CORE_TOOLS` (the set of tools subject to the
`--core-tools` allowlist check) — alongside the other synthetic
tools (`agent`, `exit_plan_mode`, `ask_user_question`, `task_stop`,
`send_message`). Dynamically discovered tools (`skill`, MCP) are a
separate exclusion category that also bypasses the allowlist for
unrelated reasons. The synthetic tool only exists when `--json-schema`
is set; adding it to the allowlist machinery would mean
`--core-tools read_file --json-schema X` silently drops the terminal
contract.

Explicit `permissions.deny` rules and `--exclude-tools` settings still
apply via `PermissionManager.evaluate` → `isToolEnabled`. Both use
the same deny mechanism and both prevent registration — the tool
declaration is stripped from the registry, so the model never sees
the tool. The typical outcome is that the model answers in plain text
(exit 1). If the model loops through other tools without producing
text, it eventually hits `maxSessionTurns` (exit 53) and the
`--json-schema` hint in `handleMaxTurnsExceededError` tells the user
where to look.

**`--bare` interaction.** Bare mode short-circuits the settings → CLI
config bridge: `packages/cli/src/config/config.ts` builds
`mergedDeny` as `[...(bareMode ? [] : settings.permissions.deny), ...]`,
so settings-level denies (and `tools.exclude`) are dropped under
`--bare`. Argv-level `--exclude-tools` is unconditionally appended
into `mergedDeny`, so it still applies. The synthetic tool is
registered independently of all this (driven by `jsonSchema`, not by
the deny list), so a settings-only deny of `structured_output`
silently no-ops under `--bare` while the tool remains callable.

## Subagent contexts

`Config.createToolRegistry` accepts a `forSubAgent: true` option that
suppresses the synthetic registration. Subagent overrides reuse the
parent Config via prototype delegation (`createApprovalModeOverride` /
`buildSubagentContextOverride` → `Object.create(base)`), and
`this.jsonSchema` propagates through the prototype chain. Without the
flag, the synthetic tool would register in the subagent's registry
too, and a subagent calling it would receive the "session ends now"
llmContent — but only `runNonInteractive`'s main / drain loops detect
that as terminal, so the subagent would keep running and burn tokens
on a tool whose contract its loop can't honor.

> **Maintainer note.** This suppression hangs on the single call path
> through `createToolRegistry(forSubAgent: true)`. Any future subagent
> spawn mechanism that bypasses this path will leak the synthetic
> tool into the subagent's registry and reintroduce the
> burn-tokens-forever failure mode. The fail-safe complement would be
> a runtime guard inside `syntheticOutput.execute()` that returns a
> `fatalError` (or no-op) when invoked from a subagent context. Land
> one if a second leak path appears.

## MCP shadow-tool guard

`tool-registry.ts:registerTool` checks the lazy `factories` map for
name collisions, not just the eager `tools` map. If an MCP server
discovers a tool literally named `structured_output`, the
auto-qualification path that exists for eager-tool collisions fires
for factory collisions too: the MCP tool gets renamed to
`mcp__<server>__structured_output` and the synthetic factory keeps
the bare name. Without this guard, an MCP server could silently hijack
the structured-output contract.

## Compatibility surface

| Combination                                              | Status                 | Rationale                                                                                                                                 |
| -------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--json-schema` + `-p` (or stdin, or positional)         | Supported              | Primary headless path.                                                                                                                    |
| `--json-schema` + `--output-format text` (default)       | Supported              | `JSON.stringify(payload)` + newline.                                                                                                      |
| `--json-schema` + `--output-format json` / `stream-json` | Supported              | `structured_result` field carries the raw object.                                                                                         |
| `--json-schema` + `--bare`                               | Supported              | `--bare` restricts the registry to `read_file`, `edit`, `run_shell_command`; the synthetic tool is registered alongside that minimal set. |
| `--json-schema` + `-i`                                   | Rejected at parse time | TUI has no terminal contract for the synthetic tool.                                                                                      |
| `--json-schema` + `--input-format stream-json`           | Rejected at parse time | Single-shot contract vs. long-lived protocol.                                                                                             |
| `--json-schema` + `--acp` / `--experimental-acp`         | Rejected at parse time | ACP loop is independent.                                                                                                                  |
| `--json-schema` + `--prompt-interactive`                 | Rejected at parse time | Same as `-i`.                                                                                                                             |
| `--json-schema` + no prompt + no piped stdin             | Rejected at parse time | Headless requires a prompt.                                                                                                               |

## Alternatives considered

**Schema-aware response prompting (no synthetic tool).** Asking the
model to "respond with JSON matching this schema" via the system
prompt and parsing the final assistant message instead. Rejected
because the model has no syntactic guarantee — the output might be
fenced, prefixed with chatter, or hallucinate fields. Tool-call
validation is enforced by the function-calling layer before
`execute()`, which gives us a hard syntactic + semantic guard.

**OpenAI's `response_format: {type: "json_schema", …}`.** Provider-
specific; would require parallel implementations for Gemini and
Anthropic. The synthetic-tool approach is provider-agnostic.

**Reorder structured_output to the front of the batch instead of
filtering.** Lets side-effecting siblings run if the structured call
fails validation. Rejected because the contract for `--json-schema` is
"produce structured output" — if the model is in this mode, sibling
side-effects are probably a mistake. Suppressing them entirely is
safer; the model sees a "Skipped:" tool_result and can re-issue them
in a separate turn.

**Local `$ref` resolution inside `schemaRootAcceptsObject`.** Would
catch schemas like `{anyOf: [{$ref: "#/$defs/String"}], $defs: {…}}`
at parse time. Rejected for now because the cost (cycle detection,
JSON Pointer syntax, `$defs` vs `definitions`, partial pointers,
remote refs) outweighs the benefit; the `maxSessionTurns` hint already
points users at "schema is unsatisfiable" as a likely cause.

## Open work

- Schema-aware response validation could grow a `pattern`-based
  ReDoS guard if real users hit catastrophic-backtracking patterns
  in `--json-schema` arguments.
- SDK protocol additions (Python / TypeScript / Java SDKs exposing a
  typed `structured_result` field) — track separately;
  [PR #4001](https://github.com/QwenLM/qwen-code/pull/4001) (closed
  unmerged on 2026-05-11) covered that scope before the cli/core work
  landed and was superseded.

## File index

- `packages/cli/src/config/config.ts` — `resolveJsonSchemaArg`,
  `schemaRootAcceptsObject`, yargs `.check` mutex rules.
- `packages/cli/src/gemini.tsx` — TUI guard, exit-code plumbing.
- `packages/cli/src/nonInteractiveCli.ts` —
  `processToolCallBatch`, `emitStructuredSuccess`,
  `suppressedOutputBody`, plain-text failure path.
- `packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts` —
  `structuredResult` → `result` + `structured_result` envelope.
- `packages/core/src/config/config.ts` — registration with
  `registerStructuredOutputIfRequested`, `forSubAgent` skip.
- `packages/core/src/tools/syntheticOutput.ts` — synthetic tool +
  `STRUCTURED_OUTPUT_REDACTED_ARGS` placeholder.
- `packages/core/src/tools/tool-registry.ts` — factory-collision
  rename for MCP shadow tools.
- `packages/core/src/telemetry/types.ts` — `function_args` redaction.
- `packages/core/src/core/geminiChat.ts` —
  `redactStructuredOutputArgsForRecording`.
- `packages/core/src/utils/schemaValidator.ts` — `compileStrict`
  with strict Ajv instance.
- `packages/cli/src/utils/errors.ts` —
  `handleMaxTurnsExceededError`'s `--json-schema` hint.
