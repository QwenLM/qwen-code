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
import { classifyRetryError } from '../utils/retryErrorClassification.js';
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
  logApiRetry,
  logChatCompression,
} from '../telemetry/loggers.js';
import { clearDetailedSpanState } from '../telemetry/detailed-span-attributes.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { type ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ChatCompressionService,
  computeThresholds,
  MAX_CONSECUTIVE_FAILURES,
  type CompactTrigger,
} from '../services/chatCompressionService.js';
import { acquireSleepInhibitor } from '../services/sleepInhibitor.js';
import { resolveSlimmingConfig } from '../services/compactionInputSlimming.js';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from '../services/tokenEstimation.js';
import {
  microcompactHistory,
  type MicrocompactMeta,
} from '../services/microcompaction/microcompact.js';
import {
  ContentRetryEvent,
  ContentRetryFailureEvent,
  ApiRetryEvent,
  makeChatCompressionEvent,
} from '../telemetry/types.js';
import type { UiTelemetryService } from '../telemetry/uiTelemetry.js';
import { type ChatCompressionInfo, CompressionStatus } from './turn.js';
import { getContextLengthExceededInfo } from '../utils/contextLengthError.js';
import { isSystemReminderContent } from '../utils/environmentContext.js';
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
    status === CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR ||
    status === CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED
  );
}

function shouldStopAfterHardRescue(
  shouldForceFromHard: boolean,
  hardLimit: number,
  localPromptTokensAfterCompression: number,
): boolean {
  return shouldForceFromHard && localPromptTokensAfterCompression >= hardLimit;
}

function getHardRescueFailureMessage(
  effectiveTokens: number,
  hardLimit: number,
  compressionInfo: ChatCompressionInfo,
  localPromptTokensAfterCompression: number,
): string {
  const compressionStatus =
    CompressionStatus[compressionInfo.compressionStatus] ??
    String(compressionInfo.compressionStatus);
  const tokenCount =
    compressionInfo.compressionStatus === CompressionStatus.COMPRESSED
      ? Math.max(
          compressionInfo.newTokenCount,
          localPromptTokensAfterCompression,
        )
      : Math.max(effectiveTokens, localPromptTokensAfterCompression);
  return (
    `Context is too large to send safely after automatic compression. ` +
    `Estimated prompt tokens: ${tokenCount}; hard limit: ${hardLimit}; ` +
    `compression status: ${compressionStatus}. ` +
    `Start a new session or reduce the resumed history before continuing.`
  );
}

/**
 * Defensive coercion for API-reported token counts.
 *
 * Hostile providers (broken upstream, OpenAI-compat proxy returning
 * `null`/`NaN`, misconfigured override) can yield non-finite or negative
 * token counts on `usageMetadata`. This function coerces the four fields that
 * feed the compaction gate, its cache-hit telemetry, or OTel spans —
 * `promptTokenCount`, `totalTokenCount`, `candidatesTokenCount`, and
 * `cachedContentTokenCount`. Letting hostile values
 * flow into the compaction gate arithmetic is catastrophic:
 *
 * - `lastPromptTokenCount + NaN >= hard` is always false → hard-rescue is
 *   silently disabled, eventually OOMing the V8 heap.
 * - `Infinity >= hard` is always true → hard-rescue fires on every send.
 *
 * Coercing unknown / negative / non-finite to `0` keeps the gate well-defined
 * and is a no-op for any provider returning sane values.
 *
 * `Number.isFinite(-1)` is `true`, so the explicit `>= 0` check is required
 * in addition to `isFinite`.
 */
function coerceUsageCount(value: unknown, field?: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (value != null && field) {
    debugLogger.warn(
      `coerceUsageCount: hostile ${field}=${String(value)}, coercing to 0`,
    );
  }
  return 0;
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
  /**
   * Pending user message about to be sent. Threaded through to the
   * compression service's cheap-gate so it can see the real prompt size
   * even when `lastPromptTokenCount === 0` (first send after inherited
   * history). See `estimatePromptTokens` for the fallback math.
   */
  pendingUserMessage?: Content;
  /**
   * Pre-computed `estimatePromptTokens` value from the caller. When set,
   * the cheap-gate uses this instead of recomputing — avoids a second
   * `getHistory(true)` clone per send. (review #4168 R1.3 / R1.4)
   */
  precomputedEffectiveTokens?: number;
  /**
   * Delay writing the compression checkpoint until the caller has run any
   * post-compression guards that may roll the in-memory chat state back.
   */
  deferChatCompressionRecord?: boolean;
  /**
   * Forwarded to the compression side-query system prompt. Sourced from
   * `/compress <text>` invocation arg; appended after the base prompt as
   * an `Additional Instructions:` block so the summary model can focus
   * on the user's stated concern.
   */
  customInstructions?: string;
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
      appendCuratedContent(curatedHistory, comprehensiveHistory[i]);
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

function appendCuratedContent(
  curatedHistory: Content[],
  content: Content,
): void {
  const lastIndex = curatedHistory.length - 1;
  const lastContent = lastIndex >= 0 ? curatedHistory[lastIndex] : undefined;

  if (content.role === 'user' && lastContent?.role === 'user') {
    curatedHistory[lastIndex] = {
      ...lastContent,
      parts: [...(lastContent.parts ?? []), ...(content.parts ?? [])],
    };
    return;
  }

  curatedHistory.push(content);
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
 * Default error text used when a synthesized `functionResponse` has to stand
 * in for a real tool result that never made it back into history (e.g. the
 * process crashed between the partial-tool_use push and tool completion, or
 * the user hit Ctrl+Y before the in-flight tool finished and the scheduler's
 * `onAllToolCallsComplete` was a single-shot that already fired into an
 * `isResponding` early-return).
 */
const ORPHAN_TOOL_USE_REPAIR_REASON =
  'Tool execution result was not recorded — likely interrupted by network ' +
  'failure, abort, or process exit. Treat as failure and retry if needed.';

/*
 * ============================================================================
 * Partial-tool_use repair subsystem — canonical design note.
 * ============================================================================
 *
 * Every comment block elsewhere in this file that mentions one of the
 * concepts below points back here. Per-site comments should be one or two
 * lines stating WHAT the local code does; the WHY lives here.
 *
 * --- The wedge ----------------------------------------------------------
 *
 * Anthropic-compatible backends (Anthropic, DeepSeek, …) reject a request
 * whose `user[tool_result]` blocks are not at the HEAD of the user message
 * immediately following the `model[tool_use]` they answer:
 *
 *     "tool_use_id ... must have a corresponding tool_use block in the
 *      previous message"
 *
 * Without a matching pair the session is unrecoverable — `stripOrphanedUser
 * EntriesFromHistory` only strips trailing user entries, so a lost tool_use
 * cannot be resurrected and the next send 400s repeatedly.
 *
 * --- The race classes that produce dangling tool_uses --------------------
 *
 *   Race A (Ctrl+Y mid-flight): user retries before the in-flight tool
 *     finishes. The scheduler's `onAllToolCallsComplete` is single-shot
 *     per batch and would otherwise leave the tool stuck in
 *     `completed-but-not-submitted` forever.
 *   Race B (process crash / OOM mid-flight): the JSONL transcript captures
 *     the dangling `model[fc]` and `--resume` rehydrates it.
 *   Race C (network drop between `content_block_stop` of a tool_use and
 *     the terminal `message_stop`): `processStreamResponse` re-throws
 *     after we have already yielded a `functionCall` chunk, so the React
 *     scheduler is on its way to submit a real `functionResponse` while
 *     in-memory history has no matching `model[fc]`.
 *
 * --- The two-layer fix ---------------------------------------------------
 *
 *   (1) Persist the partial assistant turn at the failure point in
 *       `processStreamResponse` (`this.history.push({role: 'model', parts:
 *       [...]})` plus the `pendingPartialAssistantTurnIndex` /
 *       `pendingPartialAssistantRecord` markers) so the matching
 *       `model[fc]` is on disk and in memory when the late `user[fr]`
 *       arrives.
 *   (2) Repair any remaining dangling `model[fc]` whose
 *       `user[fr]` never landed (`repairOrphanedToolUseTurns`):
 *         - SYNTHESIZE an `error` fr for ids with no matching response;
 *         - HOIST the real fr into the immediately-adjacent user turn
 *           when it landed in a non-adjacent later turn;
 *         - DROP duplicate fr copies for the same id.
 *       Then `useGeminiStream.handleCompletedTools` dedupes the
 *       scheduler's late real result against `chat.history` so the
 *       synthetic and the real result never collide on the wire.
 *
 * --- Partial-push marker lifecycle ---------------------------------------
 *
 * Set together on (streamError + hasToolCall + hasContent) inside
 * `processStreamResponse`. Cleared together by `popPartialIfPushed` on a
 * retryable error rollback, or flushed together to JSONL by the outer
 * `finally` after the retry loop exits. Defense-in-depth: every
 * history-mutation method (clearHistory / addHistory / setHistory /
 * truncateHistory / stripThoughtsFromHistory /
 * stripOrphanedUserEntriesFromHistory) resets both markers in lockstep so
 * a stale index can't shift onto an unrelated model turn and cause
 * `popPartialIfPushed` to splice the wrong entry. Any single-field reset
 * is a bug.
 * ============================================================================
 */

/**
 * Walk `history` left-to-right and close every dangling
 * tool_use ↔ tool_result pair. For each `model[functionCall]`:
 *  - SYNTHESIZE an `error` `functionResponse` for ids with no match;
 *  - HOIST a real fr from a non-adjacent later user turn into the
 *    adjacent one;
 *  - drop duplicate fr copies for the same id.
 *
 * Mutates `history` in place. Returns the synthesized (callId, name)
 * pairs so the React scheduler's dedup can drop late real results for
 * those ids; hoisted ids are NOT returned (the real fr is still in
 * history, scheduler dedup handles them naturally). See the canonical
 * note above `ORPHAN_TOOL_USE_REPAIR_REASON`. qwen-code analogue of
 * upstream Claude Code's `yieldMissingToolResultBlocks`.
 */
/** Location of a `functionResponse` part within `history`. */
interface FrLocation {
  turnIdx: number;
  partIdx: number;
  part: Part;
}

/**
 * Output of the scan phase for a single `model[functionCall]` turn at
 * `modelIdx`. `expected` maps each `functionCall.id` to its tool name,
 * `matched` maps that same id to ALL locations of matching
 * `functionResponse` parts across the consecutive user turns that
 * follow, and `scanEnd` is one past the last user turn visited.
 */
interface ScanResult {
  modelIdx: number;
  expected: Map<string, string>;
  matched: Map<string, FrLocation[]>;
  scanEnd: number;
}

/** Decision-phase output: exact mutations the next phase will apply. */
interface RepairPlan {
  modelIdx: number;
  scanEnd: number;
  synthesizeIds: Array<[string, string]>;
  hoistedParts: Part[];
  removalTargets: Array<{ turnIdx: number; partIdx: number }>;
  droppedDuplicates: Array<{ callId: string; name: string }>;
}

/**
 * SCAN — collect every `functionCall.id → name` from the model turn at
 * `modelIdx` and EVERY `functionResponse.id → location` from the
 * consecutive user turns that follow. Pure read. Storing all locations
 * (not just the first) is what lets the decision phase drop duplicates.
 */
function scanModelTurn(history: Content[], modelIdx: number): ScanResult {
  const expected = new Map<string, string>();
  for (const part of history[modelIdx]?.parts ?? []) {
    const fc = part.functionCall;
    if (fc?.id) expected.set(fc.id, fc.name ?? 'unknown');
  }

  const matched = new Map<string, FrLocation[]>();
  let scanIdx = modelIdx + 1;
  while (scanIdx < history.length && history[scanIdx]?.role === 'user') {
    const parts = history[scanIdx].parts ?? [];
    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx];
      const id = part.functionResponse?.id;
      if (id) {
        const list = matched.get(id);
        if (list) list.push({ turnIdx: scanIdx, partIdx: pIdx, part });
        else matched.set(id, [{ turnIdx: scanIdx, partIdx: pIdx, part }]);
      }
    }
    scanIdx++;
  }

  return { modelIdx, expected, matched, scanEnd: scanIdx };
}

/**
 * DECISION — classify each expected id: no match → SYNTHESIZE; first
 * match adjacent → SKIP relocation; first match non-adjacent → HOIST.
 * Every duplicate beyond the first is always dropped. Pure compute.
 */
function planRepair(scan: ScanResult): RepairPlan {
  const synthesizeIds: Array<[string, string]> = [];
  const hoistedParts: Part[] = [];
  const removalTargets: Array<{ turnIdx: number; partIdx: number }> = [];
  const droppedDuplicates: Array<{ callId: string; name: string }> = [];

  const adjacentIdx = scan.modelIdx + 1;
  for (const [id, name] of scan.expected) {
    const locations = scan.matched.get(id);
    if (!locations || locations.length === 0) {
      synthesizeIds.push([id, name]);
      continue;
    }
    // First copy is the canonical survivor — payloads should be
    // identical for the same callId; if they differ, the wire is
    // already corrupt and the backend rejects regardless.
    const survivor = locations[0]!;
    if (survivor.turnIdx !== adjacentIdx) {
      hoistedParts.push(survivor.part);
      removalTargets.push({
        turnIdx: survivor.turnIdx,
        partIdx: survivor.partIdx,
      });
    }
    for (let k = 1; k < locations.length; k++) {
      removalTargets.push({
        turnIdx: locations[k]!.turnIdx,
        partIdx: locations[k]!.partIdx,
      });
      droppedDuplicates.push({ callId: id, name });
    }
  }

  return {
    modelIdx: scan.modelIdx,
    scanEnd: scan.scanEnd,
    synthesizeIds,
    hoistedParts,
    removalTargets,
    droppedDuplicates,
  };
}

/**
 * MUTATION — apply the plan to `history` in place. Returns the count
 * of new user turns inserted ahead of `modelIdx + 1` (0 or 1) so the
 * outer loop can advance its cursor.
 *
 * Order: (1) splice removal targets desc-by-desc, (2) drop empty user
 * turns in `[modelIdx + 2, scanEnd)`, (3) HEAD-insert at the adjacent
 * user turn OR splice a new user turn between. The HEAD insert is
 * load-bearing (mirrors upstream `hoistToolResults`) — see the
 * canonical note for why tail-append re-triggers the wedge.
 */
function applyRepair(
  history: Content[],
  plan: RepairPlan,
  reason: string,
): { insertedBefore: number } {
  if (plan.synthesizeIds.length === 0 && plan.removalTargets.length === 0) {
    return { insertedBefore: 0 };
  }

  const syntheticParts: Part[] = plan.synthesizeIds.map(([callId, name]) => ({
    functionResponse: { id: callId, name, response: { error: reason } },
  }));
  const partsToInject: Part[] = [...syntheticParts, ...plan.hoistedParts];

  // (1) Splice removal targets, descending so indices stay valid.
  const removals = [...plan.removalTargets].sort((a, b) => {
    if (a.turnIdx !== b.turnIdx) return b.turnIdx - a.turnIdx;
    return b.partIdx - a.partIdx;
  });
  for (const loc of removals) {
    const turnParts = history[loc.turnIdx].parts;
    if (turnParts) turnParts.splice(loc.partIdx, 1);
  }

  // (2) Drop now-empty user turns within [modelIdx + 2, scanEnd).
  // Preserve the adjacent turn even if empty — we'll rewrite it
  // below.
  const adjacentIdx = plan.modelIdx + 1;
  for (let j = plan.scanEnd - 1; j > adjacentIdx; j--) {
    if (history[j]?.role === 'user' && (history[j].parts?.length ?? 0) === 0) {
      history.splice(j, 1);
    }
  }

  // (3) Place new parts at the head of the adjacent user turn, OR
  // insert a fresh user turn between this model turn and whatever
  // follows.
  const next = history[adjacentIdx];
  if (next?.role === 'user') {
    const existing = next.parts ?? [];
    const firstNonFr = existing.findIndex((part) => !part.functionResponse);
    const insertAt = firstNonFr === -1 ? existing.length : firstNonFr;
    next.parts = [
      ...existing.slice(0, insertAt),
      ...partsToInject,
      ...existing.slice(insertAt),
    ];
    return { insertedBefore: 0 };
  }
  history.splice(adjacentIdx, 0, { role: 'user', parts: partsToInject });
  return { insertedBefore: 1 };
}

/**
 * Forward-walk `history`, planning and applying the repair for each
 * `model[functionCall]` turn in turn. Iteration is index-based and the
 * cursor advances by the count of user turns inserted ahead of it so
 * a freshly-injected turn isn't re-visited.
 *
 * Splitting scan / decision / mutation into separate functions keeps
 * each phase auditable in isolation — index drift can only happen in
 * `applyRepair`, the only function that mutates `history`.
 */
export function repairOrphanedToolUseTurns(
  history: Content[],
  reason: string = ORPHAN_TOOL_USE_REPAIR_REASON,
): {
  injected: Array<{ callId: string; name: string }>;
  droppedDuplicates: Array<{ callId: string; name: string }>;
} {
  const injected: Array<{ callId: string; name: string }> = [];
  const droppedDuplicates: Array<{ callId: string; name: string }> = [];

  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'model') continue;

    const scan = scanModelTurn(history, i);
    if (scan.expected.size === 0) continue;

    const plan = planRepair(scan);
    if (plan.synthesizeIds.length === 0 && plan.removalTargets.length === 0) {
      continue;
    }

    const { insertedBefore } = applyRepair(history, plan, reason);
    // Only synthesized ids feed `injected` — hoisted ids reference real
    // frs that were ALREADY in history before this pass (just
    // relocated), so the scheduler's dedup naturally handles them.
    for (const [callId, name] of plan.synthesizeIds) {
      injected.push({ callId, name });
    }
    droppedDuplicates.push(...plan.droppedDuplicates);
    // Advance past any freshly-inserted user turn so the outer loop
    // doesn't revisit it. Keeps the walk linear-time.
    i += insertedBefore;
  }

  return { injected, droppedDuplicates };
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
   * Number of consecutive auto-compaction failures for this chat. The
   * cheap-gate NOOPs once this reaches MAX_CONSECUTIVE_FAILURES (default 3)
   * until a successful compress (forced or not) resets it to 0. Replaces the
   * single-shot hasFailedCompressionAttempt lock that previously disabled
   * auto-compaction for the rest of the session on any failure.
   *
   * SEMANTICS (R5.3): this counter tracks "non-force, non-hard-rescue
   * consecutive failures", NOT every failure literally.
   *   - Auto-compaction failures (cheap-gate path): increment by 1.
   *   - Manual `/compress` failures: skipped (`force=true` → `!force`
   *     guard in the failure branch).
   *   - Hard-tier rescue failures: skipped (force=true → `!force` guard
   *     in tryCompress's failure branch). The counter is NOT pre-reset
   *     before the rescue call — force=true already bypasses the breaker
   *     check in compress's cheap-gate, and pre-resetting would in fact
   *     defeat the breaker entirely (hard-rescue failures don't increment
   *     via tryCompress, and a pre-reset every send would wipe the
   *     reactive-overflow increment). The forwarded counter value is
   *     whatever the chat carried; on COMPRESSED success the post-call
   *     branch in tryCompress's COMPRESSED handler resets to 0, which is
   *     the correct recovery path for a previously-latched session.
   *     Reactive overflow remains the explicit-increment safety net for
   *     the force=true path — its handler bumps the counter by +1 so N
   *     reactive failures will still trip the breaker.
   *
   * If you're debugging "why is hard-rescue firing but the counter is 0",
   * that's by design.
   */
  private consecutiveFailures = 0;

  /**
   * Partial-push markers — index of the in-memory `model[partial fc]`
   * and the matching deferred JSONL record. See the canonical note
   * above `ORPHAN_TOOL_USE_REPAIR_REASON` for the lifecycle and the
   * wedge they prevent.
   */
  private pendingPartialAssistantTurnIndex: number | null = null;
  private pendingPartialAssistantRecord:
    | Parameters<ChatRecordingService['recordAssistantTurn']>[0]
    | null = null;

  /**
   * Reset both partial-push markers in lockstep. Every history-mutation
   * site uses this — single-field resets are a bug because the fields
   * are always paired by lifecycle.
   */
  private clearPendingPartialState(): void {
    this.pendingPartialAssistantTurnIndex = null;
    this.pendingPartialAssistantRecord = null;
  }

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
   * history, recorded the event to `chatRecordingService` (if wired and
   * unless `options.deferChatCompressionRecord` is set), and updated both
   * the per-chat token count and (when wired) the global telemetry singleton.
   * Deferred callers are responsible for recording after their own
   * post-compression guards pass.
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
      consecutiveFailures: this.consecutiveFailures,
      originalTokenCount:
        options?.originalTokenCountOverride ?? this.lastPromptTokenCount,
      pendingUserMessage: options?.pendingUserMessage,
      precomputedEffectiveTokens: options?.precomputedEffectiveTokens,
      trigger: options?.trigger,
      customInstructions: options?.customInstructions,
      signal,
    });

    if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
      if (!options?.deferChatCompressionRecord) {
        this.chatRecordingService?.recordChatCompression({
          info,
          compressedHistory: newHistory,
        });
      }
      this.setHistory(newHistory);
      debugLogger.debug('[FILE_READ_CACHE] clear after auto tryCompress');
      this.config.getFileReadCache().clear();
      clearDetailedSpanState();
      this.lastPromptTokenCount = info.newTokenCount;
      this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
      // Reset the consecutive-failure counter on success so a forced /compress
      // (or any successful compaction) recovers a chat whose breaker had
      // tripped.
      this.consecutiveFailures = 0;
    } else if (isCompressionFailureStatus(info.compressionStatus)) {
      // Track failed attempts (only count if not forced) so we stop spending
      // compression-API calls on a chat that can't shrink after
      // MAX_CONSECUTIVE_FAILURES strikes in a row.
      if (!force) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          debugLogger.warn(
            `[compaction] circuit breaker tripped after ${this.consecutiveFailures} consecutive failures (cheap-gate path); auto-compaction will NOOP until a successful force compaction resets the counter.`,
          );
        }
      }
    }

    return info;
  }

  /**
   * Fast, rule-based compression without any LLM side-query.
   *
   * Force-runs microcompaction (clear old tool results + media, keep recent N)
   * then strips thinking parts from all model turns.
   */
  compressFast(): {
    info: ChatCompressionInfo;
    microcompactMeta?: MicrocompactMeta;
  } {
    // Use the same estimator on both sides so the NOOP gate compares
    // apples to apples. The API-authoritative lastPromptTokenCount is
    // then adjusted by the estimated delta — never replaced wholesale.
    const beforeEstimate = estimateContentTokens(this.history);

    // Step 1: force microcompaction (clear old tool results + media)
    const mcResult = microcompactHistory(
      this.history,
      null,
      this.config.getClearContextOnIdle(),
      { force: true },
    );
    const mcMeta = mcResult.meta;

    // Step 2: strip thinking parts from model turns
    const newHistory = mcResult.history
      .map((c) => (c.role === 'model' ? stripThoughtPartsFromContent(c) : c))
      .filter((c): c is Content => c !== null);

    const afterEstimate = estimateContentTokens(newHistory);

    if (afterEstimate >= beforeEstimate) {
      const apiBaseline = this.lastPromptTokenCount || beforeEstimate;
      return {
        info: {
          originalTokenCount: apiBaseline,
          newTokenCount: apiBaseline,
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const reduction = beforeEstimate - afterEstimate;
    const apiBaseline = this.lastPromptTokenCount || beforeEstimate;
    const adjustedTokenCount = Math.max(0, apiBaseline - reduction);

    const info: ChatCompressionInfo = {
      originalTokenCount: apiBaseline,
      newTokenCount: adjustedTokenCount,
      compressionStatus: CompressionStatus.COMPRESSED,
      triggerReason: 'manual',
    };

    this.chatRecordingService?.recordChatCompression({
      info,
      compressedHistory: newHistory,
    });
    logChatCompression(
      this.config,
      makeChatCompressionEvent({
        tokens_before: info.originalTokenCount,
        tokens_after: info.newTokenCount,
      }),
    );
    this.setHistory(newHistory);
    clearDetailedSpanState();
    this.lastPromptTokenCount = adjustedTokenCount;
    this.telemetryService?.setLastPromptTokenCount(adjustedTokenCount);
    this.consecutiveFailures = 0;

    return { info, microcompactMeta: mcMeta };
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

    // Clear any partial-push marker left over from a prior unretryable
    // break path — the marker is per-send; carrying it across sends
    // would let the next send's retry catch wrongly pop a now-valid
    // model entry sitting at the stale index. The deferred-record
    // stash gets the same per-send reset for the same reason: a
    // leftover from a prior unretryable break would otherwise get
    // appended to JSONL by THIS send's retry-loop flush, attaching
    // someone else's failed turn to this conversation.
    this.clearPendingPartialState();

    let compressionInfo: ChatCompressionInfo;
    let requestContents: Content[];
    let userContentAdded = false;
    try {
      // The send-lock above is held but the generator's `finally` (which
      // resolves it) has not run yet. Any setup error before returning the
      // generator must release the lock or subsequent sends will block forever
      // at `await this.sendPromise`.
      // Build the user content BEFORE compression so the cheap-gate can size
      // the upcoming prompt — closes the "first send after inherited history"
      // gap where `lastPromptTokenCount === 0` and the gate would otherwise
      // see only the stale prior-turn count (0).
      const userContent = createUserContent(params.message);

      // Hard-tier rescue: when the estimated prompt size is at or above the
      // hard threshold (effectiveWindow - HARD_BUFFER), force compaction in
      // this send instead of waiting for the API to reject the request as too
      // large.
      //
      // We compute `effectiveTokens` ONCE here and pass it through to
      // tryCompress → service.compress so the cheap-gate doesn't redo the
      // estimation (which involves another `getHistory(true)` clone). This
      // reuse also fixes a per-config-knob inconsistency: previously the
      // hard-tier rescue used the default imageTokenEstimate while the
      // cheap-gate inside tryCompress used the user's resolved value.
      // (review #4168 R1.3 + R1.4)
      //
      // The consecutive-failure counter is NOT pre-reset here. force=true
      // already bypasses the breaker (the `!force` check in
      // `chatCompressionService.compress`'s cheap-gate), so a latched session
      // can still attempt hard-rescue; pre-resetting would defeat the breaker
      // entirely because hard-rescue failures don't increment via tryCompress
      // (force=true skips the `if (!force)` increment in the failure branch),
      // and only the reactive overflow handler explicitly increments. With a
      // pre-reset the counter would oscillate 0↔1 across sends and never trip.
      // On COMPRESSED success, the post-call branch in `tryCompress` (the
      // `consecutiveFailures = 0` line in the COMPRESSED handler) still resets
      // to 0, which is the correct recovery path for a previously-latched
      // session.
      const contextLimit =
        this.config.getContentGeneratorConfig()?.contextWindowSize ??
        DEFAULT_TOKEN_LIMIT;
      const { hard } = computeThresholds(contextLimit);
      const imageTokenEstimate = resolveSlimmingConfig(
        this.config.getChatCompression(),
      ).imageTokenEstimate;
      // When lastPromptTokenCount > 0, estimatePromptTokens uses the
      // API-authoritative count + a tiny estimate of just the new user
      // message — it does NOT touch the history at all in that branch, so
      // skip the costly `getHistory(true)` clone on the steady-state path.
      // The lastPromptTokenCount=0 branch (first send after --continue
      // restore / subagent inheritance) walks history with a char/4
      // heuristic that can under-count by ~15-20K tokens; the reactive
      // overflow recovery path inside the async iterator below (the
      // `getContextLengthExceededInfo` → `tryCompress` → RETRY branch)
      // is the documented safety net when this under-count causes
      // hard-rescue to miss.
      const effectiveTokens = estimatePromptTokens(
        this.lastPromptTokenCount > 0 ? [] : this.getHistoryShallow(true),
        userContent,
        this.lastPromptTokenCount,
        imageTokenEstimate,
      );
      const shouldForceFromHard = effectiveTokens >= hard;
      const historyBeforeHardRescue = shouldForceFromHard
        ? this.getHistoryShallow()
        : undefined;
      const lastPromptTokenCountBeforeHardRescue = this.lastPromptTokenCount;
      if (shouldForceFromHard) {
        debugLogger.warn(
          `[compaction] hard-tier rescue triggered: prompt_id=${prompt_id}, effectiveTokens=${effectiveTokens}, hard=${hard}, consecutiveFailures=${this.consecutiveFailures}.`,
        );
      }

      compressionInfo = await this.tryCompress(
        prompt_id,
        model,
        shouldForceFromHard,
        params.config?.abortSignal,
        {
          pendingUserMessage: userContent,
          precomputedEffectiveTokens: effectiveTokens,
          deferChatCompressionRecord: shouldForceFromHard,
          // Hard-rescue is force=true to bypass the cheap-gate breaker
          // but it remains a semantically AUTOMATIC trigger. Tag the
          // compactTrigger explicitly as 'auto' so the PostCompact
          // hook event fires with the correct trigger category (the
          // default `force=true → 'manual'` mapping would otherwise
          // misclassify it). The compress() service preserves a
          // trailing model+functionCall via
          // composePostCompactHistory's `trailingFunctionCallContent`
          // handling on its own, so the API request's tool-call /
          // response pairing stays intact regardless of trigger value.
          trigger: shouldForceFromHard ? 'auto' : undefined,
        },
      );

      const localPromptTokensAfterCompression = shouldForceFromHard
        ? estimatePromptTokens(
            this.lastPromptTokenCount > 0 ? [] : this.getHistoryShallow(true),
            userContent,
            this.lastPromptTokenCount,
            imageTokenEstimate,
          )
        : 0;
      if (
        shouldStopAfterHardRescue(
          shouldForceFromHard,
          hard,
          localPromptTokensAfterCompression,
        )
      ) {
        const message = getHardRescueFailureMessage(
          effectiveTokens,
          hard,
          compressionInfo,
          localPromptTokensAfterCompression,
        );
        if (
          compressionInfo.compressionStatus === CompressionStatus.COMPRESSED &&
          historyBeforeHardRescue
        ) {
          // Hard-rescue compression mutates in-memory history before this
          // guard can compare the compressed prompt size. If the compressed
          // prompt is still too large to send, restore the pre-compression
          // state. The JSONL compression checkpoint is intentionally not
          // written because the send is about to be rejected.
          this.setHistory(historyBeforeHardRescue);
          this.lastPromptTokenCount = lastPromptTokenCountBeforeHardRescue;
          this.telemetryService?.setLastPromptTokenCount(
            lastPromptTokenCountBeforeHardRescue,
          );
        }
        const compressionStatus =
          CompressionStatus[compressionInfo.compressionStatus] ??
          String(compressionInfo.compressionStatus);
        debugLogger.warn(
          `[compaction] hard-tier rescue stopped oversized prompt: ` +
            `prompt_id=${prompt_id}, effectiveTokens=${effectiveTokens}, ` +
            `hard=${hard}, localPromptTokensAfterCompression=` +
            `${localPromptTokensAfterCompression}, compressionStatus=` +
            `${compressionStatus}, newTokenCount=` +
            `${compressionInfo.newTokenCount}, consecutiveFailures=` +
            `${this.consecutiveFailures}. ${message}`,
        );
        throw new Error(message);
      }
      if (
        shouldForceFromHard &&
        compressionInfo.compressionStatus === CompressionStatus.COMPRESSED
      ) {
        this.chatRecordingService?.recordChatCompression({
          info: compressionInfo,
          compressedHistory: this.getHistoryShallow(),
        });
      }

      // Add user content to history ONCE before any attempts.
      this.history.push(userContent);
      userContentAdded = true;
      // Per-send orphan repair (belt-and-suspenders alongside the
      // startChat load-time pass). Runs AFTER user content lands so a
      // user-supplied tool_result closes the pair before we synthesize
      // anything. Logs are tagged so investigators can distinguish this
      // pass from the session-load pass and from the React scheduler's
      // dedup-drop. See the canonical note above
      // `ORPHAN_TOOL_USE_REPAIR_REASON`.
      const inlineRepair = repairOrphanedToolUseTurns(this.history);
      if (inlineRepair.injected.length > 0) {
        debugLogger.warn(
          `[REPAIR] sendMessageStream inline pass synthesized ` +
            `${inlineRepair.injected.length} functionResponse(s): ` +
            inlineRepair.injected
              .map((entry) => `${entry.name}(${entry.callId})`)
              .join(', '),
        );
      }
      if (inlineRepair.droppedDuplicates.length > 0) {
        debugLogger.warn(
          `[REPAIR] sendMessageStream inline pass dropped ` +
            `${inlineRepair.droppedDuplicates.length} duplicate ` +
            `functionResponse(s): ` +
            inlineRepair.droppedDuplicates
              .map((entry) => `${entry.name}(${entry.callId})`)
              .join(', '),
        );
      }
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
      const sleepInhibitorHandle = acquireSleepInhibitor(
        self.config,
        'Qwen Code is streaming a model response',
      );
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

            // If `processStreamResponse` persisted a partial assistant turn
            // (mid-stream error after a `functionCall` was already
            // yielded), every retry-and-continue path below must drop
            // that turn first; otherwise the retry's response lands as
            // a second consecutive model turn with an orphan tool_use
            // (the wedge — see the canonical note above
            // `ORPHAN_TOOL_USE_REPAIR_REASON`). Paths that `break`
            // (unretryable) keep the partial.
            const popPartialIfPushed = () => {
              const idx = self.pendingPartialAssistantTurnIndex;
              if (idx === null) return;
              if (
                self.history.length > idx &&
                self.history[idx]?.role === 'model'
              ) {
                self.history.splice(idx, 1);
              } else {
                // Marker was set but the entry it pointed at is gone or
                // is no longer a `model` turn. Today this can't happen:
                // every history-mutation path (clearHistory, addHistory,
                // setHistory, truncateHistory, stripThoughtsFromHistory,
                // stripOrphanedUserEntriesFromHistory) calls
                // clearPendingPartialState() in lockstep, so the marker
                // is null whenever the index basis is invalidated.
                // Logging the mismatch makes the invariant observable —
                // without this, a future caller that mutates history
                // without resetting the marker would silently leave a
                // stale partial in `this.history` (popPartialIfPushed
                // skipping the splice) AND the field-level invariant
                // that "marker non-null ⇒ a real partial sits at idx"
                // would be quietly violated. With the warn, anyone
                // investigating a stale-partial wedge sees a log line
                // pointing straight at the offending caller.
                debugLogger.warn(
                  `[PARTIAL_POP] Splice skipped: idx=${idx}, ` +
                    `historyLength=${self.history.length}, ` +
                    `roleAtIdx=${self.history[idx]?.role ?? 'undefined'}`,
                );
              }
              // Drop both markers in lockstep — the deferred chat-
              // recording record must be discarded alongside the
              // in-memory splice so the JSONL transcript also drops the
              // failed attempt. See the field-level comment on
              // `pendingPartialAssistantRecord` for the failure mode
              // this prevents.
              self.clearPendingPartialState();
            };

            // Handle rate-limit / throttling errors returned as stream content.
            // These arrive as StreamContentError with finish_reason="error_finish"
            // from the pipeline, containing the throttling message in the content.
            // Covers TPM throttling, GLM rate limits, and other provider throttling.
            const isRateLimit = isRateLimitError(error, extraRetryErrorCodes);
            if (isRateLimit) {
              const details = getRateLimitErrorDetails(error);
              const classification = classifyRetryError(error, {
                authType: cgConfig?.authType,
                extraRetryErrorCodes,
              });
              // The classifier is observation-only here; stream retry control
              // remains governed by isRateLimitError and the retry budget.
              const diagnosticFields = {
                classificationDiagnosis: classification.diagnosis,
                errorKind: classification.kind,
                classificationReason: classification.reason,
                ...details,
              };

              if (rateLimitRetryCount < maxRateLimitRetries) {
                // Discard any partial assistant turn from the failed attempt
                // before scheduling the retry, so a stale partial does not leak
                // into history or the JSONL transcript.
                popPartialIfPushed();
                rateLimitRetryCount++;
                const delayMs = getRateLimitRetryDelayMs(rateLimitRetryCount, {
                  ...RATE_LIMIT_RETRY_OPTIONS,
                  error,
                });
                const message = parseAndFormatApiError(
                  error instanceof Error ? error.message : String(error),
                );
                debugLogger.warn('Rate limit retry scheduled', {
                  retryPath: 'stream',
                  retryDecision: 'retry',
                  attempt: rateLimitRetryCount,
                  maxRetries: maxRateLimitRetries,
                  retryDelayMs: delayMs,
                  ...diagnosticFields,
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

              debugLogger.warn('Rate limit retry exhausted', {
                retryPath: 'stream',
                retryDecision: 'exhausted',
                attempts: rateLimitRetryCount,
                maxRetries: maxRateLimitRetries,
                ...diagnosticFields,
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
                    // No-op today: tryCompress's setHistory has already
                    // cleared the marker. Kept for uniformity with the
                    // other retry branches in case a future in-place
                    // tryCompress stops resetting it.
                    popPartialIfPushed();
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
                    // Reactive compression is force=true so tryCompress's
                    // failure branch did not increment the counter. Count it
                    // explicitly as one strike — a single transient error
                    // (network blip, model 5xx) should not permanently latch
                    // the breaker; only repeated reactive failures should.
                    // The only recovery path for a latched counter is a
                    // successful compaction (post-call reset at the COMPRESSED
                    // branch in tryCompress); hard-rescue forwards the counter
                    // as-is since force=true bypasses the breaker.
                    self.consecutiveFailures += 1;
                    if (self.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                      debugLogger.warn(
                        `[compaction] circuit breaker tripped after ${self.consecutiveFailures} consecutive failures (reactive overflow path); auto-compaction will NOOP on the cheap-gate until a successful force compaction resets the counter.`,
                      );
                    }
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
              popPartialIfPushed();
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

            // Currently unreachable for `InvalidStreamError`. The
            // `isContentError` predicate is identical to
            // `isTransientStreamError` (`error instanceof InvalidStreamError`),
            // and the transient branch above already either continued or
            // broke for that class. The branch is preserved as
            // defense-in-depth: a future error class that should consume
            // its own content-retry budget but NOT the transient one
            // could be threaded through here without re-deriving the
            // popPartialIfPushed sequence. No reachable test path until
            // the predicates diverge.
            const isContentError = error instanceof InvalidStreamError;
            if (isContentError) {
              if (attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1) {
                popPartialIfPushed();
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
              // Pop the partial `model[fc]` FIRST (if processStreamResponse
              // pushed one before re-throwing), THEN the recovery user
              // turn. Reversed order would strand `OUTPUT_RECOVERY_MESSAGE`
              // as a real user turn. Index-checked pop mirrors
              // `popPartialIfPushed` above — see the design note above
              // `ORPHAN_TOOL_USE_REPAIR_REASON` for the wedge mechanism
              // and the partial-push marker lifecycle.
              const expectedIdx = self.pendingPartialAssistantTurnIndex;
              const lastIdx = self.history.length - 1;
              if (
                expectedIdx !== null &&
                self.history.length > 0 &&
                self.history[lastIdx]?.role === 'model'
              ) {
                if (expectedIdx !== lastIdx) {
                  debugLogger.warn(
                    `[RECOVERY_POP] Marker/last-index mismatch: ` +
                      `marker=${expectedIdx}, lastIdx=${lastIdx}, ` +
                      `historyLength=${self.history.length}. Popping ` +
                      `last entry as best-effort rollback — investigate ` +
                      `any history mutation between processStreamResponse's ` +
                      `partial push and this catch.`,
                  );
                }
                self.history.pop();
                self.clearPendingPartialState();
              }
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
        sleepInhibitorHandle.release();
        streamDoneResolver!();
        // Flush any deferred partial-tool_use record. Covers both the
        // post-retry-loop unretryable break AND the max-tokens
        // escalation throw (the escalated processStreamResponse can
        // set a new record that escapes the retry-loop catch).
        // Recording-service errors are logged at error level (sustained
        // failure = monitoring signal) and swallowed — propagating
        // would mask the real send outcome.
        if (self.pendingPartialAssistantRecord) {
          try {
            self.chatRecordingService?.recordAssistantTurn(
              self.pendingPartialAssistantRecord,
            );
          } catch (recordErr) {
            debugLogger.error(
              '[PARTIAL_FLUSH] Failed to persist deferred JSONL record: ' +
                (recordErr instanceof Error
                  ? recordErr.message
                  : String(recordErr)),
            );
          }
          self.clearPendingPartialState();
        }
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
    const cgConfig = this.config.getContentGeneratorConfig();
    const extraRetryErrorCodes = cgConfig?.retryErrorCodes;
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

        // Honor provider-specific rate-limit codes (e.g. DashScope) so a custom
        // predicate does not silently drop them — the default path checks these
        // via defaultShouldRetry, but a custom shouldRetryOnError bypasses it.
        if (isRateLimitError(error, extraRetryErrorCodes)) return true;

        return false;
      },
      authType: cgConfig?.authType,
      extraRetryErrorCodes,
      persistentMode: isUnattendedMode(),
      signal: params.config?.abortSignal,
      heartbeatFn: (info) => {
        process.stderr.write(
          `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
        );
      },
      onRetry: (info) => {
        logApiRetry(
          this.config,
          new ApiRetryEvent({
            model,
            promptId: prompt_id,
            attemptNumber: info.attempt,
            error: info.error,
            statusCode: info.errorStatus,
            retryDelayMs: info.delayMs,
            subagentName: subagentNameContext.getStore(),
          }),
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
   * Set of `functionResponse.id` strings in user turns. Walk-only,
   * no clone — `useGeminiStream.handleCompletedTools` calls this per
   * tool-completion batch, so {@link getHistory}'s `structuredClone`
   * would stall the UI on long sessions.
   */
  getHistoryFunctionResponseIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.history) {
      if (entry.role !== 'user') continue;
      for (const part of entry.parts ?? []) {
        const id = part.functionResponse?.id;
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
    // Any pending partial-push state points into the now-empty history;
    // resetting prevents `popPartialIfPushed` from splicing whatever
    // shows up at that index in a future send (defense-in-depth — the
    // helper also bounds-checks, but a stale marker that happens to
    // line up with a real model turn could otherwise pop the wrong
    // entry). The deferred-record stash is dropped for the same reason:
    // a later flush would append a turn that doesn't match the (now-
    // empty) live history.
    this.clearPendingPartialState();
  }

  /**
   * Adds a new entry to the chat history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
    // addHistory only runs between sends, so the partial-push marker
    // should already be cleared. If it is not, a new caller is
    // violating that invariant — surface it at error level so the
    // offending stack is visible. See the design note above
    // `ORPHAN_TOOL_USE_REPAIR_REASON` for the marker lifecycle.
    if (
      this.pendingPartialAssistantTurnIndex !== null ||
      this.pendingPartialAssistantRecord !== null
    ) {
      debugLogger.error(
        '[INVARIANT_VIOLATION] addHistory called while a partial-push ' +
          'marker is active — clearing it.',
      );
    }
    this.clearPendingPartialState();
  }

  setHistory(history: Content[]): void {
    this.history = history;
    // History replacement (compression, /clear, --resume reload) wipes
    // the index basis the partial-push marker was captured against. The
    // marker MUST be cleared — otherwise `popPartialIfPushed` could find
    // a model turn at the stale index in the replacement history and
    // splice an entry that has nothing to do with the original partial
    // push, corrupting the conversation. Drop the paired deferred-record
    // stash too: its referent (the model turn at the old index) is gone.
    this.clearPendingPartialState();
  }

  truncateHistory(keepCount: number): void {
    this.history = this.history.slice(0, keepCount);
    // Truncation can drop the entry the partial-push marker points at,
    // or leave it valid but shift the meaning of nearby indices. Reset
    // both fields rather than try to fix them up — they're per-send and
    // ephemeral, so losing them across a truncate is safe (the
    // sendMessageStream that pushed them has already finished or will
    // start fresh on the next call).
    this.clearPendingPartialState();
  }

  stripThoughtsFromHistory(): void {
    this.history = this.history
      .map(stripThoughtPartsFromContent)
      .filter((content): content is Content => content !== null);
    // Filter+map replaces `this.history` with a new array, so any pending
    // partial-push marker is now indexed against an array that no longer
    // exists. Clear it for the same reason setHistory does — and drop
    // the paired deferred-record stash so a later flush can't land a
    // turn that doesn't exist in live history.
    this.clearPendingPartialState();
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
      // Never pop a *pure* system-reminder user entry. These are structural,
      // not orphaned turns: the startup-context prelude (history[0]) and
      // mid-history MCP added-tool reminders injected by
      // drainPendingAddedMcpToolsReminder. Popping the latter would lose the
      // announcement permanently — pendingAddedMcpTools is already cleared and
      // the tool name is already in announcedDeferredToolNames, so
      // queueAddedMcpToolsReminder won't re-queue it.
      //
      // Must check EVERY part, not just parts[0]: a failed user turn in plan
      // mode (or with subagent/memory reminders) is recorded as one Content
      // whose parts are [<system-reminder>…, actual prompt]. Matching parts[0]
      // alone would treat that as structural and preserve the user's prompt
      // text, which then leaks into the next turn via appendCuratedContent.
      const lastEntry = this.history[this.history.length - 1];
      if (lastEntry && isSystemReminderContent(lastEntry)) {
        break;
      }
      this.history.pop();
    }
    // Today this is safe even without the reset — only trailing user
    // entries are popped, which can't shift the index of an earlier
    // `model` partial. But every other history-mutation method now
    // clears the partial-push state in lockstep
    // (clearHistory/addHistory/setHistory/truncateHistory/
    // stripThoughtsFromHistory), so omitting it here would be a silent
    // exception to the uniform invariant: a future caller invoking
    // this method between the deferred JSONL flush and the next
    // `sendMessageStream` would otherwise leave a stale marker that
    // happens to line up with whatever model entry is at that index
    // in the meanwhile.
    this.clearPendingPartialState();
  }

  /**
   * Instance wrapper around the free-function {@link repairOrphanedToolUseTurns}.
   * See the canonical note above `ORPHAN_TOOL_USE_REPAIR_REASON`.
   */
  repairOrphanedToolUseTurns(reason?: string): {
    injected: Array<{ callId: string; name: string }>;
    droppedDuplicates: Array<{ callId: string; name: string }>;
  } {
    return repairOrphanedToolUseTurns(this.history, reason);
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
    let coercedUsage:
      | {
          promptTokenCount: number;
          totalTokenCount: number;
          candidatesTokenCount: number;
          cachedContentTokenCount: number;
        }
      | undefined;

    let hasToolCall = false;
    let hasFinishReason = false;
    // Captured if the upstream stream throws mid-iteration (typical on weak
    // networks: SSE drops between `content_block_stop` of a tool_use and the
    // terminal `message_stop`). We still build / record / push a partial
    // assistant turn below before re-throwing — see the dedicated branch in
    // the post-loop block for why this is needed to keep tool_use/tool_result
    // pairing intact across the failure.
    let streamError: unknown = null;

    try {
      for await (const chunk of streamResponse) {
        // Use ||= to avoid later usage-only chunks (no candidates) overwriting
        // a finishReason that was already seen in an earlier chunk.
        hasFinishReason ||=
          chunk?.candidates?.some((candidate) => candidate.finishReason) ??
          false;

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
          // Coerce hostile-provider values (NaN / Infinity / negative) to 0
          // so the compaction gate arithmetic stays well-defined; see
          // `coerceUsageCount` for the failure modes this guards against.
          const promptTokenCount = coerceUsageCount(
            usageMetadata.promptTokenCount,
            'promptTokenCount',
          );
          const totalTokenCount = coerceUsageCount(
            usageMetadata.totalTokenCount,
            'totalTokenCount',
          );
          const candidatesTokenCount = coerceUsageCount(
            usageMetadata.candidatesTokenCount,
            'candidatesTokenCount',
          );
          const cachedContentTokenCount = coerceUsageCount(
            usageMetadata.cachedContentTokenCount,
            'cachedContentTokenCount',
          );
          // Stash coerced values so recordAssistantTurn can reuse them
          // without re-calling coerceUsageCount inline.
          coercedUsage = {
            promptTokenCount,
            totalTokenCount,
            candidatesTokenCount,
            cachedContentTokenCount,
          };
          const lastPromptTokenCount = promptTokenCount || totalTokenCount;
          if (lastPromptTokenCount) {
            // Always update the per-chat counter so this chat (including
            // subagents) can make its own compaction decisions.
            this.lastPromptTokenCount = lastPromptTokenCount;
            // Mirror to the global telemetry only when wired — subagents
            // pass `telemetryService=undefined` to keep their context usage
            // out of the main session's UI counters.
            this.telemetryService?.setLastPromptTokenCount(
              lastPromptTokenCount,
            );
          }
          if (cachedContentTokenCount && this.telemetryService) {
            this.telemetryService.setLastCachedContentTokenCount(
              cachedContentTokenCount,
            );
          }
        }

        yield chunk; // Yield every chunk to the UI immediately.
      }
    } catch (e) {
      streamError = e;
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

    // Record assistant turn with raw Content and metadata. Gate matches
    // the in-memory `this.history.push` decision below so chat-recording
    // JSONL never carries a partial turn we deliberately dropped from
    // history: on `--resume` the transcript-load path would otherwise
    // re-inject a model turn the in-session run intentionally discarded
    // (text-only mid-stream errors, where the Retry re-issues the user
    // prompt — a stale partial-text record would bias the resumed
    // conversation or surface as duplicate output).
    const willPersistToHistory =
      streamError === null ||
      (hasToolCall &&
        (thoughtContentPart || consolidatedHistoryParts.length > 0));
    if (
      willPersistToHistory &&
      (thoughtContentPart || contentText || hasToolCall || usageMetadata)
    ) {
      const contextWindowSize =
        this.config.getContentGeneratorConfig()?.contextWindowSize;
      const recordArgs = {
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
        tokens: coercedUsage
          ? { ...usageMetadata, ...coercedUsage }
          : usageMetadata,
        contextWindowSize,
      };
      if (streamError !== null) {
        // Stream-error + tool-use partial: defer the JSONL append until
        // the outer retry loop decides whether to roll back this attempt.
        // If the same send retries successfully, popPartialIfPushed clears
        // this stash and the failed attempt never lands on disk; if the
        // retry path doesn't apply (unretryable break), the stash is
        // flushed at the rethrow site so JSONL stays aligned with the
        // partial that survives in-memory. Without this, retry-success
        // leaves a failed `model[functionCall]` durable in JSONL and
        // `--resume` rehydrates a turn the live session correctly
        // discarded.
        this.pendingPartialAssistantRecord = recordArgs;
      } else {
        this.chatRecordingService?.recordAssistantTurn(recordArgs);
      }
    }

    // Mid-stream failure recovery (Race C in the canonical note above
    // `ORPHAN_TOOL_USE_REPAIR_REASON`): if the upstream stream threw
    // AFTER a `functionCall` chunk was already yielded — typical on
    // weak networks: SSE cut between a tool_use `content_block_stop`
    // and the terminal `message_stop` — we persist the partial
    // assistant turn so the React scheduler's incoming
    // `user[functionResponse]` has a matching `model[tool_use]` to
    // pair with.
    //
    // Plain-text partial turns (no functionCall yielded) are
    // deliberately NOT persisted — the Retry path pops the trailing
    // user prompt and re-issues it; a stale partial-text model turn
    // between them would either bias the retry or surface as a
    // duplicate.
    if (streamError !== null) {
      // Reuse the `willPersistToHistory` gate from the recordAssistantTurn
      // block above instead of re-deriving it. When `streamError !== null`,
      // `willPersistToHistory` reduces to exactly the original expression
      // `hasToolCall && (thoughtContentPart || consolidatedHistoryParts.length > 0)`;
      // sharing the single binding eliminates drift risk if one gate is
      // tightened without the other and the JSONL recording silently
      // desyncs from in-memory history.
      if (willPersistToHistory) {
        this.history.push({
          role: 'model',
          parts: [
            ...(thoughtContentPart ? [thoughtContentPart] : []),
            ...consolidatedHistoryParts,
          ],
        });
        // Track the pushed turn so the outer sendMessageStream retry loop
        // can roll it back if it decides to retry the same send. Without
        // this, a successful retry would leave the failed attempt's
        // partial `model[functionCall]` as a stale leading model turn in
        // front of the retry's real response.
        this.pendingPartialAssistantTurnIndex = this.history.length - 1;
        // Trace the push event so the lifecycle is observable end-to-end:
        // dedup in `useGeminiStream.handleCompletedTools` already logs
        // `[REPAIR] Dropping ...`, and `repairOrphanedToolUseTurnsInHistory`
        // logs `[REPAIR] Synthesized ...`. Without a corresponding
        // `[PARTIAL_PUSH]` line here, an investigator looking at a
        // stale-partial wedge sees the downstream symptom but has no
        // anchor for when/why the partial originated.
        debugLogger.warn(
          '[PARTIAL_PUSH] Persisting partial assistant turn for ' +
            'mid-stream error recovery (will be rolled back if retry ' +
            'succeeds, kept if break is unretryable). ' +
            `pendingIndex=${this.pendingPartialAssistantTurnIndex} ` +
            `callIds=${consolidatedHistoryParts
              .map((p) => p.functionCall?.id)
              .filter((id): id is string => Boolean(id))
              .join(',')} ` +
            `error=${
              streamError instanceof Error
                ? streamError.message
                : String(streamError)
            }`,
        );
      }
      throw streamError;
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
