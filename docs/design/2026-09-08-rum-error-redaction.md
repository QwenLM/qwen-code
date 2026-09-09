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

## Chosen policy: pattern-masked error text, applied at the sink

The triage on #11198 names two candidate strategies — shape-based masking
(keep error text debuggable, never provably complete) and fingerprinting
(reduce to tool name + exit code + hash, cannot leak by construction, loses
diagnostic value). We choose masking, for three reasons:

1. The RUM feed's value is debugging aggregate failure patterns; a
   fingerprinted feed cannot answer "what were these API failures actually
   saying?".
2. The mask runs at the single choke point every event already passes
   through, so future call sites inherit it — closing the class, which is the
   issue's actual ask. Per-call-site redaction is how the gap kept reopening
   (#10916's `error_excerpt` was caught in review for the same reason).
3. Masking composes with the existing truncation bound: errors are also
   capped in length, which bounds how much of a missed shape can leave.

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
- `properties.error_message`
- `properties.error_excerpt` (pre-empting #10916's re-introduction)
- `stack` (defensive: nothing populates it today, but it is a free-text
  error surface a future call site could fill)

Non-error properties (model names, prompt ids, durations, counts) are
untouched. The pass is idempotent so a double-application is harmless, and
the retry path's re-queue only re-adds events that already passed through
`enqueueLogEvent`, so re-queueing cannot smuggle unredacted text either.

## Normalisation and the shared truncation bound

Control characters are stripped before masking (LF/CR preserved) so a C0/C1
character cannot sit between a secret key and its separator and split the
mask's match. Unlike the OTel path's `stripAnsiAndControl`, newlines
survive: the RUM feed's diagnostic value is the shape of the multi-line
error block, which flattening would destroy.

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
not modified — the sink is the single enforcement point.
