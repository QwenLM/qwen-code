/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactUrlCredentials } from '../extension/redaction.js';
import { SPAN_TEXT_MAX_CHARS, truncateErrorText } from './session-tracing.js';

/**
 * Sanitize hook name to remove potentially sensitive information.
 * Extracts the base command name without arguments or full paths.
 *
 * This function protects PII by removing:
 * - Full file paths that may contain usernames
 * - Command arguments that may contain credentials, API keys, tokens
 * - Environment variables with sensitive values
 *
 * Examples:
 * - "/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123" -> "check-secrets.sh"
 * - "python /home/user/script.py --token=xyz" -> "python"
 * - "node index.js" -> "node"
 * - "C:\\Windows\\System32\\cmd.exe /c secret.bat" -> "cmd.exe"
 * - "" or "   " -> "unknown-command"
 *
 * @param hookName Full command string.
 * @returns Sanitized command name.
 */
export function sanitizeHookName(hookName: string): string {
  // Handle empty or whitespace-only strings
  if (!hookName || !hookName.trim()) {
    return 'unknown-command';
  }

  // Split by spaces to get command parts
  const parts = hookName.trim().split(/\s+/);
  if (parts.length === 0) {
    return 'unknown-command';
  }

  // Get the first part (the command)
  const command = parts[0];
  if (!command) {
    return 'unknown-command';
  }

  // If it's a path, extract just the basename
  if (command.includes('/') || command.includes('\\')) {
    const pathParts = command.split(/[/\\]/);
    const basename = pathParts[pathParts.length - 1];
    return basename || 'unknown-command';
  }

  return command;
}

// C0/C1 control chars (incl. DEL) except LF and CR — the multi-line shell
// error block is load-bearing in telemetry, so newlines survive, unlike
// `stripAnsiAndControl` which flattens them. `stripVTControlCharacters`
// already removed ANSI/VT sequences (newlines preserved) before this runs.
// Each control char is replaced with a SPACE, not deleted: deletion fuses
// key and value into one token (`--token<TAB>value` -> `--tokenvalue`) or
// glues a word char onto the key and defeats the mask either way.
const CONTROL_CHARS_EXCEPT_NEWLINES_RE =
  // eslint-disable-next-line no-control-regex -- C0/C1 stripping is the point
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

// VT/ANSI escape sequences are neutralised, not blindly deleted (Node's
// stripVTControlCharacters deletes them): deletion re-creates the key/value
// fusion the space substitution below exists to prevent — an SGR sequence
// sitting between a flag and its value fuses them into one token and the
// credential ships. A run that is the ONLY separator between two
// non-whitespace chars becomes a space; any other run (adjacent to existing
// whitespace or at an edge) is deleted, so ANSI-wrapped diagnostics keep
// their exact spacing. Handling runs here instead of delegating also stops
// an incomplete CSI sequence from eating the first char of a following
// secret as its final byte.
const VT_SEQUENCE_RUN =
  '(?:\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\))+';
const VT_SEPARATOR_RUN_RE = new RegExp(
  `(?<=\\S)${VT_SEQUENCE_RUN}(?=\\S)`,
  'g',
);
const VT_ANY_RUN_RE = new RegExp(VT_SEQUENCE_RUN, 'g');

// The widest hostile producer (the MCP tool-error builder) JSON-stringifies
// response parts, so a quote reaches this pass as `\"` and a newline as the
// two characters `\n`. Unescaping the two-character JSON escapes in
// normalisation lets every mask pass see one text shape instead of a value
// tokeniser that stops at the backslash of an escaped quote.
const JSON_ESCAPE_RE = /\\([nrt"'\\])/g;

const SECRET_KEY_PATTERN =
  '(?:password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key|session[_-]?key)';

// Value alternative shared by all mask positions: a shell line-continuation
// marker (`\`, `^` or a backtick before a newline) is skipped so the value
// group binds to the credential on the continuation line, not the marker;
// then an optionally-unterminated quoted run, or a bare run that never
// starts with a dash, so an empty value cannot eat the next flag's name
// (R1-18). The quoted run is whitespace-bounded so an unclosed quote
// cannot swallow the rest of the line's diagnostics.
const CONTINUATION_PREFIX = '(?:[\\\\^`][ \\t]*\\r?\\n[ \\t]*)?';
// A fully closed quoted run is preferred over the whitespace-bounded
// fallbacks so a quoted secret *containing spaces* is masked whole
// (`--password="my pass phrase"`); an unclosed quote still falls through
// to the whitespace-bounded branch and cannot swallow the line's
// diagnostics.
const VALUE_ALT = `${CONTINUATION_PREFIX}("[^"]*"|'[^']*'|"[^\\s"]*"?|'[^\\s']*'?|(?!-)[^\\s"']+)`;

// `--token=xyz`, `--api-key xyz`, `X-Auth-Token: abc` — a dashed or
// hyphenated key containing a secret-like word, followed by a value. Key
// runs are bounded (`{0,64}`) to keep backtracking linear on adversarial
// dash-dense input (measured: 632.9s → ~0.1s at the 28k-char scheduler
// gate). Inline separators (`=`, `:`) trust any key spelling; a
// space-separated value is only trusted for `--long-flag` keys, so prose
// like "the auth-token is expired" keeps its next word.
const SECRET_FLAG_INLINE_PATTERN = new RegExp(
  `(--?[a-z0-9_-]{0,64}${SECRET_KEY_PATTERN}[a-z0-9_-]{0,64})(\\s*[=:]\\s*)${VALUE_ALT}`,
  'gi',
);
const SECRET_FLAG_SPACED_PATTERN = new RegExp(
  `(--[a-z0-9_-]{0,64}${SECRET_KEY_PATTERN}[a-z0-9_-]{0,64})(\\s+)${VALUE_ALT}`,
  'gi',
);

// `AWS_SECRET_ACCESS_KEY=xyz`, `API_KEY=xyz`. Uppercase-only and not
// case-insensitive by design: `\w=` collisions in ordinary prose are
// lowercase, and mixed-case secret keys (`Password=`) are a recorded
// residual gap rather than a mask-everything heuristic. No `\b` anchor:
// the key class itself delimits the match, and a preceding word character
// (`prefix_mKEY=`) must not defeat the mask.
const SECRET_ENV_PATTERN = new RegExp(
  `([A-Z0-9_]{0,64}${SECRET_KEY_PATTERN.toUpperCase()}[A-Z0-9_]{0,64})=${VALUE_ALT}`,
  'g',
);

// `Authorization: Bearer xyz` / `Authorization=xyz` — the header name alone
// is the secret-like key, so everything after the separator is masked. The
// value position skips an optional scheme word (Bearer, Basic, Digest,
// token, …) rather than swallowing it as the value; the scheme word may be
// followed by one folded newline (agent-authored curl commands wrap inside
// the quoted -H argument), but never into a continuation line that is
// itself a `Name:` header — that is the next key's position, not a value.
const AUTHORIZATION_HEADER_PATTERN = new RegExp(
  `(authorization\\s*[:=]\\s*)(?:(?:bearer|basic|digest|token|negotiate|ntlm|apikey|oauth|sso)[^\\S\\n]*(?:\\r?\\n[ \\t]*(?![a-z0-9_.-]+\\s*:))?)?${VALUE_ALT}`,
  'gi',
);

// `bearer token: <jwt>` / `bearer <jwt>` — the prose label is kept, the
// credential after it is masked. No `\b` anchor (see SECRET_ENV_PATTERN).
// The label may span one folded newline, mirroring the Authorization
// pattern, so a wrapped `bearer\ntoken: <jwt>` is not left unmasked.
const BEARER_TOKEN_PATTERN = new RegExp(
  `(bearer(?:[^\\S\\n]+|\\r?\\n[ \\t]*))(token\\s*[:=]?\\s*)?${VALUE_ALT}`,
  'gi',
);

// Secrets the process itself holds, masked by exact value wherever they
// appear — closed by construction, unlike the spelling-based patterns
// above. Registered by the logger once per session (see
// `registerKnownSecretValues`); values shorter than a trivial floor are
// skipped so a placeholder like "oauth" cannot censor ordinary text.
const MASK = '***';
const MIN_SECRET_VALUE_LENGTH = 8;
const knownSecretValues = new Set<string>();

export function registerKnownSecretValues(
  values: ReadonlyArray<string | undefined>,
): void {
  for (const value of values) {
    if (value && value.length >= MIN_SECRET_VALUE_LENGTH) {
      knownSecretValues.add(value);
    }
  }
}

export function clearKnownSecretValuesForTest(): void {
  knownSecretValues.clear();
}

function maskKnownSecretValues(text: string): string {
  if (knownSecretValues.size === 0) return text;
  let masked = text;
  for (const secret of knownSecretValues) {
    if (masked.includes(secret)) {
      masked = masked.split(secret).join(MASK);
    }
  }
  return masked;
}

/**
 * Redact credential-bearing shapes from error text before it leaves the
 * process via the usage-statistics (RUM) sink. ANSI/VT sequences and other
 * control characters are neutralised first (newlines preserved) so they
 * cannot split a key from its separator or glue a word onto a key and
 * defeat a mask. Secrets the process itself holds are masked by exact
 * value (closed by construction); everything else is pattern-masked on a
 * best-effort basis — the enumeration of spellings cannot be complete, and
 * the design doc records the residual gap. Pattern-masked rather than
 * fingerprinted: the text stays debuggable, and misses are bounded by the
 * truncation cap.
 *
 * The truncation bound and surrogate-pair guard are shared with the OTel
 * span path (`truncateErrorText` in session-tracing.ts) so both sinks
 * apply one definition of safe error text; the normalisation differs
 * deliberately — newlines survive here because the RUM feed's value is
 * the shape of the multi-line error block.
 */
export function redactErrorText(value: string): string {
  // Bound the work before the passes, not after: every mask runs over the
  // full string, so without a pre-bound the output cap bounds the payload
  // but not the CPU (the URL pass's dash-permissive class is quadratic on
  // dash-dense input; a ~140k-char hostile error took ~4s synchronously on
  // the CLI main thread). 64x the output bound is a generous working
  // multiple — everything past it is discarded by the final cap anyway —
  // and a straddling credential survives because the cut happens before,
  // not after, the mask passes. Truncating to the output bound instead
  // would leak a credential straddling that tighter cut (the URL pass
  // needs the `@` the cut removed).
  const bounded = truncateErrorText(value, SPAN_TEXT_MAX_CHARS * 64);
  // Exact-value masking runs on the raw (pre-normalised) text first: an
  // incomplete CSI sequence directly before a registered secret makes the
  // VT pass consume the secret's first char as the sequence's final byte,
  // after which the registered value no longer occurs in the normalised
  // text and both mask halves miss it. Masking before normalisation also
  // keeps the `***` output stable under the normalisation steps below.
  let text = maskKnownSecretValues(bounded);
  text = text
    .replace(JSON_ESCAPE_RE, (_m, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
    )
    .replace(VT_SEPARATOR_RUN_RE, ' ')
    .replace(VT_ANY_RUN_RE, '')
    .replace(CONTROL_CHARS_EXCEPT_NEWLINES_RE, ' ');
  // Exact-value masking runs again on the normalised text: a registered
  // secret containing a quote or backslash does not occur literally in a
  // JSON-stringified error (`SYNTHETIC"SECRET` arrives as
  // `SYNTHETIC\"SECRET`), so the raw pass above misses it and the unescape
  // above reconstructs it — after the only value-based protection has
  // finished. Mask the reconstructed shape before the pattern passes.
  text = maskKnownSecretValues(text);
  text = redactUrlCredentials(text);
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, `$1${MASK}`);
  text = text.replace(BEARER_TOKEN_PATTERN, `$1$2${MASK}`);
  text = text.replace(SECRET_FLAG_INLINE_PATTERN, `$1$2${MASK}`);
  text = text.replace(SECRET_FLAG_SPACED_PATTERN, `$1$2${MASK}`);
  text = text.replace(SECRET_ENV_PATTERN, `$1=${MASK}`);
  return truncateErrorText(text);
}
