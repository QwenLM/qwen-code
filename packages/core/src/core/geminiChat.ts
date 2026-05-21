/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// DISCLAIMER: This is a copied version of https://github.com/googleapis/js-genai/blob/main/src/chats.ts with the intention of working around a key bug
// where function responses are not treated as "valid" responses: https://b.corp.google.com/issues/420354090

import type {
  GenerateContentResponse,
  Content,
  GenerateContentConfig,
  SendMessageParameters,
  Part,
  Tool,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { createUserContent, FinishReason } from '@google/genai';
import { retryWithBackoff, isUnattendedMode } from '../utils/retry.js';
import { getErrorStatus, isAbortError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { parseAndFormatApiError } from '../utils/errorParsing.js';
import {
  getRateLimitErrorDetails,
  getRateLimitRetryDelayMs,
  isRateLimitError,
  type RetryInfo,
} from '../utils/rateLimit.js';
import type { Config } from '../config/config.js';
import {
  DEFAULT_TOKEN_LIMIT,
  ESCALATED_MAX_TOKENS,
  tokenLimit,
} from './tokenLimits.js';
import { hasCycleInSchema } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { STRUCTURED_OUTPUT_REDACTED_ARGS } from '../tools/syntheticOutput.js';
import type { StructuredError } from './turn.js';
import {
  logContentRetry,
  logContentRetryFailure,
} from '../telemetry/loggers.js';
import { type ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ChatCompressionService,
  type CompactTrigger,
} from '../services/chatCompressionService.js';
import {
  ContentRetryEvent,
  ContentRetryFailureEvent,
} from '../telemetry/types.js';
import type { UiTelemetryService } from '../telemetry/uiTelemetry.js';
import { type ChatCompressionInfo, CompressionStatus } from './turn.js';
import { getContextLengthExceededInfo } from '../utils/contextLengthError.js';
import type { SessionStartSource } from '../hooks/types.js';
import { getCustomSystemPrompt } from './prompts.js';

const debugLogger = createDebugLogger('QWEN_CODE_CHAT');

/**
 * Replaces the args on a `structured_output` `functionCall` with the
 * same `__redacted` placeholder used by `ToolCallEvent` telemetry
 * (`packages/core/src/telemetry/types.ts`).
 *
 * The chat-recording JSONL (`<projectDir>/chats/<sessionId>.jsonl`)
 * persists assistant turns to disk and re-feeds them on
 * `--continue` / `--resume`. For `--json-schema` runs the tool args
 * ARE the user's structured payload — already emitted on stdout via
 * `result` / `structured_result`. Recording them verbatim here would
 * mean the same payload (and every validation-failure retry along the
 * way) sits on disk indefinitely, contradicting the privacy contract
 * documented next to the telemetry redaction. Mirror the placeholder
 * here so the chat-recording surface matches.
 *
 * Non-`structured_output` `functionCall`s pass through untouched.
 *
 * Exported for tests; callers should prefer the inline use inside
 * `recordAssistantTurn` invocation below.
 */
export function redactStructuredOutputArgsForRecording(
  part: Part,
): { functionCall: NonNullable<Part['functionCall']> } | null {
  if (!part.functionCall) return null;
  if (part.functionCall.name !== ToolNames.STRUCTURED_OUTPUT) {
    return { functionCall: part.functionCall };
  }
  return {
    functionCall: {
      ...part.functionCall,
      args: { ...STRUCTURED_OUTPUT_REDACTED_ARGS },
    },
  };
}

function isCompressionFailureStatus(status: CompressionStatus): boolean {
  return (
    status === CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT ||
    status === CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY ||
    status === CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR
  );
}

export enum StreamEventType {
  /** A regular content chunk from the API. */
  CHUNK = 'chunk',
  /** A signal that a retry is about to happen. The UI should discard any partial
   * content from the attempt that just failed. */
  RETRY = 'retry',
  /** Emitted once at the start of the stream when an automatic compression
   * pass succeeded. Carries the compression result so callers (the main
   * agent UI, subagent loop) can surface it without each call site running
   * its own compaction step. */
  COMPRESSED = 'compressed',
}

export type StreamEvent =
  | { type: StreamEventType.CHUNK; value: GenerateContentResponse }
  | {
      type: StreamEventType.RETRY;
      retryInfo?: RetryInfo;
      /** When true, the retry is a continuation (recovery) rather than a
       *  fresh restart (escalation). The UI should keep the accumulated text
       *  buffer so the continuation appends to it. */
      isContinuation?: boolean;
    }
  | { type: StreamEventType.COMPRESSED; info: ChatCompressionInfo };

/**
 * Options for retrying due to invalid content from the model.
 */
interface ContentRetryOptions {
  /** Total number of attempts to make (1 initial + N retries). */
  maxAttempts: number;
  /** The base delay in milliseconds for linear backoff. */
  initialDelayMs: number;
}

interface TryCompressOptions {
  originalTokenCountOverride?: number;
  trigger?: CompactTrigger;
}

const INVALID_CONTENT_RETRY_OPTIONS: ContentRetryOptions = {
  maxAttempts: 2, // 1 initial call + 1 retry
  initialDelayMs: 500,
};

// Some providers occasionally return transient stream anomalies: either an
// empty stream (usage metadata only, no candidates), a stream that finishes
// normally but contains no usable text, or a stream cut off without a finish
// reason. All are retried with an independent budget (similar to rate-limit
// retries) so they do not consume each other's retry budgets.
const INVALID_STREAM_RETRY_CONFIG = {
  maxRetries: 2,
  initialDelayMs: 2000,
};

/**
 * Max recovery attempts when the escalated response is also truncated.
 * Each attempt keeps the partial response in history and injects a recovery
 * message so the model can continue from where it left off.
 */
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

/**
 * Recovery message injected as a user turn when the model's output is
 * truncated even after token escalation. Instructs the model to resume
 * without repeating itself and to break remaining work into smaller steps.
 */
const OUTPUT_RECOVERY_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap of what ' +
  'you were doing. Pick up mid-thought if that is where the cut happened. ' +
  'Break remaining work into smaller pieces.';

/**
 * Maximum length of the previous-response tail embedded inside the
 * `<previous_response_suffix>` block of the recovery user-turn. Chosen as a
 * pragmatic balance: large enough to give the model enough trailing context to
 * resume coherently (covers ~200–400 tokens of prose, or a multi-row Markdown
 * table), and small enough to keep the recovery prompt well under any
 * provider's input budget even when combined with the rest of history.
 */
const OUTPUT_RECOVERY_TAIL_CHARS = 1200;

/**
 * Hard cap on the inner overlap/contained-prefix scan loops. Bounds both the
 * suffix-anchored overlap search in {@link getRecoveryContinuationSuffix} and
 * the contained-prefix scan in {@link findContainedRecoveryPrefixReplayLength}
 * so recovery dedup stays O(min(previous, continuation, 4000)) in iteration
 * count instead of unbounded against pathologically large continuations.
 */
const RECOVERY_OVERLAP_MAX_SCAN_CHARS = 4000;

/**
 * Minimum byte-length before a plain-text overlap (between previous tail and
 * continuation prefix) is considered "significant" enough to dedup. Short
 * coincidental matches like `". "`, `"the "`, or `", and "` happen routinely
 * across unrelated turns; requiring ≥6 bytes makes accidental matches on
 * common short suffixes vanishingly unlikely while still catching meaningful
 * replayed phrases.
 */
const RECOVERY_OVERLAP_MIN_BYTES = 6;

/**
 * Companion floor in *code points* for prose overlaps. The byte floor alone is
 * too permissive for CJK: a single Chinese character is 3 UTF-8 bytes, so
 * `RECOVERY_OVERLAP_MIN_BYTES = 6` would accept a coincidental 2-character
 * overlap like `"我们"` / `"但是"` that is extremely common across unrelated
 * Chinese turns. Requiring at least 4 code points in addition to the byte
 * floor makes CJK collisions need a 4-character coincidence (~10⁻⁵ when
 * each character is independent), without raising the bar for ASCII (4 ASCII
 * chars is only 4 bytes — still gated by the 6-byte floor, so ASCII effectively
 * needs ≥6 chars). Structural anchors (`#|`\n) are exempted because the
 * structural floor already governs them and structural collisions are far
 * rarer than prose.
 */
const RECOVERY_OVERLAP_MIN_CHARS = 4;

/**
 * Lower floor for overlaps that contain Markdown structural characters
 * (`#`, `|`, backtick, newline). Structural anchors are far less likely to
 * collide coincidentally than prose — a 4-byte overlap like `"| a "` or
 * `"## "` is almost certainly a replayed block-level marker, so we accept a
 * smaller match to catch table/heading replays that the 6-byte prose floor
 * would otherwise miss.
 */
const RECOVERY_STRUCTURAL_OVERLAP_MIN_BYTES = 4;
// Plain-prose substring matches outside the suffix-anchored path are very
// prone to false positives on common opener phrases ("In summary, …", "Here is
// the …"). The contained-prefix replay path is reserved for replayed Markdown
// blocks (tables, headings, fenced code), so we require both a structural
// anchor at the start of the prefix and a substantially larger byte floor than
// the suffix path uses. This intentionally errs on the side of leaving rare
// duplicates in history rather than silently dropping legitimate continuation.
const RECOVERY_CONTAINED_PREFIX_MIN_BYTES = 12;
// Limit the substring search to the immediate truncation tail so a coincidental
// match thousands of characters earlier in the previous turn cannot win.
const RECOVERY_CONTAINED_TAIL_LOOKBACK_CHARS = 400;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isSignificantRecoveryOverlap(overlap: string): boolean {
  const overlapBytes = byteLength(overlap);
  // This is intentionally a loose "contains any of these chars" check rather
  // than a strict Markdown-block-anchor parse: an overlap that picks up `#`,
  // `` ` ``, `|`, or `\n` is *probably* a replayed structural marker, and
  // the 4-byte structural floor only differs from the 6-byte prose floor by
  // a 2-byte window. The worst realistic over-classification (4–5 byte prose
  // fragments like `"C#dev"` or `"a|b|c"` slipping through the structural
  // path instead of the prose path) still requires that fragment to be
  // identical at the truncation boundary on both sides, which is far rarer
  // than the structural-replay scenarios this lower floor exists to catch.
  const hasMarkdownStructure = /[#|`\n]/.test(overlap);
  if (
    hasMarkdownStructure &&
    overlapBytes >= RECOVERY_STRUCTURAL_OVERLAP_MIN_BYTES
  ) {
    return true;
  }
  // Prose overlaps must clear *both* the byte floor (covers ASCII) and the
  // code-point floor (covers CJK). Counting code points via the spread
  // iterator handles surrogate pairs correctly so emoji do not double-count.
  const overlapChars = [...overlap].length;
  return (
    overlapBytes >= RECOVERY_OVERLAP_MIN_BYTES &&
    overlapChars >= RECOVERY_OVERLAP_MIN_CHARS
  );
}

/**
 * Returns true if `text` opens with a Markdown block-level structural marker
 * (table row, fenced code, ATX heading, blockquote, list item). Leading
 * whitespace/newline chars are skipped because providers often prepend them
 * when restarting a block — some completion APIs re-emit the suffix with
 * leading spaces or tabs, not just newlines. The marker must appear at the
 * start of a line and be followed by the syntactic gap the spec requires
 * (e.g. `# ` not `#abc`), so incidental `#` or `|` characters in prose do
 * not count.
 *
 * The table-row alternation requires either ≥3 pipes (GFM tables need at
 * least 2 cells, i.e. 3 separator pipes) *or* a separator row (`|---|`,
 * `|:---:|`, etc.). A bare `|expression|` in technical prose has only 2
 * pipes and no separator syntax, so it is intentionally rejected — that
 * pattern is not a valid GFM table row anyway.
 */
function startsWithMarkdownStructuralAnchor(text: string): boolean {
  const trimmed = text.replace(/^\s+/, '');
  return /^(\|[^\n]*\|[^\n]*\||\|[\s\-:]+\||#{1,6} |```|>\s|[-*+] |\d+\. )/.test(
    trimmed,
  );
}

function findContainedRecoveryPrefixReplayLength(
  previousText: string,
  continuationText: string,
): number {
  // Only consider replaying the *immediate* tail of the previous response.
  // Earlier matches would let a coincidental substring far above the
  // truncation point silently delete legitimate continuation text.
  const previousTail =
    previousText.length > RECOVERY_CONTAINED_TAIL_LOOKBACK_CHARS
      ? previousText.slice(-RECOVERY_CONTAINED_TAIL_LOOKBACK_CHARS)
      : previousText;

  // The contained-prefix path is intended *only* for replayed Markdown blocks
  // (tables, headings, fenced code) that providers re-emit when resuming after
  // MAX_TOKENS. Prose replays — even ones that briefly coincide with the
  // previous tail — are out of scope: dropping them would silently lose user-
  // visible content. Require a structural anchor at the very start of the
  // continuation before considering any contained-prefix match at all.
  if (!startsWithMarkdownStructuralAnchor(continuationText)) {
    return 0;
  }

  // The anchor check above tolerates leading whitespace because some providers
  // re-emit the replayed block with extra leading spaces/tabs. The actual
  // substring match must use the *trimmed* continuation, otherwise a
  // continuation like `"  ### Heading"` would never match a previous tail
  // containing `"### Heading"` (no leading whitespace). Track the offset so
  // the returned length consumes the leading whitespace too — keeping the
  // caller's `continuationText.slice(replayedLength)` invariant intact.
  const leadingMatch = continuationText.match(/^\s+/);
  const leadingWhitespaceLength = leadingMatch?.[0].length ?? 0;
  const trimmedContinuation = continuationText.slice(leadingWhitespaceLength);

  const maxPrefix = Math.min(
    previousTail.length,
    trimmedContinuation.length,
    RECOVERY_OVERLAP_MAX_SCAN_CHARS,
  );

  for (let length = maxPrefix; length > 0; length -= 1) {
    const prefix = trimmedContinuation.slice(0, length);
    if (
      byteLength(prefix) >= RECOVERY_CONTAINED_PREFIX_MIN_BYTES &&
      previousTailContainsAtLineBoundary(previousTail, prefix)
    ) {
      return leadingWhitespaceLength + length;
    }
  }

  return 0;
}

/**
 * Symmetric line-boundary check for the contained-prefix scan: returns true
 * iff `prefix` occurs in `previousTail` starting at index 0 or immediately
 * after a newline. The structural-anchor check on the continuation side only
 * enforces that the *continuation* starts at a Markdown block boundary;
 * without this guard, a plain substring match could land mid-paragraph in
 * `previousTail` (e.g. inside a code block that contains the literal string
 * `"### Heading\nfoo"`) and silently strip legitimate continuation text. All
 * occurrences are checked so a benign mid-paragraph hit doesn't shadow a real
 * line-anchored replay later in the tail.
 */
function previousTailContainsAtLineBoundary(
  previousTail: string,
  prefix: string,
): boolean {
  let searchFrom = 0;
  while (searchFrom <= previousTail.length) {
    const matchIndex = previousTail.indexOf(prefix, searchFrom);
    if (matchIndex === -1) {
      return false;
    }
    if (matchIndex === 0 || previousTail.charAt(matchIndex - 1) === '\n') {
      return true;
    }
    searchFrom = matchIndex + 1;
  }
  return false;
}

/**
 * Compute the portion of `continuationText` that should be appended to
 * `previousText` after a MAX_TOKENS recovery, stripping any overlap that the
 * provider replayed at the boundary.
 *
 * The empty-input guard (`previousText.length === 0 ||
 * continuationText.length === 0`) is *defensive only*. The sole production
 * caller is {@link appendRecoveryContinuationParts}, which already short-
 * circuits when either side has no plain-text part — neither branch of the
 * guard can fire from production code. It exists so that anyone reusing this
 * helper directly (e.g. a future unit test, a refactor that bypasses the
 * caller's filter) cannot crash or read out of bounds. We deliberately leave
 * the guard in place rather than rely on the caller's invariant alone.
 */
function getRecoveryContinuationSuffix(
  previousText: string,
  continuationText: string,
): string {
  if (previousText.length === 0 || continuationText.length === 0) {
    return continuationText;
  }

  if (
    previousText.endsWith(continuationText) &&
    isSignificantRecoveryOverlap(continuationText)
  ) {
    return '';
  }

  const maxOverlap = Math.min(
    previousText.length,
    continuationText.length,
    RECOVERY_OVERLAP_MAX_SCAN_CHARS,
  );

  // Worst-case complexity here is O(n²): up to RECOVERY_OVERLAP_MAX_SCAN_CHARS
  // iterations, each calling `previousText.endsWith(overlap)` plus
  // `byteLength(overlap)` (both O(m)). At the current 4000-char scan cap that
  // is ~16M char-ops per recovery event, which is fine because recovery is
  // rare and the cap is small. If the cap ever grows materially, this can be
  // rewritten with a precomputed Z-array / failure function on
  // `continuationText` to scan once instead of repeatedly slicing/comparing.
  for (let length = maxOverlap; length > 0; length -= 1) {
    const overlap = continuationText.slice(0, length);
    if (
      isSignificantRecoveryOverlap(overlap) &&
      previousText.endsWith(overlap)
    ) {
      return continuationText.slice(length);
    }
  }

  // Providers/models frequently resume a MAX_TOKENS recovery from an anchor
  // that appears near the tail of the previous response, rather than from the
  // exact last byte. Drop that replayed leading prefix before coalescing the
  // recovery model turn into durable history; otherwise later turns inherit
  // duplicated Markdown tables/prose even if the live UI suppresses them.
  const containedPrefixLength = findContainedRecoveryPrefixReplayLength(
    previousText,
    continuationText,
  );
  if (containedPrefixLength > 0) {
    const replayedPrefix = continuationText.slice(0, containedPrefixLength);
    let suffix = continuationText.slice(containedPrefixLength);
    if (
      suffix.length > 0 &&
      replayedPrefix.endsWith('\n') &&
      !previousText.endsWith('\n') &&
      !suffix.startsWith('\n')
    ) {
      suffix = `\n${suffix}`;
    }
    return suffix;
  }

  return continuationText;
}

function isPlainTextPart(part: Part | undefined): part is Part & {
  text: string;
} {
  // Delegate to the shared predicate used by normal history consolidation
  // (see `isValidNonThoughtTextPart` below) so the recovery-merge path and
  // the consolidated-history path agree on what counts as "plain text".
  // Keeping the type predicate here gives callers `part.text: string`
  // narrowing; the underlying checks (thought, thoughtSignature, function*,
  // inlineData, fileData) live in one place.
  return part !== undefined && isValidNonThoughtTextPart(part);
}

function getPlainTextFromParts(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter(isPlainTextPart)
    .map((part) => part.text)
    .join('');
}

/**
 * Sanitize the previous-response tail before embedding it inside the
 * `<previous_response_suffix>...</previous_response_suffix>` block.
 *
 * If the model's own truncated output happened to contain the literal
 * closing delimiter (e.g. while generating XML/HTML examples), the
 * recovery prompt's structure would break — the model would see a
 * prematurely closed tag and misinterpret the suffix boundary. We
 * neutralize any literal opening/closing delimiter occurrences by
 * inserting a zero-width space between the angle bracket and the rest
 * of the tag. The text remains visually identical to the model and
 * preserves the recovery instruction's intent, but no longer collides
 * with our delimiter scan.
 */
function sanitizeRecoverySuffixTail(tail: string): string {
  if (
    !tail.includes('</previous_response_suffix>') &&
    !tail.includes('<previous_response_suffix>')
  ) {
    return tail;
  }
  return tail
    .replace(/<\/previous_response_suffix>/g, '<​/previous_response_suffix>')
    .replace(/<previous_response_suffix>/g, '<​previous_response_suffix>');
}

function buildOutputRecoveryMessage(previousModelTurn: Content | undefined) {
  const previousText =
    previousModelTurn?.role === 'model'
      ? getPlainTextFromParts(previousModelTurn.parts)
      : '';
  if (previousText.trim().length === 0) {
    return OUTPUT_RECOVERY_MESSAGE;
  }

  const rawTail =
    previousText.length > OUTPUT_RECOVERY_TAIL_CHARS
      ? previousText.slice(-OUTPUT_RECOVERY_TAIL_CHARS)
      : previousText;
  const tail = sanitizeRecoverySuffixTail(rawTail);

  return (
    `${OUTPUT_RECOVERY_MESSAGE}\n\n` +
    'The previous assistant response ended with this exact suffix. ' +
    'Do not repeat any line, table row, code line, or prose that already ' +
    'appears in it; output only text that comes after this suffix:\n\n' +
    '<previous_response_suffix>\n' +
    tail +
    '\n</previous_response_suffix>'
  );
}

/**
 * Coalesce a recovery continuation turn into the preceding (truncated) model
 * turn, dropping any replayed overlap.
 *
 * Coupling with `processStreamResponse`. This function assumes the parts
 * arrays it receives were produced by {@link GeminiChat.processStreamResponse}
 * — i.e. all plain-text streaming chunks from a given turn have been
 * consolidated in place into a single text part via `lastPart.text +=
 * part.text`. The dedup logic only inspects the *last* plain-text part of
 * `previousParts` and the *first* plain-text part of `continuationParts`, so
 * if a future refactor of `processStreamResponse` ever emits multiple adjacent
 * unconsolidated text parts per turn, this function would compare the
 * continuation against only the trailing fragment and miss real overlaps with
 * earlier fragments. Both functions live in this file precisely so the
 * coupling is reviewable in a single window.
 *
 * Return-value shape. The returned array preserves the *shape convention* of
 * `processStreamResponse` output: `[thoughtPart?, ...consolidatedTextParts,
 * ...nonTextParts]`. {@link GeminiChat.coalesceRecoveryPairs} relies on this
 * by feeding the merged result back as `previousParts` on the next recovery
 * iteration; if the shape ever diverges, multi-iteration recovery dedup would
 * fail silently against the wrong part.
 */
function appendRecoveryContinuationParts(
  previousParts: Part[] | undefined,
  continuationParts: Part[] | undefined,
): Part[] {
  const mergedParts = [...(previousParts ?? [])];
  const nextParts = [...(continuationParts ?? [])];

  // `processStreamResponse` orders parts as
  // `[thoughtPart?, ...consolidatedHistoryParts]`, so for thinking models the
  // first element of `nextParts` is the recovery turn's thought, not its
  // plain-text continuation. Similarly the previous truncated turn may end
  // with a non-text part. Scan both sides for the dedup-relevant plain-text
  // anchor instead of locking onto the boundary indices, otherwise thinking
  // models leak duplicated text into durable history because the dedup block
  // gets skipped wholesale.
  const previousTextIndex = findLastPlainTextPartIndex(mergedParts);
  const continuationTextIndex = nextParts.findIndex(isPlainTextPart);

  if (previousTextIndex >= 0 && continuationTextIndex >= 0) {
    const previousTextPart = mergedParts[previousTextIndex] as Part & {
      text: string;
    };
    const continuationTextPart = nextParts[continuationTextIndex] as Part & {
      text: string;
    };
    const suffix = getRecoveryContinuationSuffix(
      previousTextPart.text,
      continuationTextPart.text,
    );
    if (suffix.length > 0) {
      // Allocate a fresh part rather than mutating in place: `mergedParts`
      // shares element references with the caller's history slot, and any
      // downstream caller that cached a `part` reference would observe the
      // mutation. Cheap allocation; eliminates a fragile invariant.
      mergedParts[previousTextIndex] = {
        ...previousTextPart,
        text: previousTextPart.text + suffix,
      };
    }
    // Drop the matched continuation text part: a non-empty suffix has already
    // been appended above, and an empty suffix means the part was a pure
    // replay of the previous tail and should be discarded so it does not
    // duplicate into history. Hoist any non-text parts that preceded the
    // matched text on the continuation side (typically the recovery turn's
    // thought) so they land *before* the merged text part — thinking-model
    // providers (Gemini 2.5+, Anthropic, OpenAI o-series) validate
    // thought-signature provenance and expect a thought to precede the
    // content it generated. Trailing non-text parts (tool calls etc.) keep
    // their position via the final `[...mergedParts, ...nextParts]` concat.
    const leadingNonTextParts = nextParts.splice(0, continuationTextIndex);
    nextParts.shift();
    if (leadingNonTextParts.length > 0) {
      mergedParts.splice(previousTextIndex, 0, ...leadingNonTextParts);
    }
  }

  return [...mergedParts, ...nextParts];
}

function findLastPlainTextPartIndex(parts: Part[]): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (isPlainTextPart(parts[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * Options for retrying on rate-limit throttling errors returned as stream content.
 * Starts at 60s to match DashScope's per-minute quota window, then backs off
 * across repeated stream-side throttling errors.
 * 10 retries aligns with Claude Code's retry behavior.
 */
const RATE_LIMIT_RETRY_OPTIONS = {
  maxRetries: 10,
  initialDelayMs: 60000,
  maxDelayMs: 5 * 60 * 1000,
};

/**
 * Creates a promise that resolves after the specified delay, but can be
 * resolved early by calling the returned `skip` function.
 *
 * If an `AbortSignal` is provided and it fires before the delay completes,
 * the promise rejects so the caller's `await` throws and normal error
 * propagation takes over (e.g. the retry loop breaks and the generator exits).
 */
function delay(
  delayMs: number,
  signal?: AbortSignal,
): {
  promise: Promise<void>;
  skip: () => void;
} {
  let resolveRef: () => void;
  let timeoutId: ReturnType<typeof setTimeout>;

  const promise = new Promise<void>((resolve, reject) => {
    resolveRef = resolve;

    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    timeoutId = setTimeout(resolve, delayMs);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(signal.reason);
      },
      { once: true },
    );
  });

  return {
    promise,
    skip: () => {
      clearTimeout(timeoutId);
      resolveRef();
    },
  };
}

/**
 * Returns true if the response is valid, false otherwise.
 *
 * The DashScope provider may return the last 2 chunks as:
 * 1. A choice(candidate) with finishReason and empty content
 * 2. Empty choices with usage metadata
 * We'll check separately for both of these cases.
 */
function isValidResponse(response: GenerateContentResponse): boolean {
  if (response.usageMetadata) {
    return true;
  }

  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }

  if (response.candidates.some((candidate) => candidate.finishReason)) {
    return true;
  }

  const content = response.candidates[0]?.content;
  return content !== undefined && isValidContent(content);
}

export function isValidNonThoughtTextPart(part: Part): boolean {
  return (
    typeof part.text === 'string' &&
    !part.thought &&
    !part.thoughtSignature &&
    // Technically, the model should never generate parts that have text and
    //  any of these but we don't trust them so check anyways.
    !part.functionCall &&
    !part.functionResponse &&
    !part.inlineData &&
    !part.fileData
  );
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!isValidContentPart(part)) {
      return false;
    }
  }
  return true;
}

function isValidContentPart(part: Part): boolean {
  const isInvalid =
    !part.thought &&
    !part.thoughtSignature &&
    part.text !== undefined &&
    part.text === '' &&
    part.functionCall === undefined;

  return !isInvalid;
}

/**
 * Validates the history contains the correct roles.
 *
 * @throws Error if the history does not start with a user turn.
 * @throws Error if the history contains an invalid role.
 */
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== 'user' && content.role !== 'model') {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

/**
 * Extracts the curated (valid) history from a comprehensive history.
 *
 * @remarks
 * The model may sometimes generate invalid or empty contents(e.g., due to safety
 * filters or recitation). Extracting valid turns from the history
 * ensures that subsequent requests could be accepted by the model.
 */
function extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
  if (comprehensiveHistory === undefined || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory: Content[] = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === 'user') {
      curatedHistory.push(comprehensiveHistory[i]);
      i++;
    } else {
      const modelOutput: Content[] = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === 'model') {
        modelOutput.push(comprehensiveHistory[i]);
        if (isValid && !isValidContent(comprehensiveHistory[i])) {
          isValid = false;
        }
        i++;
      }
      if (isValid) {
        curatedHistory.push(...modelOutput);
      }
    }
  }
  return curatedHistory;
}

function copyContentContainer(content: Content): Content {
  return {
    ...content,
    ...(content.parts ? { parts: [...content.parts] } : {}),
  };
}

function stripThoughtPartsFromContent(content: Content): Content | null {
  if (!content.parts) {
    return content;
  }

  const parts = content.parts.filter((part) => !(part as Part).thought);
  if (parts.length === 0) {
    return null;
  }

  return {
    ...content,
    parts,
  };
}

/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 */
export class InvalidStreamError extends Error {
  readonly type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT';

  constructor(message: string, type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT') {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}

/**
 * Chat session that enables sending messages to the model with previous
 * conversation context.
 *
 * @remarks
 * The session maintains all the turns between user and model.
 */
const SESSION_START_CONTEXT_SENTINEL_START =
  '<qwen:session-start-context hidden="true">';
const SESSION_START_CONTEXT_SENTINEL_END = '</qwen:session-start-context>';
const SESSION_START_CONTEXT_HEADER = 'SessionStart additional context';

function buildSessionStartContextBlock(extraInstruction: string): string {
  return `\n\n${SESSION_START_CONTEXT_SENTINEL_START}\n${SESSION_START_CONTEXT_HEADER}:\n${extraInstruction}\n${SESSION_START_CONTEXT_SENTINEL_END}`;
}

function stripTrailingSessionStartContextBlock(
  systemInstruction: string,
): string {
  const startIndex = systemInstruction.lastIndexOf(
    `\n\n${SESSION_START_CONTEXT_SENTINEL_START}\n${SESSION_START_CONTEXT_HEADER}:\n`,
  );
  if (startIndex === -1) {
    return systemInstruction;
  }

  const endIndex = systemInstruction.indexOf(
    `\n${SESSION_START_CONTEXT_SENTINEL_END}`,
    startIndex,
  );
  if (endIndex === -1) {
    return systemInstruction;
  }

  return systemInstruction.slice(0, startIndex);
}

export class GeminiChat {
  // A promise to represent the current state of the message being sent to the
  // model.
  private sendPromise: Promise<void> = Promise.resolve();

  /**
   * Per-chat last-prompt-token-count, populated from `usageMetadata` on each
   * model response. Used by the compaction threshold check so that subagents
   * (which intentionally don't write to the global telemetry singleton) can
   * still make compaction decisions based on their *own* context size.
   */
  private lastPromptTokenCount = 0;

  /**
   * Per-chat sticky flag. After an unforced compression attempt fails (empty
   * summary or inflated token count), automatic compaction is suppressed
   * for the remainder of this chat to avoid burning compression API calls
   * in a loop. Manual `/compress` still works (it passes `force=true`).
   */
  private hasFailedCompressionAttempt = false;

  /**
   * Creates a new GeminiChat instance.
   *
   * @param config - The configuration object.
   * @param generationConfig - Optional generation configuration.
   * @param history - Optional initial conversation history.
   * @param chatRecordingService - Optional recording service. If provided, chat
   *   messages will be recorded.
   * @param telemetryService - Optional UI telemetry service. When provided,
   *   prompt token counts are reported on each API response. Pass `undefined`
   *   for sub-agent chats to avoid overwriting the main agent's context usage.
   */
  constructor(
    private readonly config: Config,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
    private readonly chatRecordingService?: ChatRecordingService,
    private readonly telemetryService?: UiTelemetryService,
  ) {
    validateHistory(history);
  }

  /**
   * Most recent prompt-token count reported by the model for *this* chat,
   * mirroring the value in {@link UiTelemetryService} for the main session.
   * Subagent chats have no telemetry service wired but still need a per-chat
   * count for compaction decisions, so this is always populated regardless
   * of whether the global telemetry is updated.
   */
  getLastPromptTokenCount(): number {
    return this.lastPromptTokenCount;
  }

  /**
   * Builds request contents for the content generator without deep-cloning the
   * whole chat history. This is an internal hot path: long sessions can make a
   * full `structuredClone` larger than the remaining V8 heap headroom.
   *
   * Public history readers still use {@link getHistory}, which returns a
   * defensive deep copy for caller mutation safety.
   */
  private getRequestHistory(): Content[] {
    return extractCuratedHistory(this.history).map(copyContentContainer);
  }

  /**
   * Seed the last-prompt-token-count for chats created with inherited
   * history (forks, subagents, speculation). Without this, the auto-compress
   * threshold check sees `0` and refuses to compress — so the first API call
   * can 400 from oversized history. Callers pass the parent chat's
   * `getLastPromptTokenCount()` here.
   */
  setLastPromptTokenCount(count: number): void {
    this.lastPromptTokenCount = count;
  }

  /**
   * Attempt to compress this chat's history.
   *
   * Returns the compression info regardless of outcome. On a successful
   * compaction (`COMPRESSED`), this method has already mutated the chat's
   * history, recorded the event to `chatRecordingService` (if wired), and
   * updated both the per-chat token count and (when wired) the global
   * telemetry singleton.
   */
  async tryCompress(
    promptId: string,
    model: string,
    force = false,
    signal?: AbortSignal,
    options?: TryCompressOptions,
  ): Promise<ChatCompressionInfo> {
    const service = new ChatCompressionService();
    const { newHistory, info } = await service.compress(this, {
      promptId,
      force,
      model,
      config: this.config,
      hasFailedCompressionAttempt: this.hasFailedCompressionAttempt,
      originalTokenCount:
        options?.originalTokenCountOverride ?? this.lastPromptTokenCount,
      trigger: options?.trigger,
      signal,
    });

    if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
      this.chatRecordingService?.recordChatCompression({
        info,
        compressedHistory: newHistory,
      });
      this.setHistory(newHistory);
      debugLogger.debug('[FILE_READ_CACHE] clear after auto tryCompress');
      this.config.getFileReadCache().clear();
      this.lastPromptTokenCount = info.newTokenCount;
      this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
      this.hasFailedCompressionAttempt = false;
    } else if (isCompressionFailureStatus(info.compressionStatus)) {
      if (!force) {
        this.hasFailedCompressionAttempt = true;
      }
    }

    return info;
  }

  setSystemInstruction(sysInstr: string) {
    this.generationConfig.systemInstruction = sysInstr;
  }

  setSessionStartContext(extraInstruction: string) {
    const trimmed = extraInstruction.trim();
    if (!trimmed) {
      return;
    }

    const current = this.generationConfig.systemInstruction;
    let baseInstruction = '';
    if (typeof current === 'string') {
      baseInstruction = stripTrailingSessionStartContextBlock(current);
    } else if (current) {
      baseInstruction = getCustomSystemPrompt(current);
      baseInstruction = stripTrailingSessionStartContextBlock(baseInstruction);
    }
    const contextBlock = buildSessionStartContextBlock(trimmed);
    this.generationConfig.systemInstruction = `${baseInstruction}${contextBlock}`;
  }

  applySessionStartContext(
    extraInstruction: string,
    _source: SessionStartSource,
  ): void {
    const trimmed = extraInstruction.trim();
    if (!trimmed) {
      return;
    }

    this.setSessionStartContext(trimmed);
  }

  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   * message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   * console.log(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(
    model: string,
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<StreamEvent>> {
    await this.sendPromise;

    let streamDoneResolver: () => void;
    const streamDonePromise = new Promise<void>((resolve) => {
      streamDoneResolver = resolve;
    });
    this.sendPromise = streamDonePromise;

    let compressionInfo: ChatCompressionInfo;
    let requestContents: Content[];
    let userContentAdded = false;
    try {
      // The send-lock above is held but the generator's `finally` (which
      // resolves it) has not run yet. Any setup error before returning the
      // generator must release the lock or subsequent sends will block forever
      // at `await this.sendPromise`.
      compressionInfo = await this.tryCompress(
        prompt_id,
        model,
        false,
        params.config?.abortSignal,
      );

      const userContent = createUserContent(params.message);

      // Add user content to history ONCE before any attempts.
      this.history.push(userContent);
      userContentAdded = true;
      requestContents = this.getRequestHistory();
    } catch (error) {
      if (userContentAdded) {
        this.history.pop();
      }
      streamDoneResolver!();
      throw error;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* () {
      try {
        // Surface a successful auto-compression to the caller as the first
        // event in the stream. Failed/skipped compaction attempts are silent.
        // Must be inside the try so that a consumer abandoning the stream
        // immediately after this event still triggers the finally below;
        // otherwise `streamDoneResolver` never fires and the next send hangs.
        if (
          compressionInfo.compressionStatus === CompressionStatus.COMPRESSED
        ) {
          yield {
            type: StreamEventType.COMPRESSED,
            info: compressionInfo,
          };
        }

        let lastError: unknown = new Error('Request failed after all retries.');
        let rateLimitRetryCount = 0;
        let invalidStreamRetryCount = 0;
        let reactiveCompressionAttempted = false;
        let suppressNextRetryEvent = false;

        // Read per-config overrides; fall back to built-in defaults.
        const cgConfig = self.config.getContentGeneratorConfig();
        const maxRateLimitRetries =
          cgConfig?.maxRetries ?? RATE_LIMIT_RETRY_OPTIONS.maxRetries;
        const extraRetryErrorCodes = cgConfig?.retryErrorCodes;

        // Max output tokens escalation: when no user/env override is set,
        // the capped default (8K) is used. If the model hits MAX_TOKENS,
        // retry once with escalated limit (64K).
        let maxTokensEscalated = false;
        const hasUserMaxTokensOverride =
          (cgConfig?.samplingParams?.max_tokens !== undefined &&
            cgConfig?.samplingParams?.max_tokens !== null) ||
          !!process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];

        let lastFinishReason: string | undefined;

        for (
          let attempt = 0;
          attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts;
          attempt++
        ) {
          try {
            if (suppressNextRetryEvent) {
              suppressNextRetryEvent = false;
            } else if (
              attempt > 0 ||
              rateLimitRetryCount > 0 ||
              invalidStreamRetryCount > 0
            ) {
              yield { type: StreamEventType.RETRY };
            }

            const stream = await self.makeApiCallAndProcessStream(
              model,
              requestContents,
              params,
              prompt_id,
            );

            lastFinishReason = undefined;
            for await (const chunk of stream) {
              const fr = chunk.candidates?.[0]?.finishReason;
              if (fr) lastFinishReason = fr;
              yield { type: StreamEventType.CHUNK, value: chunk };
            }

            lastError = null;
            break;
          } catch (error) {
            lastError = error;

            // Handle rate-limit / throttling errors returned as stream content.
            // These arrive as StreamContentError with finish_reason="error_finish"
            // from the pipeline, containing the throttling message in the content.
            // Covers TPM throttling, GLM rate limits, and other provider throttling.
            const isRateLimit = isRateLimitError(error, extraRetryErrorCodes);
            if (isRateLimit && rateLimitRetryCount < maxRateLimitRetries) {
              rateLimitRetryCount++;
              const delayMs = getRateLimitRetryDelayMs(rateLimitRetryCount, {
                ...RATE_LIMIT_RETRY_OPTIONS,
                error,
              });
              const message = parseAndFormatApiError(
                error instanceof Error ? error.message : String(error),
              );
              const details = getRateLimitErrorDetails(error);
              debugLogger.warn('Rate limit retry scheduled', {
                retryPath: 'stream',
                retryDecision: 'retry',
                attempt: rateLimitRetryCount,
                maxRetries: maxRateLimitRetries,
                retryDelayMs: delayMs,
                ...details,
              });
              const { promise: delayPromise, skip } = delay(
                delayMs,
                params.config?.abortSignal,
              );
              yield {
                type: StreamEventType.RETRY,
                retryInfo: {
                  message,
                  attempt: rateLimitRetryCount,
                  maxRetries: maxRateLimitRetries,
                  delayMs,
                  skipDelay: skip,
                },
              };
              // Don't count rate-limit retries against the content retry limit
              attempt--;
              await delayPromise;
              continue;
            }
            if (isRateLimit) {
              debugLogger.warn('Rate limit retry exhausted', {
                retryPath: 'stream',
                retryDecision: 'exhausted',
                attempts: rateLimitRetryCount,
                maxRetries: maxRateLimitRetries,
                ...getRateLimitErrorDetails(error),
              });
            }

            const contextOverflow = getContextLengthExceededInfo(error);
            if (contextOverflow.isExceeded) {
              if (!reactiveCompressionAttempted) {
                reactiveCompressionAttempted = true;
                const reactiveOriginalTokenCount =
                  contextOverflow.actualTokens ??
                  contextOverflow.limitTokens ??
                  self.config.getContentGeneratorConfig()?.contextWindowSize ??
                  DEFAULT_TOKEN_LIMIT;
                debugLogger.warn(
                  'Context length exceeded; attempting reactive compression.',
                );
                try {
                  const reactiveInfo = await self.tryCompress(
                    prompt_id,
                    model,
                    true,
                    params.config?.abortSignal,
                    {
                      originalTokenCountOverride: reactiveOriginalTokenCount,
                      trigger: 'auto',
                    },
                  );

                  if (
                    reactiveInfo.compressionStatus ===
                    CompressionStatus.COMPRESSED
                  ) {
                    requestContents = self.getRequestHistory();
                    debugLogger.info(
                      `Reactive compression succeeded: ` +
                        `${reactiveInfo.originalTokenCount} -> ` +
                        `${reactiveInfo.newTokenCount} tokens.`,
                    );
                    yield {
                      type: StreamEventType.COMPRESSED,
                      info: reactiveInfo,
                    };
                    yield { type: StreamEventType.RETRY };
                    suppressNextRetryEvent = true;
                    // Do not count reactive compression against the content
                    // validation retry budget.
                    attempt--;
                    continue;
                  }

                  debugLogger.warn(
                    `Reactive compression did not recover context overflow: ` +
                      `status=${reactiveInfo.compressionStatus}.`,
                  );
                  if (
                    isCompressionFailureStatus(reactiveInfo.compressionStatus)
                  ) {
                    self.hasFailedCompressionAttempt = true;
                  }
                } catch (compressionError) {
                  if (
                    params.config?.abortSignal?.aborted ||
                    isAbortError(compressionError)
                  ) {
                    throw compressionError;
                  }
                  debugLogger.warn(
                    'Reactive compression failed.',
                    compressionError,
                  );
                }
              } else {
                debugLogger.warn(
                  'Reactive compression already attempted; ' +
                    'propagating the context overflow error to caller.',
                );
              }
              break;
            }

            // Transient stream anomalies (NO_FINISH_REASON / NO_RESPONSE_TEXT):
            // independent retry budget, similar to rate-limit handling.
            // Does NOT consume the content retry budget.
            const isTransientStreamError = error instanceof InvalidStreamError;
            if (
              isTransientStreamError &&
              invalidStreamRetryCount < INVALID_STREAM_RETRY_CONFIG.maxRetries
            ) {
              invalidStreamRetryCount++;
              const delayMs =
                INVALID_STREAM_RETRY_CONFIG.initialDelayMs *
                invalidStreamRetryCount;
              debugLogger.warn(
                `Invalid stream [${(error as InvalidStreamError).type}] ` +
                  `(retry ${invalidStreamRetryCount}/${INVALID_STREAM_RETRY_CONFIG.maxRetries}). ` +
                  `Waiting ${delayMs / 1000}s before retrying...`,
              );
              logContentRetry(
                self.config,
                new ContentRetryEvent(
                  invalidStreamRetryCount - 1,
                  (error as InvalidStreamError).type,
                  delayMs,
                  model,
                ),
              );
              yield { type: StreamEventType.RETRY };
              // Don't count transient retries against content retry limit.
              attempt--;
              await delay(delayMs, params.config?.abortSignal).promise;
              continue;
            }
            // Transient budget exhausted — stop immediately.
            if (isTransientStreamError) {
              break;
            }

            // Other content validation errors (e.g. NO_FINISH_REASON).
            const isContentError = error instanceof InvalidStreamError;
            if (isContentError) {
              if (attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1) {
                logContentRetry(
                  self.config,
                  new ContentRetryEvent(
                    attempt,
                    (error as InvalidStreamError).type,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs,
                    model,
                  ),
                );
                await delay(
                  INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs * (attempt + 1),
                  params.config?.abortSignal,
                ).promise;
                continue;
              }
            }
            break;
          }
        }

        // Max output tokens escalation: if the retry loop succeeded with
        // the capped default (8K) but hit MAX_TOKENS, retry once at the
        // model's full output limit. This ensures models with large output
        // limits (e.g., 128K for Claude Opus, GPT-5) are fully utilized,
        // while using ESCALATED_MAX_TOKENS (64K) as a floor for unknown
        // models.
        // Placed outside the retry loop so that any errors from the
        // escalated stream propagate directly (not caught by retry logic).
        if (
          lastError === null &&
          lastFinishReason === FinishReason.MAX_TOKENS &&
          !maxTokensEscalated &&
          !hasUserMaxTokensOverride
        ) {
          maxTokensEscalated = true;
          const escalatedLimit = Math.max(
            ESCALATED_MAX_TOKENS,
            tokenLimit(model, 'output'),
          );
          debugLogger.info(
            `Output truncated at capped default. Escalating to ${escalatedLimit} tokens.`,
          );
          // Remove partial model response from history
          // (processStreamResponse already pushed it)
          if (
            self.history.length > 0 &&
            self.history[self.history.length - 1].role === 'model'
          ) {
            self.history.pop();
          }
          // Signal UI to discard partial output
          yield { type: StreamEventType.RETRY };
          // Retry with escalated max_tokens
          const escalatedParams: SendMessageParameters = {
            ...params,
            config: {
              ...params.config,
              maxOutputTokens: escalatedLimit,
            },
          };
          let escalatedFinishReason: string | undefined;
          const escalatedStream = await self.makeApiCallAndProcessStream(
            model,
            requestContents,
            escalatedParams,
            prompt_id,
          );
          for await (const chunk of escalatedStream) {
            const fr = chunk.candidates?.[0]?.finishReason;
            if (fr) escalatedFinishReason = fr;
            yield { type: StreamEventType.CHUNK, value: chunk };
          }

          // Recovery: if the escalated response is also truncated, keep the
          // partial response in history and inject a recovery message so the
          // model can continue from where it left off.
          let recoveryCount = 0;
          let successfulRecoveries = 0;
          while (
            escalatedFinishReason === FinishReason.MAX_TOKENS &&
            recoveryCount < MAX_OUTPUT_RECOVERY_ATTEMPTS
          ) {
            // Skip recovery when the truncated turn already contains a
            // functionCall. Injecting a plain user message between a
            // functionCall and its functionResponse produces an invalid API
            // sequence that providers commonly reject. The existing layer-3
            // tool scheduler fallback handles these cases correctly.
            const lastEntry = self.history[self.history.length - 1];
            const hasFunctionCall =
              lastEntry?.role === 'model' &&
              lastEntry.parts?.some((p) => p.functionCall) === true;
            if (hasFunctionCall) {
              debugLogger.info(
                'Skipping recovery: truncated turn contains functionCall; ' +
                  'deferring to tool scheduler fallback.',
              );
              break;
            }

            recoveryCount++;
            debugLogger.info(
              `Output still truncated after escalation. ` +
                `Recovery attempt ${recoveryCount}/${MAX_OUTPUT_RECOVERY_ATTEMPTS}.`,
            );
            // The partial model response is already in history
            // (pushed by processStreamResponse). Push a recovery user
            // message so the model sees its partial output and continues.
            self.history.push(
              createUserContent([
                { text: buildOutputRecoveryMessage(lastEntry) },
              ]),
            );
            // Signal UI/turn to clear pending (incomplete) tool calls.
            // isContinuation tells the UI to keep the text buffer so the
            // model's continuation appends to the previous partial output.
            yield { type: StreamEventType.RETRY, isContinuation: true };
            // Re-send with the updated history (includes partial + recovery)
            const recoveryContents = self.getRequestHistory();
            escalatedFinishReason = undefined;
            try {
              const recoveryStream = await self.makeApiCallAndProcessStream(
                model,
                recoveryContents,
                escalatedParams,
                prompt_id,
              );
              for await (const chunk of recoveryStream) {
                const fr = chunk.candidates?.[0]?.finishReason;
                if (fr) escalatedFinishReason = fr;
                yield { type: StreamEventType.CHUNK, value: chunk };
              }
              // Iteration fully succeeded: both the user recovery turn and
              // the model continuation turn are now in history and can be
              // coalesced back into the preceding model entry after the loop.
              successfulRecoveries++;
            } catch (recoveryError) {
              // If a recovery attempt fails (e.g., empty response, network
              // error), stop recovering and let the partial output stand.
              // Pop the dangling recovery message to keep history valid.
              if (
                self.history.length > 0 &&
                self.history[self.history.length - 1].role === 'user'
              ) {
                self.history.pop();
              }
              debugLogger.warn(
                `Recovery attempt ${recoveryCount} failed: ${recoveryError}`,
              );
              // Emit a synthetic finish-reason chunk so the UI gets a
              // terminal signal (Finished event) instead of a partial
              // response with no end marker. Uses STOP because partial
              // chunks from prior successful iterations are already in
              // the transcript and represent the user-visible response.
              yield {
                type: StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: { role: 'model', parts: [] },
                      finishReason: FinishReason.STOP,
                    },
                  ],
                } as unknown as GenerateContentResponse,
              };
              break;
            }
          }

          // Coalesce completed recovery pairs back into the preceding model
          // turn so the OUTPUT_RECOVERY_MESSAGE control prompt does not
          // persist as a synthetic user turn in durable history. The user
          // never sent that message, and leaving it in history would bias
          // later turns and pollute compression / replay / export.
          if (successfulRecoveries > 0) {
            self.coalesceRecoveryPairs(successfulRecoveries);
          }
        }

        if (lastError) {
          if (lastError instanceof InvalidStreamError) {
            const totalAttempts = invalidStreamRetryCount + 1;
            logContentRetryFailure(
              self.config,
              new ContentRetryFailureEvent(
                totalAttempts,
                lastError.type,
                model,
              ),
            );
          }
          throw lastError;
        }
      } finally {
        streamDoneResolver!();
      }
    })();
  }

  private async makeApiCallAndProcessStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const apiCall = () =>
      this.config.getContentGenerator().generateContentStream(
        {
          model,
          contents: requestContents,
          config: { ...this.generationConfig, ...params.config },
        },
        prompt_id,
      );
    const streamResponse = await retryWithBackoff(apiCall, {
      shouldRetryOnError: (error: unknown) => {
        if (error instanceof Error) {
          if (isSchemaDepthError(error.message)) return false;
          if (isInvalidArgumentError(error.message)) return false;
        }

        const status = getErrorStatus(error);
        if (status === 400) return false;
        if (status === 429) return true;
        if (status && status >= 500 && status < 600) return true;

        return false;
      },
      authType: this.config.getContentGeneratorConfig()?.authType,
      persistentMode: isUnattendedMode(),
      signal: params.config?.abortSignal,
      heartbeatFn: (info) => {
        process.stderr.write(
          `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
        );
      },
    });

    return this.processStreamResponse(model, streamResponse);
  }

  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   * empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   * history.
   * @return History contents alternating between user and model for the entire
   * chat session.
   */
  getHistory(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    // Deep copy the history to avoid mutating the history outside of the
    // chat session.
    return structuredClone(history);
  }

  /**
   * Returns a deep-copied tail of the chat history. This avoids cloning the
   * entire session when callers only need recent context.
   */
  getHistoryTail(count: number, curated: boolean = false): Content[] {
    if (count <= 0) return [];
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    return structuredClone(history.slice(-count));
  }

  /**
   * Returns a shallow copy of the history and each entry's parts array without
   * cloning large part payloads. Use only for read-only consumers or consumers
   * that replace touched entries before mutating them.
   */
  getHistoryShallow(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    return history.map(copyContentContainer);
  }

  /**
   * Shallow tail variant for hot paths that only need recent history.
   */
  getHistoryTailShallow(count: number, curated: boolean = false): Content[] {
    if (count <= 0) return [];
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    return history.slice(-count).map(copyContentContainer);
  }

  /**
   * Returns a defensive copy of the last raw history entry without cloning the
   * full conversation. This avoids O(history) cloning, though cloning the last
   * entry is still proportional to that entry's own size.
   */
  getLastHistoryEntry(): Content | undefined {
    return this.getHistoryTail(1)[0];
  }

  /**
   * Returns the last raw history entry for read-only checks. Callers must not
   * mutate the returned object.
   */
  peekLastHistoryEntry(): Content | undefined {
    return this.history.at(-1);
  }

  /**
   * Returns concatenated text from the last model entry without cloning the
   * full history. Used by stop hooks, where only the latest assistant text is
   * needed.
   */
  getLastModelMessageText(): string | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i];
      if (message?.role !== 'model') continue;
      const text =
        message.parts
          ?.filter(
            (part): part is { text: string } => typeof part.text === 'string',
          )
          .map((part) => part.text)
          .join('') ?? '';
      return text || undefined;
    }
    return undefined;
  }

  /**
   * Returns the number of entries in the raw chat history. O(1) and
   * does not clone — use this when you only need the count and would
   * otherwise pay the {@link getHistory} `structuredClone` cost.
   */
  getHistoryLength(): number {
    return this.history.length;
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Adds a new entry to the chat history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
  }

  setHistory(history: Content[]): void {
    this.history = history;
  }

  truncateHistory(keepCount: number): void {
    this.history = this.history.slice(0, keepCount);
  }

  stripThoughtsFromHistory(): void {
    this.history = this.history
      .map(stripThoughtPartsFromContent)
      .filter((content): content is Content => content !== null);
  }

  /**
   * Pop all orphaned trailing user entries from chat history.
   * In a valid conversation the last entry is always a model response;
   * any trailing user entries are leftovers from a request that failed.
   */
  stripOrphanedUserEntriesFromHistory(): void {
    while (
      this.history.length > 0 &&
      this.history[this.history.length - 1]!.role === 'user'
    ) {
      this.history.pop();
    }
  }

  setTools(tools: Tool[]): void {
    this.generationConfig.tools = tools;
  }

  /** Returns a shallow copy of the current generation config (for cache param snapshots). */
  getGenerationConfig(): GenerateContentConfig {
    return { ...this.generationConfig };
  }

  async maybeIncludeSchemaDepthContext(error: StructuredError): Promise<void> {
    // Check for potentially problematic cyclic tools with cyclic schemas
    // and include a recommendation to remove potentially problematic tools.
    if (
      isSchemaDepthError(error.message) ||
      isInvalidArgumentError(error.message)
    ) {
      const toolRegistry = this.config.getToolRegistry();
      await toolRegistry.warmAll();
      const tools = toolRegistry.getAllTools();
      const cyclicSchemaTools: string[] = [];
      for (const tool of tools) {
        if (
          (tool.schema.parametersJsonSchema &&
            hasCycleInSchema(tool.schema.parametersJsonSchema)) ||
          (tool.schema.parameters && hasCycleInSchema(tool.schema.parameters))
        ) {
          cyclicSchemaTools.push(tool.displayName);
        }
      }
      if (cyclicSchemaTools.length > 0) {
        const extraDetails =
          `\n\nThis error was probably caused by cyclic schema references in one of the following tools, try disabling them with excludeTools:\n\n - ` +
          cyclicSchemaTools.join(`\n - `) +
          `\n`;
        error.message += extraDetails;
      }
    }
  }

  private async *processStreamResponse(
    model: string,
    streamResponse: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    // Collect ALL parts from the model response (including thoughts for recording)
    const allModelParts: Part[] = [];
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

    let hasToolCall = false;
    let hasFinishReason = false;

    for await (const chunk of streamResponse) {
      // Use ||= to avoid later usage-only chunks (no candidates) overwriting
      // a finishReason that was already seen in an earlier chunk.
      hasFinishReason ||=
        chunk?.candidates?.some((candidate) => candidate.finishReason) ?? false;

      if (isValidResponse(chunk)) {
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          if (content.parts.some((part) => part.functionCall)) {
            hasToolCall = true;
          }

          // Collect all parts for recording
          allModelParts.push(...content.parts);
        }
      }

      // Collect token usage for consolidated recording
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
        // Context usage tracks prompt size; output isn't in history yet.
        const lastPromptTokenCount =
          usageMetadata.promptTokenCount || usageMetadata.totalTokenCount;
        if (lastPromptTokenCount) {
          // Always update the per-chat counter so this chat (including
          // subagents) can make its own compaction decisions.
          this.lastPromptTokenCount = lastPromptTokenCount;
          // Mirror to the global telemetry only when wired — subagents
          // pass `telemetryService=undefined` to keep their context usage
          // out of the main session's UI counters.
          this.telemetryService?.setLastPromptTokenCount(lastPromptTokenCount);
        }
        if (usageMetadata.cachedContentTokenCount && this.telemetryService) {
          this.telemetryService.setLastCachedContentTokenCount(
            usageMetadata.cachedContentTokenCount,
          );
        }
      }

      yield chunk; // Yield every chunk to the UI immediately.
    }

    let thoughtContentPart: Part | undefined;
    const thoughtText = allModelParts
      .filter((part) => part.thought)
      .map((part) => part.text)
      .join('')
      .trim();

    if (thoughtText !== '') {
      thoughtContentPart = {
        text: thoughtText,
        thought: true,
      };

      const thoughtSignature = allModelParts.filter(
        (part) => part.thoughtSignature && part.thought,
      )?.[0]?.thoughtSignature;
      if (thoughtContentPart && thoughtSignature) {
        thoughtContentPart.thoughtSignature = thoughtSignature;
      }
    }

    const contentParts = allModelParts.filter((part) => !part.thought);
    const consolidatedHistoryParts: Part[] = [];
    for (const part of contentParts) {
      const lastPart =
        consolidatedHistoryParts[consolidatedHistoryParts.length - 1];
      if (
        lastPart?.text &&
        isValidNonThoughtTextPart(lastPart) &&
        isValidNonThoughtTextPart(part)
      ) {
        lastPart.text += part.text;
      } else if (isValidContentPart(part)) {
        consolidatedHistoryParts.push(part);
      }
    }

    const contentText = consolidatedHistoryParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('')
      .trim();

    // Record assistant turn with raw Content and metadata
    if (thoughtContentPart || contentText || hasToolCall || usageMetadata) {
      const contextWindowSize =
        this.config.getContentGeneratorConfig()?.contextWindowSize;
      this.chatRecordingService?.recordAssistantTurn({
        model,
        message: [
          ...(thoughtContentPart ? [thoughtContentPart] : []),
          ...(contentText ? [{ text: contentText }] : []),
          ...(hasToolCall
            ? contentParts
                .map(redactStructuredOutputArgsForRecording)
                .filter(
                  (
                    p,
                  ): p is { functionCall: NonNullable<Part['functionCall']> } =>
                    p !== null,
                )
            : []),
        ],
        tokens: usageMetadata,
        contextWindowSize,
      });
    }

    // Stream validation logic: A stream is considered successful if:
    // 1. There's a tool call (tool calls can end without explicit finish reasons), OR
    // 2. There's a finish reason AND we have non-empty response text or thought text
    //
    // We throw an error only when there's no tool call AND:
    // - No finish reason, OR
    // - Empty response text (e.g., no actual content and no thoughts)
    //
    // Note: Thoughts-only responses are valid for models that use thinking modes
    // These models may send only reasoning content without explicit text output.
    const hasAnyContent = contentText || thoughtText;
    if (!hasToolCall && (!hasFinishReason || !hasAnyContent)) {
      if (!hasFinishReason) {
        throw new InvalidStreamError(
          'Model stream ended without a finish reason.',
          'NO_FINISH_REASON',
        );
      } else {
        throw new InvalidStreamError(
          'Model stream ended with empty response text.',
          'NO_RESPONSE_TEXT',
        );
      }
    }

    this.history.push({
      role: 'model',
      parts: [
        ...(thoughtContentPart ? [thoughtContentPart] : []),
        ...consolidatedHistoryParts,
      ],
    });
  }

  /**
   * Merge `pairCount` trailing (user_recovery, model_continuation) pairs back
   * into the model turn that precedes them. Used after the output-token
   * recovery loop so the internal OUTPUT_RECOVERY_MESSAGE control prompt
   * does not persist in durable history as if the user sent it.
   *
   * Expected tail shape per iteration (walking from the back):
   *   [..., precedingModel, userRecovery, modelContinuation]
   *
   * If any pair doesn't match that shape the method bails defensively
   * rather than corrupting history.
   */
  private coalesceRecoveryPairs(pairCount: number): void {
    for (let i = 0; i < pairCount; i++) {
      const len = this.history.length;
      if (len < 3) return;

      const modelContinuation = this.history[len - 1]!;
      const userRecovery = this.history[len - 2]!;
      const precedingModel = this.history[len - 3]!;

      if (
        modelContinuation.role !== 'model' ||
        userRecovery.role !== 'user' ||
        precedingModel.role !== 'model'
      ) {
        return;
      }

      precedingModel.parts = appendRecoveryContinuationParts(
        precedingModel.parts,
        modelContinuation.parts,
      );
      // Drop the (userRecovery, modelContinuation) pair.
      this.history.splice(len - 2, 2);
    }
  }
}

/** Visible for Testing */
export function isSchemaDepthError(errorMessage: string): boolean {
  return errorMessage.includes('maximum schema depth exceeded');
}

export function isInvalidArgumentError(errorMessage: string): boolean {
  return errorMessage.includes('Request contains an invalid argument');
}
