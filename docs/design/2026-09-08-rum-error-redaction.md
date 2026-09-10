# Design: Redact error text at the RUM sink (usage-statistics channel)

Issue: [#11198](https://github.com/QwenLM/qwen-code/issues/11198)

## Problem

The default-on usage-statistics channel uploads raw tool-error text to the
RUM endpoint with no redaction. The widest single source is the shell tool:
on signal/exit failures the model-facing error block starts with
`Command: <full command line>`, becomes `ToolCallEvent.error`, survives
normalization, and is uploaded verbatim as `properties.error_message`. A
failed `git clone https://x-access-token:...@github.com/...` or a
`curl -H "Authorization: Bearer ..."` uploads its credential inline. The same
sink ships raw error text through `api_error` (`message` +
`properties.error_message`), `invalid_chunk` (`message`), `auth`
(`properties.error_message`), and `ripgrep_fallback`
(`properties.error_message`).

## Non-goals

- Changing the OTel span path — `truncateSpanError` already redacts it.
- Changing what the model or the user sees in the transcript. Error text used
  for the conversation flow is untouched; only the RUM payload is sanitized.
- Re-sizing what telemetry is collected — same events, same fields, redacted
  values.
- Exhaustive coverage of every secret _spelling_. Pattern masking is
  best-effort by construction: the entrances of free-form text cannot be
  enumerated (quoted/lowercase env keys, URL query parameters, JSON/YAML
  bodies, tool-specific syntax such as `curl -u` or `docker login -p`,
  secrets echoed in command _output_, …). The spelling-based patterns mask
  the shapes observed in this repo's error text; the exact-value mask (below)
  is the half that is closed by construction. This residual gap is why the
  triage's fingerprinting option remains the fail-closed alternative if
  maintainers later want a provable bound, and the triage's middle ground
  (mask known shapes on the first line, drop everything after it) is a
  possible follow-up.

## Chosen policy: pattern-masked error text + exact-value masking for

process-held secrets, applied at the sink

The triage on #11198 names two candidate strategies — shape-based masking
(keep error text debuggable, never provably complete) and fingerprinting
(reduce to tool name + exit code + hash, cannot leak by construction, loses
diagnostic value). We choose masking, complemented by exact-value masking
for the secrets the process itself holds, for three reasons:

1. The RUM feed's value is debugging aggregate failure patterns; a
   fingerprinted feed cannot answer "what were these API failures actually
   saying?".
2. The mask runs at the single choke point every event already passes
   through, so future call sites inherit it, which is the issue's actual
   ask. Per-call-site redaction is how the gap kept reopening (#10916's
   `error_excerpt` was caught in review for the same reason). Note this
   closes the _entrance_ problem (new fields at the sink), not the _shape_
   problem — see the Non-goal above.
3. Masking composes with the existing truncation bound: errors are also
   capped in length, which bounds how much of a missed shape can leave.

Secrets the process holds at runtime (the content-generator API key, MCP
server header values) are additionally masked **by exact value** wherever
they appear in queued error text. Value matching is closed by construction
— it does not depend on spelling — so a process-held credential reaches
the RUM payload in no shape at all. The values are re-registered on every
`enqueueLogEvent` so mid-session credential refreshes are covered, and
values shorter than a trivial floor are skipped so a placeholder cannot
censor ordinary text.

The mask set (each proven pattern already has precedent in this repo or is a
direct generalization of one):

| Shape                                                               | Example                                                  | Replacement          |
| ------------------------------------------------------------------- | -------------------------------------------------------- | -------------------- |
| URL userinfo (existing `redactUrlCredentials`)                      | `https://token@host/…`                                   | `https://***@host/…` |
| `upload:v1:` identity tokens (existing)                             | `upload:v1:<uuid>:…`                                     | `upload:…`           |
| Authorization headers                                               | `Authorization: Bearer xyz` / `-H "Authorization: …"`    | `Authorization: ***` |
| `key=value` flags where the key looks like a secret                 | `--api-key=xyz`, `--token=xyz`, `-H "X-Auth-Token: xyz"` | `<flag>=***`         |
| `KEY=value` env-style assignments where the key looks like a secret | `AWS_SECRET_ACCESS_KEY=xyz`, `API_KEY=xyz`               | `KEY=***`            |
| Bearer tokens outside headers                                       | `Bearer eyJ…`                                            | `Bearer ***`         |

"Looks like a secret" is a conservative key-name match (`password`, `token`,
`secret`, `api_key`/`apikey`, `access_key`, `auth`, `credential`,
`private_key`, `session_key`) in flag, env, and header positions — not a
content heuristic. False positives cost a redacted flag value in telemetry
only; false negatives are bounded by truncation.

## Where the mask runs: `enqueueLogEvent`

All ~50 `log*Event` methods funnel through `enqueueLogEvent`
(`qwen-logger.ts:182`), and all `create*Event` helpers funnel through
`createRumEvent`. The pass runs in `enqueueLogEvent` over the known
error-text fields of the `RumEvent`:

- `message` (top level, `RumExceptionEvent`/`RumResourceEvent`)
- `properties.error` (hook error text — `logHookCallEvent` embeds the full
  hook command line / URL here when prompt logging is on, which is the
  default)
- `properties.error_message`
- `properties.error_excerpt` (pre-empting #10916's re-introduction)
- `stack` (defensive: nothing populates it today, but it is a free-text
  error surface a future call site could fill)

Non-error properties (model names, prompt ids, durations, counts) are
untouched. The pass is idempotent so a double-application is harmless, and
the retry path's re-queue only re-adds events that already passed through
`enqueueLogEvent`, so re-queueing cannot smuggle unredacted text either.

## Normalisation and the shared truncation bound

ANSI/VT escape sequences are removed first (`stripVTControlCharacters`,
newlines preserved), then every remaining C0/C1 control character (except
LF/CR) is replaced with a **space** — not deleted — so a control character
cannot sit between a secret key and its separator and split the mask's
match, and cannot fuse a key and value into one token (`--token<TAB>value`)
or glue a word character onto a key and defeat the mask either. Unlike the
OTel path's `stripAnsiAndControl`, newlines survive: the RUM feed's
diagnostic value is the shape of the multi-line error block, which
flattening would destroy. A shell line-continuation marker before a value
(`--token=\<newline> value`) is skipped by the value group so the mask
binds to the credential on the continuation line.

The truncation bound and its surrogate-pair guard are shared with the OTel
span path through `truncateErrorText` (exported from `session-tracing.ts`,
used by both paths) — one definition of the bound, two sinks. The
normalisation deliberately differs (newlines survive here), so "parity"
means the bound and the credential redaction, not byte-identical output
with the OTel copy.

Two free-form surfaces the choke point does not reach are recorded as known
limits: `snapshots` (numeric everywhere except two event types today) and
the payload-level `base_url` (assembled outside `enqueueLogEvent`). Neither
carries a shell command line today.

## Where the mask lives

`packages/core/src/telemetry/sanitize.ts` grows a
`redactErrorText(value: string): string` helper beside `sanitizeHookName`,
composing `redactUrlCredentials` with the new patterns and the shared
truncation. Keeping it in `telemetry/` (rather than `extension/redaction.ts`)
keeps the generalization next to its telemetry consumers; `extension/redaction.ts`
stays as-is because its URL-focused contract is load-bearing for extension
source strings.

## Testing

Unit tests on `redactErrorText` for every shape in the table above, plus
idempotence and a no-op check on non-matching text. Unit tests on
`QwenLogger.enqueueLogEvent` asserting the exact leaked example from the
issue (`git clone https://x-access-token:ghs_...@...`) arrives masked, and
that a non-error field passes through unchanged. Existing
`qwen-logger.test.ts` coverage keeps guarding the queue behavior.

## Downstream consumers

`enqueueLogEvent` is private to `QwenLogger`; its only consumer is the
internal flush path building the RUM payload. No public API change. The
shell tool, `ToolCallEvent`, and `normalizeToolCallEvent` are deliberately
not modified — the sink is the single enforcement point for error-text
_fields_; `createRumPayload`'s payload-level `base_url` is the one
free-form surface assembled outside it (recorded as a known limit above).
