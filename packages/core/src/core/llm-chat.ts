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
  FunctionCall,
  SendMessageParameters,
  Part,
  Tool,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { createUserContent, FinishReason } from './genai-compat.js';
import { enforceFunctionResponseBudget } from '../tools/tool-response-finalizer.js';
import {
  retryWithBackoff,
  isUnattendedMode,
  type HeartbeatInfo,
} from '../utils/retry.js';
import {
  isQuotaExhaustedError,
  formatQuotaExhaustedMessage,
} from '../utils/quotaErrorDetection.js';
import { getErrorStatus, isAbortError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  containsXmlToolCalls,
  tryRecoverXmlToolCalls,
} from './xml-tool-call-fallback.js';
import { parseAndFormatApiError } from '../utils/errorParsing.js';
import {
  getRateLimitErrorDetails,
  getRateLimitRetryDelayMs,
  isRateLimitError,
  type RetryInfo,
} from '../utils/rateLimit.js';
import {
  classifyRetryError,
  isFallbackEligible,
} from '../utils/retryErrorClassification.js';
import type { Config } from '../config/config.js';
import type { ContentGenerator, InputModalities } from './contentGenerator.js';
import {
  clampOutputTokensToWindow,
  defaultOutputCeiling,
  DEFAULT_TOKEN_LIMIT,
  OUTPUT_TOKEN_CEILING,
  parsePositiveIntegerEnvValue,
} from './tokenLimits.js';
import { hasCycleInSchema } from '../tools/tools.js';
import { ToolNames, canonicalToolName } from '../tools/tool-names.js';
import { clearLoadedSkillTracking } from '../tools/skill-utils.js';
import * as fs from 'node:fs';
import { PLAN_EXIT_APPROVED_LLM_CONTENT_PREFIXES } from '../tools/exitPlanMode.js';
import { isManagedMemoryPath } from '../memory/paths.js';
import { STRUCTURED_OUTPUT_REDACTED_ARGS } from '../tools/syntheticOutput.js';
import type { StructuredError } from './turn.js';
import {
  logContentRetry,
  logContentRetryFailure,
  logApiRetry,
  logChatCompression,
} from '../telemetry/loggers.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { type ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ChatCompressionService,
  computeThresholds,
  MAX_CONSECUTIVE_FAILURES,
  type CompactTrigger,
} from '../services/chatCompressionService.js';
import { acquireSleepInhibitor } from '../services/sleepInhibitor.js';
import {
  getFunctionResponseParts,
  resolveCompactionTuning,
  resolveSlimmingConfig,
  slimCompactionInput,
} from '../services/compactionInputSlimming.js';
import {
  InMemoryImagePayloadStore,
  buildReattachParts,
  countAllInlineImages,
  replaceImagePayloadsInPlace,
} from '../services/image-payload-references.js';
import {
  estimateContentTokens,
  estimatePromptTokens,
  getUsageOutputTokenCountForPromptEstimate,
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
import {
  getStartupContextLength,
  isSystemReminderContent,
} from './environmentContext.js';
import type { SessionStartSource } from '../hooks/types.js';
import {
  getCustomSystemPrompt,
  getManualPlanExitSystemReminder,
} from './prompts.js';
import { isRetryableStreamTransportError } from './stream-transport-retry.js';
import {
  collectToolCallIdsFromHistory,
  getFunctionCallFingerprint,
  normalizeModelToolCallIds,
  reserveModelToolCallId,
} from './toolCallIdUtils.js';
import {
  getToolCallPreparations,
  setToolCallPreparations,
} from './tool-call-preparation.js';
import { InvalidStreamError } from './invalid-stream-error.js';
import type { GoalTurnPermit } from '../goals/goal-protocol.js';

export { InvalidStreamError };

const debugLogger = createDebugLogger('QWEN_CODE_CHAT');
// Gemini can emit this filler after tool results; filtering and validation
// must stay in sync.
const GEMINI_EMPTY_CONTENT_PLACEHOLDER = '(empty content)';

function hasCandidateOutput(response: GenerateContentResponse): boolean {
  return Boolean(
    response.candidates?.some(
      (candidate) =>
        Boolean(candidate.finishReason) ||
        (candidate.content?.parts?.length ?? 0) > 0,
    ),
  );
}

/**
 * True when the chunk carries model output beyond ephemeral reasoning:
 * any candidate part without the `thought` flag (text, functionCall,
 * inlineData, …). What makes a replay after thinking-only output safe
 * is NOT that thought parts stay out of history — the successful
 * attempt's thoughts are recorded there. It is that a failed attempt
 * that produced only thought parts persists nothing: error-path
 * persistence requires a delivered functionCall, which the replay
 * gate excludes. `popPendingPartialAssistantTurn()` before the retry
 * is defense in depth — it has nothing to pop on this path today, but
 * keeps the replay safe if that persistence policy ever widens. The
 * transport stream retry gate relies on this distinction (#7832).
 */
function hasNonThoughtCandidateParts(
  response: GenerateContentResponse,
): boolean {
  return Boolean(
    response.candidates?.some((candidate) =>
      candidate.content?.parts?.some((part) => !part.thought),
    ),
  );
}

function syncFunctionCallsField(
  response: GenerateContentResponse,
  parts: readonly Part[],
): void {
  const functionCalls = parts
    .map((part) => part.functionCall)
    .filter((call): call is FunctionCall => Boolean(call));
  const value = functionCalls.length > 0 ? functionCalls : undefined;

  let owner: object | null = response;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'functionCalls');
    owner = Object.getPrototypeOf(owner);
  }

  if (descriptor?.set) {
    (
      response as GenerateContentResponse & { functionCalls?: FunctionCall[] }
    ).functionCalls = value;
    return;
  }

  if (!descriptor || descriptor.writable || descriptor.get) {
    Object.defineProperty(response, 'functionCalls', {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

/**
 * Resolves legacy tool-name aliases via the shared `canonicalToolName` so
 * the load-side plan redaction keeps matching sessions recorded under a
 * pre-migration name, in lockstep with the write-side scheduler.
 */
function canonicalPlanToolName(toolName: string | undefined): string {
  if (!toolName) return '';
  return canonicalToolName(toolName);
}

/**
 * Single source of the pointer text that replaces an approved plan's
 * `functionCall.args.plan` (#6237). Shared by the tool scheduler's
 * post-approval rewrite and the load-side pass below so the two surfaces
 * cannot drift.
 */
export function approvedPlanRedactionText(planPath: string): string {
  return (
    `[Plan approved and saved to ${planPath}. The plan text was ` +
    `removed from the conversation after approval; read that ` +
    `file if you need to consult it again.]`
  );
}

/**
 * Pure history-wide variant of the approved-plan redaction: rewrites the
 * `plan` argument of every `exit_plan_mode` `functionCall` whose paired
 * `functionResponse` carries an approval `llmContent` AND whose plan text
 * equals `savedPlanContent` (the current on-disk plan file). Returns a new
 * array when anything changed, or null when the history is untouched.
 *
 * Exported for tests; production callers go through
 * `LlmChat.setHistory` / the constructor.
 */
export function redactApprovedPlansInHistory(
  history: Content[],
  savedPlanContent: string,
  planPath: string,
): Content[] | null {
  const approved = new Set<string>();
  for (const entry of history) {
    if (!entry?.parts) continue;
    for (const part of entry.parts) {
      const fr = part.functionResponse;
      if (
        !fr?.id ||
        canonicalPlanToolName(fr.name) !== ToolNames.EXIT_PLAN_MODE
      )
        continue;
      const output = (fr.response as { output?: unknown } | undefined)?.[
        'output'
      ];
      if (
        typeof output === 'string' &&
        PLAN_EXIT_APPROVED_LLM_CONTENT_PREFIXES.some((prefix) =>
          output.startsWith(prefix),
        )
      ) {
        approved.add(fr.id);
      }
    }
  }
  if (approved.size === 0) return null;

  let changed = false;
  const out = history.map((entry) => {
    if (entry?.role !== 'model' || !entry.parts) return entry;
    let entryChanged = false;
    const parts = entry.parts.map((part) => {
      const fc = part.functionCall;
      if (
        !fc?.id ||
        canonicalPlanToolName(fc.name) !== ToolNames.EXIT_PLAN_MODE
      )
        return part;
      if (!approved.has(fc.id)) return part;
      if ((fc.args ?? {})['plan'] !== savedPlanContent) return part;
      entryChanged = true;
      return {
        ...part,
        functionCall: {
          ...fc,
          args: { ...fc.args, plan: approvedPlanRedactionText(planPath) },
        },
      };
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, parts };
  });
  return changed ? out : null;
}

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
  /** Emitted when the primary model (or a prior fallback) exhausted its retry
   * budget on a capacity/availability error and the system is switching to the
   * next fallback model. The UI should discard partial content and display a
   * notification about the model switch. */
  MODEL_FALLBACK = 'model_fallback',
}

/** Information about a model fallback transition. */
export interface ModelFallbackInfo {
  /** The model that exhausted its retry budget. */
  fromModel: string;
  /** The model the system is switching to. */
  toModel: string;
  /** HTTP status code that triggered the fallback (e.g. 429, 503, 529). */
  statusCode?: number;
  /** 1-based index of the fallback in the configured fallback chain. */
  fallbackIndex: number;
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
      /** Set when the retry raised the automatic max output token limit. */
      maxOutputTokensEscalated?: number;
    }
  | { type: StreamEventType.COMPRESSED; info: ChatCompressionInfo }
  | { type: StreamEventType.MODEL_FALLBACK; info: ModelFallbackInfo };

export interface LlmChatSendOptions {
  /** Skip only the configured model fallback chain for this request. */
  disableModelFallbacks?: boolean;
}

/** @deprecated Use `LlmChatSendOptions`; retained until a future major release. */
export type GeminiChatSendOptions = LlmChatSendOptions;

interface TryCompressOptions {
  /**
   * Explicit original token count for this attempt, with its provenance.
   * Only a provider-reported count (e.g. `actualTokens` parsed from a
   * context-overflow error) may claim `isEstimated: false`; limit/config/
   * default fallbacks must carry `isEstimated: true` so UIs mark them
   * instead of presenting them as API-reported counts.
   */
  originalTokenCountOverride?: {
    count: number;
    isEstimated: boolean;
  };
  trigger?: CompactTrigger;
  /**
   * Pending user message about to be sent. Threaded through to the
   * compression service's cheap-gate so it can see the real prompt size
   * even when `lastPromptTokenCount === 0` (first send after inherited
   * history). See `estimatePromptTokens` for the fallback math.
   */
  pendingUserMessage?: Content;
  /**
   * Pre-computed all-inclusive effective prompt count from the caller. When
   * set, the cheap-gate uses this instead of recomputing — avoids a second
   * `getHistory(true)` clone per send and prevents provider-reported overflow
   * counts from double-counting the previous model output.
   */
  precomputedEffectiveTokens?: number;
  /** Per-request overrides needed to preserve the main request cache prefix. */
  requestGenerationConfig?: GenerateContentConfig;
  /**
   * Route the enclosing send targets. The entry adoption compares against
   * this instead of the active route, so an in-send compression never
   * re-adopts counts the active route retained while the request targets
   * another one (#9506). Omitted by between-sends callers (manual
   * `/compress`), which compress the active route's state.
   */
  requestRouteKey?: string;
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

// Model-output validation errors (protocol tag leaks, malformed tool calls)
// and transient stream anomalies (empty streams, no usable text, missing
// finish reason) use an independent retry budget so they do not consume each
// other's or HTTP retries' budgets.
const INVALID_STREAM_RETRY_CONFIG = {
  transientMaxRetries: 4,
  protocolTagLeakMaxRetries: 2,
  initialDelayMs: 2000,
};

const TRANSPORT_STREAM_RETRY_CONFIG = {
  maxRetries: 2,
  initialDelayMs: 1000,
  /**
   * Budget for *continuation* recovery after a socket-level cut that already
   * delivered output (issue #7832). This is a different mechanism from the
   * `maxRetries` replay above and therefore has its own budget: a replay
   * re-sends the request from scratch and is only legal before any chunk
   * reached callers, while a continuation keeps the delivered output and asks
   * the model to resume from it. A single long generation can be cut more than
   * once by the same gateway idle timeout, so this is sized like
   * {@link MAX_OUTPUT_RECOVERY_ATTEMPTS} rather than like the replay budget.
   */
  maxContinuationRetries: 3,
};

/**
 * Pad added when sizing the output clamp from an estimate-derived prompt
 * count. This includes a fresh session (`lastPromptTokenCount === 0`) and
 * counts propagated through compression or resume before provider usage is
 * available. A history-derived count can miss the system prompt, tool
 * definitions, and skill content — estimatePromptTokens documents this as
 * "typically ~15-20K of under-estimate" — so pad conservatively until
 * provider usage arrives. Counts derived from an API baseline may already
 * preserve some non-visible overhead; double-counting it is accepted because
 * the error direction is safe and provider usage self-corrects it. An
 * under-counted prompt is the one way `prompt + max_tokens` can overflow the
 * window (issue #5950). Sized to the documented worst case; costs nothing on
 * large windows (the output ceiling binds long before the pad matters).
 */
const ESTIMATE_CLAMP_OVERHEAD_PAD = 20_000;

/**
 * Cap on how many routes' token counts are retained while their route is
 * not the one owning the chat's count slots (#9506). Route identities are
 * bounded by the session's model routes, so this only guards pathological
 * selector churn; eviction is FIFO.
 */
const MAX_RETAINED_ROUTE_COUNTS = 8;

/**
 * Max recovery attempts when the escalated response is also truncated.
 * Each attempt keeps the partial response in history and injects a recovery
 * message so the model can continue from where it left off.
 */
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

/**
 * The resume instruction shared by every recovery user-turn, whatever cut the
 * response short. Only the lead-in sentence naming the cause differs between
 * the paths below, so the instruction itself lives here: tuning it (say, to
 * curb recap behaviour) has to apply to both, and duplicating it invites one
 * path to be updated while the other silently keeps the old wording.
 */
const RECOVERY_RESUME_INSTRUCTION =
  'Resume directly — no apology, no recap of what you were doing. Pick up ' +
  'mid-thought if that is where the cut happened. Break remaining work into ' +
  'smaller pieces.';

/**
 * Recovery message injected as a user turn when the model's output is
 * truncated even after token escalation. Instructs the model to resume
 * without repeating itself and to break remaining work into smaller steps.
 */
const OUTPUT_RECOVERY_MESSAGE = `Output token limit hit. ${RECOVERY_RESUME_INSTRUCTION}`;

/**
 * Lead-in for the same recovery user-turn when the cause was a socket-level
 * cut mid-stream rather than the output token limit (issue #7832). Gateways
 * that cap SSE connection lifetime close long generations after a few
 * minutes; the response so far is already on the caller's screen, so the only
 * safe recovery is to resume from it. Deliberately shares
 * {@link RECOVERY_RESUME_INSTRUCTION} with {@link OUTPUT_RECOVERY_MESSAGE} —
 * the model does not need to know which limit it hit, only that it was cut
 * off and must not restart.
 */
const TRANSPORT_CONTINUATION_MESSAGE = `The connection dropped mid-response. ${RECOVERY_RESUME_INSTRUCTION}`;

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

/**
 * Join already-delivered text to the continuation that resumes it, dropping
 * any tail the model replayed.
 *
 * The single definition of "merged turn text" for the transport-continuation
 * path. Both the durable JSONL record and in-memory history are built from one
 * call to this (see `processStreamResponse`), so the two storage layers cannot
 * drift apart if the dedup rule ever changes — the same reason the
 * `willPersistToHistory` gate is a shared binding rather than two copies of
 * one expression.
 */
function mergeDeliveredPrefix(
  deliveredText: string,
  continuationText: string,
): string {
  return (
    deliveredText +
    getRecoveryContinuationSuffix(deliveredText, continuationText)
  );
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

/**
 * Build a recovery user-turn from the text the model already produced.
 *
 * Shared by both continuation paths: output-token truncation (which reads the
 * partial turn back out of history) and mid-stream transport cuts (which
 * cannot, because a text-only partial is deliberately never persisted — see
 * `processStreamResponse`). `lead` states the cause; everything after it is
 * identical so the two paths cannot drift in how they fence the suffix.
 */
function buildRecoveryMessageFromText(lead: string, previousText: string) {
  if (previousText.trim().length === 0) {
    return lead;
  }

  const rawTail =
    previousText.length > OUTPUT_RECOVERY_TAIL_CHARS
      ? previousText.slice(-OUTPUT_RECOVERY_TAIL_CHARS)
      : previousText;
  const tail = sanitizeRecoverySuffixTail(rawTail);

  return (
    `${lead}\n\n` +
    'The previous assistant response ended with this exact suffix. ' +
    'Do not repeat any line, table row, code line, or prose that already ' +
    'appears in it; output only text that comes after this suffix:\n\n' +
    '<previous_response_suffix>\n' +
    tail +
    '\n</previous_response_suffix>'
  );
}

function buildOutputRecoveryMessage(previousModelTurn: Content | undefined) {
  return buildRecoveryMessageFromText(
    OUTPUT_RECOVERY_MESSAGE,
    previousModelTurn?.role === 'model'
      ? getPlainTextFromParts(previousModelTurn.parts)
      : '',
  );
}

/**
 * Coalesce a recovery continuation turn into the preceding (truncated) model
 * turn, dropping any replayed overlap.
 *
 * Coupling with `processStreamResponse`. This function assumes the parts
 * arrays it receives were produced by {@link LlmChat.processStreamResponse}
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
 * ...nonTextParts]`. {@link LlmChat.coalesceRecoveryPairs} relies on this
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

const UPSTREAM_DEGRADED_PLACEHOLDER = '(request timeout)';

function degradedPlaceholderError(): InvalidStreamError {
  return new InvalidStreamError(
    'Model response is an upstream fail-fast placeholder.',
    'UPSTREAM_DEGRADED_RESPONSE',
  );
}

function isDegradedPlaceholderTurn(content: Content): boolean {
  const parts = content.parts ?? [];
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        part.functionCall === undefined &&
        (part.thought || part.text !== undefined),
    ) &&
    parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('')
      .trim() === UPSTREAM_DEGRADED_PLACEHOLDER
  );
}

async function* rejectDegradedPlaceholderResponse(
  stream: AsyncGenerator<GenerateContentResponse>,
): AsyncGenerator<GenerateContentResponse> {
  const pending: GenerateContentResponse[] = [];
  let text = '';
  let passthrough = false;

  for await (const chunk of stream) {
    if (passthrough) {
      yield chunk;
      continue;
    }

    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    if (
      parts.some(
        (part) =>
          part.functionCall !== undefined ||
          (!part.thought && part.text === undefined),
      )
    ) {
      yield* pending;
      pending.length = 0;
      yield chunk;
      passthrough = true;
      continue;
    }

    const chunkText = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
    if (pending.length === 0 && chunkText === '') {
      yield chunk;
      continue;
    }

    pending.push(chunk);
    text += chunkText;
    const trimmed = text.trim();
    if (trimmed && !UPSTREAM_DEGRADED_PLACEHOLDER.startsWith(trimmed)) {
      yield* pending;
      pending.length = 0;
      passthrough = true;
    }
  }

  if (passthrough) return;
  if (text.trim() === UPSTREAM_DEGRADED_PLACEHOLDER) {
    throw degradedPlaceholderError();
  }
  yield* pending;
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
        curatedHistory.push(
          ...modelOutput.filter((turn) => !isDegradedPlaceholderTurn(turn)),
        );
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
    ...(content.parts ? { parts: content.parts.map(copyPartContainer) } : {}),
  };
}

function copyPartContainer(part: Part): Part {
  const nested = getFunctionResponseParts(part);
  if (!nested) return { ...part };
  return {
    ...part,
    functionResponse: {
      ...part.functionResponse,
      parts: nested.map((inner) => ({ ...inner })),
    },
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

const PROTOCOL_TAG_PREFIXES = [
  '<analysis',
  '</analysis',
  '<summary',
  '</summary',
] as const;
const LEAKED_TOOL_CALL_TAGS = /[}\]]\s*<\/parameter>\s*<\/function>/iy;

function hasLeakedToolCallTags(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '}' || char === ']') {
      LEAKED_TOOL_CALL_TAGS.lastIndex = i;
      if (LEAKED_TOOL_CALL_TAGS.test(text)) return true;
    }
  }
  return false;
}

class LeadingProtocolTagLeakDetector {
  private state: 'detecting' | 'json' | 'clean' | 'leaked' = 'detecting';
  private buffer = '';

  accept(text: string): string {
    if (this.state === 'clean') return text;
    if (this.state === 'leaked') return '';

    this.buffer += text;
    if (this.state === 'json') return '';
    const candidate = this.buffer.trimStart().toLowerCase();
    if (!candidate) return '';
    if (PROTOCOL_TAG_PREFIXES.some((prefix) => prefix.startsWith(candidate))) {
      return '';
    }

    for (const prefix of PROTOCOL_TAG_PREFIXES) {
      if (
        candidate.startsWith(prefix) &&
        /[\s/>]/.test(candidate[prefix.length] ?? '')
      ) {
        this.state = 'leaked';
        this.buffer = '';
        return '';
      }
    }
    if (candidate.startsWith('{')) {
      this.state = 'json';
      return '';
    }
    if (candidate.startsWith('[')) {
      const normalized = candidate.replace(/\s/g, '');
      if (normalized === '[') return '';
      if (normalized.startsWith('[{')) {
        this.state = 'json';
        return '';
      }
    }

    return this.release();
  }

  finish(): string {
    if (this.state === 'json') {
      if (hasLeakedToolCallTags(this.buffer)) {
        this.state = 'leaked';
        this.buffer = '';
        return '';
      }
      return this.release();
    }
    if (this.state !== 'detecting') return '';
    const candidate = this.buffer.trimStart().toLowerCase();
    if (
      candidate &&
      PROTOCOL_TAG_PREFIXES.some((prefix) => prefix.startsWith(candidate))
    ) {
      this.state = 'leaked';
      this.buffer = '';
      return '';
    }
    return this.release();
  }

  private release(): string {
    const output = this.buffer;
    this.state = 'clean';
    this.buffer = '';
    return output;
  }

  get leaked(): boolean {
    return this.state === 'leaked';
  }

  get blockingOutput(): boolean {
    return this.state !== 'clean';
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
export const ORPHAN_TOOL_USE_REPAIR_REASON =
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
 *       Then `useLlmStream.handleCompletedTools` dedupes the
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
  adjacentIdx: number;
}

/** Decision-phase output: exact mutations the next phase will apply. */
interface RepairPlan {
  modelIdx: number;
  scanEnd: number;
  adjacentIdx: number;
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
  while (
    scanIdx < history.length &&
    history[scanIdx]?.role === 'model' &&
    isDegradedPlaceholderTurn(history[scanIdx])
  ) {
    scanIdx++;
  }
  const adjacentIdx = scanIdx;
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

  return { modelIdx, expected, matched, scanEnd: scanIdx, adjacentIdx };
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

  const adjacentIdx = scan.adjacentIdx;
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
    adjacentIdx: scan.adjacentIdx,
    synthesizeIds,
    hoistedParts,
    removalTargets,
    droppedDuplicates,
  };
}

/**
 * MUTATION — apply the plan to `history` in place. Returns the count
 * of new user turns inserted (0 or 1) so the outer loop can advance its
 * cursor.
 *
 * Order: (1) splice removal targets desc-by-desc, (2) drop empty user
 * turns after the resolved adjacent turn, (3) HEAD-insert at that user
 * turn OR splice a new user turn there. The HEAD insert is
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

  // (2) Drop now-empty user turns after the resolved adjacent turn.
  // Preserve the adjacent turn even if empty — we'll rewrite it
  // below.
  const adjacentIdx = plan.adjacentIdx;
  for (let j = plan.scanEnd - 1; j > adjacentIdx; j--) {
    if (history[j]?.role === 'user' && (history[j].parts?.length ?? 0) === 0) {
      history.splice(j, 1);
    }
  }

  if (partsToInject.length === 0) return { insertedBefore: 0 };

  // (3) Place new parts at the head of the adjacent user turn, OR
  // insert a fresh user turn at the resolved adjacency.
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

export interface RepairOrphanedToolUseOptions {
  preserveCallIds?: ReadonlySet<string>;
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
  options?: RepairOrphanedToolUseOptions,
): {
  injected: Array<{ callId: string; name: string }>;
  droppedDuplicates: Array<{ callId: string; name: string }>;
} {
  const injected: Array<{ callId: string; name: string }> = [];
  const droppedDuplicates: Array<{ callId: string; name: string }> = [];
  const preserveCallIds = options?.preserveCallIds;

  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'model') continue;

    const scan = scanModelTurn(history, i);
    if (scan.expected.size === 0) continue;

    const plan = planRepair(scan);
    if (preserveCallIds && preserveCallIds.size > 0) {
      plan.synthesizeIds = plan.synthesizeIds.filter(
        ([id]) => !preserveCallIds.has(id),
      );
    }
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

export class LlmChat {
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
  private lastPromptTokenCountIsEstimated = false;

  /**
   * Per-chat output-token count from the previous model response. The
   * previous response is appended to local history after `promptTokenCount`
   * was reported, so steady-state prompt estimates add this value to avoid
   * under-counting the next request near the hard compaction threshold.
   */
  private lastOutputTokenCount = 0;

  /**
   * Route identity (model + auth type + endpoint; see
   * Config.getModelRouteIdentity) of the content generator that produced
   * the counts above. API-reported sizes are wire-specific: one route's
   * count cannot size another route's serialization (#9454). Undefined
   * until the first count is recorded.
   */
  private tokenCountsRouteKey: string | undefined = undefined;

  /**
   * Token counts retained for routes other than the one currently owning
   * the slots above, keyed by route identity (#9506). Crossing routes
   * retains the current slots here and adopts the target's entry back
   * instead of destroying the value: API-reported sizes are per-route
   * state that a later turn on the same route still needs — most
   * critically the session-token-limit gate, whose keyed read would
   * otherwise see 0 after any foreign-route touch between turns.
   * Invariant: never holds an entry for {@link tokenCountsRouteKey}.
   */
  private readonly tokenCountsByRouteKey = new Map<
    string,
    {
      promptTokenCount: number;
      promptTokenCountIsEstimated: boolean;
      outputTokenCount: number;
      cachedContentTokenCount: number;
    }
  >();

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
   *   - Hard-tier rescue failures: skipped here because force=true bypasses
   *     this breaker; bounded separately by hardRescueFailureCount.
   *   - Reactive overflow failures: explicitly incremented in the overflow
   *     handler so N repeated reactive failures still trip this breaker.
   *
   * If you're debugging "why is hard-rescue firing but the counter is 0",
   * that's by design.
   */
  private consecutiveFailures = 0;

  /**
   * Number of failed hard-tier rescue attempts for this chat. Hard rescue is
   * forced and therefore bypasses the cheap-gate breaker, so it needs its own
   * bound to avoid spending one compression side-query on every send when
   * history repeatedly cannot shrink. NOOP counts toward this bound because
   * it leaves the prompt oversized and would otherwise spend one compression
   * side-query on every send. COMPRESSED resets this unless the
   * post-compression hard-limit guard still rejects the send.
   */
  private hardRescueFailureCount = 0;

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

  private readonly imagePayloadStore = new InMemoryImagePayloadStore();

  /**
   * Monotonically counts user-content pushes that survived into history.
   * Incremented when `sendMessageStream` pushes the user content and decremented
   * only if that same push is rolled back on a setup-time failure. Auto-
   * compression mutates history length but never touches this counter, so a
   * caller (the Retry strip/restore in client.ts) can snapshot it and tell
   * whether the re-submitted content actually landed — a history-length delta
   * can't, since compression shrinks history independently of the push.
   */
  private userContentPushCount = 0;
  private manualPlanExitNoticesEnabled = false;

  /**
   * True for forked/speculative chats built by `createForkedChat` on the
   * parent's Config. They share the parent's ToolRegistry (and the single
   * SkillTool tracking instance) while rewriting only a copy of a parent
   * history slice, so their rewrites must not touch loaded-skill tracking —
   * only the chat owning the authoritative session may.
   */
  isForkedChat = false;

  /**
   * Reset both partial-push markers in lockstep. Every history-mutation
   * site uses this — single-field resets are a bug because the fields
   * are always paired by lifecycle.
   */
  private clearPendingPartialState(): void {
    this.pendingPartialAssistantTurnIndex = null;
    this.pendingPartialAssistantRecord = null;
  }

  private popPendingPartialAssistantTurn(): void {
    const idx = this.pendingPartialAssistantTurnIndex;
    if (idx === null) return;
    if (this.history.length > idx && this.history[idx]?.role === 'model') {
      this.history.splice(idx, 1);
    } else {
      debugLogger.warn(
        `[PARTIAL_POP] Splice skipped: idx=${idx}, ` +
          `historyLength=${this.history.length}, ` +
          `roleAtIdx=${this.history[idx]?.role ?? 'undefined'}`,
      );
    }
    this.clearPendingPartialState();
  }

  /**
   * Creates a new LlmChat instance.
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
    this.redactApprovedPlansFromLoadedHistory();
  }

  enableManualPlanExitNotices(): void {
    this.manualPlanExitNoticesEnabled = true;
  }

  /**
   * Identity of the currently active model route. Optional chaining keeps
   * partial Config test mocks (`{} as Config`) from throwing on count
   * reads/writes; a missing identity degrades to one stable key, i.e. no
   * route-change invalidation.
   */
  private currentRouteKey(): string {
    return this.config.getModelRouteIdentity?.() ?? '';
  }

  /**
   * Make the single-slot token counters describe the route identified by
   * `targetRouteKey` (default: the active route). Counts recorded for a
   * different route must not anchor admission, output clamping, or
   * compression decisions for this one (`/model` switches rebuild the
   * content generator but keep this chat instance; #9454).
   *
   * The crossing is NON-DESTRUCTIVE (#9506): the current slots are
   * retained in {@link tokenCountsByRouteKey} under their own route key,
   * and the target's retained entry — if any — is adopted back into the
   * slots. Zeroing a foreign count outright let any foreign-route touch
   * between two turns destroy the value before the session-token-limit
   * gate (the only yield site of `SessionTokenLimitExceeded`) could read
   * it back keyed by its request route. With retention, a route with no
   * counts of its own still falls back to the history-walk estimate
   * (slots 0), with reactive overflow recovery as the safety net, while a
   * turn returning to a route that has counts reads the exact
   * API-reported values.
   *
   * Defaults to comparing against the ACTIVE route (lazy reads on the
   * getters). Send paths pass the route the upcoming request actually
   * targets so a foreign count cannot anchor that request's decisions even
   * when the active route owns it — e.g. an exact `\0` route selector, or
   * a non-exact send whose `model` param overrides the active model.
   *
   * The telemetry mirror is display-only state: it is resynchronized here
   * (adopted or zeroed alongside the slots), so between a `/model` switch
   * and the next chat touch the UI counters may briefly show the previous
   * route's counts. Decision paths never read the mirror, only the
   * route-aware chat getters above.
   */
  private adoptTokenCountsForRoute(targetRouteKey?: string): void {
    if (
      this.lastPromptTokenCount === 0 &&
      this.lastOutputTokenCount === 0 &&
      this.tokenCountsByRouteKey.size === 0
    ) {
      return;
    }
    // Resolve the active-route default only AFTER the zero-count fast path:
    // computing a route identity (SHA-256 digest + config lookups) on every
    // count read while both counts are 0 (and nothing is retained) would
    // defeat the guard above.
    targetRouteKey ??= this.currentRouteKey();
    if (this.tokenCountsRouteKey === targetRouteKey) {
      return;
    }
    const retained = this.tokenCountsByRouteKey.get(targetRouteKey);
    if (retained) {
      this.tokenCountsByRouteKey.delete(targetRouteKey);
      this.retainCurrentTokenCounts();
      debugLogger.debug(
        `[token-counts] restoring retained counts for route ${targetRouteKey}`,
      );
      this.lastPromptTokenCount = retained.promptTokenCount;
      this.lastPromptTokenCountIsEstimated =
        retained.promptTokenCountIsEstimated;
      this.lastOutputTokenCount = retained.outputTokenCount;
      this.tokenCountsRouteKey = targetRouteKey;
      this.telemetryService?.setLastPromptTokenCount(retained.promptTokenCount);
      this.telemetryService?.setLastCachedContentTokenCount(
        retained.cachedContentTokenCount,
      );
      return;
    }
    debugLogger.debug(
      `[token-counts] route changed; retaining counts recorded for ` +
        `${this.tokenCountsRouteKey ?? 'unknown'} (now ${targetRouteKey})`,
    );
    this.retainCurrentTokenCounts();
    // Raw assignment on purpose: setLastPromptTokenCount would re-attribute
    // the zero slot to the ACTIVE route. The slot is attributed to the
    // TARGET route instead so it can never collide with the just-retained
    // entry (retained under the evicted slot's key, which differs from the
    // target) — a colliding key would make the next keyed read for the
    // retained route early-return the zero slot without consulting the map.
    this.lastPromptTokenCount = 0;
    this.lastPromptTokenCountIsEstimated = false;
    this.lastOutputTokenCount = 0;
    this.tokenCountsRouteKey = targetRouteKey;
    // Keep the telemetry mirror in sync, or the UI context counters
    // and compression banners keep reading the foreign count. The cached
    // content count belongs to the same foreign route's last response.
    this.telemetryService?.setLastPromptTokenCount(0);
    this.telemetryService?.setLastCachedContentTokenCount(0);
  }

  /**
   * Save the current slots into {@link tokenCountsByRouteKey} under their
   * owning route key so a later read keyed back to that route restores the
   * exact API-reported values. Zero slots carry nothing worth retaining;
   * the telemetry mirror still holds the owning route's cached-content
   * count at this point, so it is captured here too.
   */
  private retainCurrentTokenCounts(): void {
    if (
      this.tokenCountsRouteKey === undefined ||
      (this.lastPromptTokenCount === 0 && this.lastOutputTokenCount === 0)
    ) {
      return;
    }
    if (this.tokenCountsByRouteKey.size >= MAX_RETAINED_ROUTE_COUNTS) {
      const oldestKey = this.tokenCountsByRouteKey.keys().next().value;
      if (oldestKey !== undefined) {
        this.tokenCountsByRouteKey.delete(oldestKey);
      }
    }
    this.tokenCountsByRouteKey.set(this.tokenCountsRouteKey, {
      promptTokenCount: this.lastPromptTokenCount,
      promptTokenCountIsEstimated: this.lastPromptTokenCountIsEstimated,
      outputTokenCount: this.lastOutputTokenCount,
      // Optional chaining keeps partial telemetry test mocks from throwing
      // (same convention as currentRouteKey's Config lookups).
      cachedContentTokenCount:
        this.telemetryService?.getLastCachedContentTokenCount?.() ?? 0,
    });
  }

  /**
   * Most recent prompt-token count reported by the model for *this* chat,
   * mirroring the value in {@link UiTelemetryService} for the main session.
   * Subagent chats have no telemetry service wired but still need a per-chat
   * count for compaction decisions, so this is always populated regardless
   * of whether the global telemetry is updated.
   */
  getLastPromptTokenCount(targetRouteKey?: string): number {
    this.adoptTokenCountsForRoute(targetRouteKey);
    return this.lastPromptTokenCount;
  }

  /** Previous model-response tokens used by the next prompt estimate. */
  getLastOutputTokenCount(): number {
    this.adoptTokenCountsForRoute();
    return this.lastOutputTokenCount;
  }

  /**
   * Builds request contents for the content generator without deep-cloning the
   * whole chat history. This is an internal hot path: long sessions can make a
   * full `structuredClone` larger than the remaining V8 heap headroom.
   *
   * Public history readers still use {@link getHistory}, which returns a
   * defensive deep copy for caller mutation safety.
   */
  private getRequestHistory(currentUserContent?: Content): Content[] {
    const curatedHistory = extractCuratedHistory(this.history);
    const { maxRecentImages, imagePayloadThreshold } = resolveCompactionTuning(
      this.config.getChatCompression(),
    );
    let replaced: ReturnType<typeof replaceImagePayloadsInPlace> = [];
    if (countAllInlineImages(curatedHistory) >= imagePayloadThreshold) {
      const skipEntry = currentUserContent
        ? curatedHistory.find(
            (c) =>
              c === currentUserContent ||
              (c.role === 'user' &&
                currentUserContent.parts?.some((p) => c.parts?.includes(p))),
          )
        : undefined;
      replaced = replaceImagePayloadsInPlace(
        curatedHistory,
        this.imagePayloadStore,
        skipEntry,
      );
    }
    const requestHistory = curatedHistory.map(copyContentContainer);
    const reattachParts = buildReattachParts(
      replaced,
      maxRecentImages,
      requestHistory,
      this.imagePayloadStore,
    );
    if (reattachParts.length > 0) {
      const last = requestHistory.at(-1);
      if (last?.role === 'user') {
        last.parts = [...(last.parts ?? []), ...reattachParts];
      } else {
        requestHistory.push({ role: 'user', parts: reattachParts });
      }
    }
    return requestHistory;
  }

  private getRequestHistoryForRoute(
    currentUserContent: Content | undefined,
    supportedModalities: InputModalities,
  ): Content[] {
    return slimCompactionInput(
      this.getRequestHistory(currentUserContent),
      supportedModalities,
    ).slimmedHistory;
  }

  /**
   * Seed the last-prompt-token-count for chats created with inherited
   * history (forks, subagents, speculation). Without this, the auto-compress
   * threshold check sees `0` and refuses to compress — so the first API call
   * can 400 from oversized history. Callers pass the parent chat's
   * `getLastPromptTokenCount()` here. This also clears any remembered
   * previous-response output token count because the seeded prompt count
   * comes from a different chat instance and should not inherit this chat's
   * last response size.
   */
  setLastPromptTokenCount(count: number, isEstimated = false): void {
    this.lastPromptTokenCount = count;
    this.lastPromptTokenCountIsEstimated = isEstimated;
    this.lastOutputTokenCount = 0;
    this.tokenCountsRouteKey = this.currentRouteKey();
    // A fresh count supersedes anything this route retained while another
    // route owned the slots. Without the delete this writer alone among the
    // count writers would leave an entry for tokenCountsRouteKey behind,
    // breaking the map's documented invariant (#9506).
    this.tokenCountsByRouteKey.delete(this.tokenCountsRouteKey);
  }

  isLastPromptTokenCountEstimated(): boolean {
    this.adoptTokenCountsForRoute();
    return this.lastPromptTokenCountIsEstimated;
  }

  private promptCountIsEstimateDerived(): boolean {
    return (
      this.lastPromptTokenCount === 0 || this.lastPromptTokenCountIsEstimated
    );
  }

  /**
   * Seed the restored prompt and previous-response output token counts in one
   * step. Resume restores chat history plus both counters and their provenance
   * from the same checkpoint, so callers must avoid the normal
   * setLastPromptTokenCount() clearing behavior.
   */
  seedResumeTokenCounts(
    promptTokenCount: number,
    outputTokenCount: number,
    isEstimated = false,
  ): void {
    this.lastPromptTokenCount = Number.isFinite(promptTokenCount)
      ? Math.max(0, promptTokenCount)
      : 0;
    this.lastPromptTokenCountIsEstimated = isEstimated;
    this.lastOutputTokenCount = Number.isFinite(outputTokenCount)
      ? Math.max(0, outputTokenCount)
      : 0;
    // Attribute the seeded counts to the active route so a model switch
    // after resume invalidates them like any API-reported count. (Detecting
    // a route that already differed at save time requires persisting route
    // identity in the session transcript; tracked as a follow-up to #9454.)
    this.tokenCountsRouteKey = this.currentRouteKey();
    // A fresh seed supersedes any count this route retained while another
    // route owned the slots (#9506).
    this.tokenCountsByRouteKey.delete(this.tokenCountsRouteKey);
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
    force = false,
    signal?: AbortSignal,
    options?: TryCompressOptions,
  ): Promise<ChatCompressionInfo> {
    // Counts from a pre-switch route must not anchor compression admission
    // or sizing for this route (#9454). In-send callers pass the request
    // route so the adoption never re-adopts the active route's retained
    // counts mid-send (#9506).
    this.adoptTokenCountsForRoute(options?.requestRouteKey);

    const originalTokenCountOverride = options?.originalTokenCountOverride;
    // Provenance follows the count source selected for THIS attempt, not
    // which inputs merely happen to be present:
    // - an override is authoritative only when it carries a provider-reported
    //   count (reactive overflow `actualTokens`); limit/config/default
    //   fallbacks stay estimated;
    // - a caller-precomputed effective count (auto-compaction / hard-tier
    //   rescue) always folds in locally estimated parts (pending user
    //   message, previous output), so it stays estimated even when the
    //   stored baseline came from the API;
    // - otherwise the count is the stored lastPromptTokenCount and inherits
    //   the provenance tracked for it.
    const originalTokenCountIsEstimated =
      originalTokenCountOverride !== undefined
        ? originalTokenCountOverride.isEstimated
        : options?.precomputedEffectiveTokens !== undefined ||
          this.promptCountIsEstimateDerived();
    const originalTokenCount =
      originalTokenCountOverride !== undefined
        ? originalTokenCountOverride.count
        : originalTokenCountIsEstimated
          ? (options?.precomputedEffectiveTokens ??
            estimateContentTokens(
              options?.pendingUserMessage
                ? [...this.getHistoryShallow(true), options.pendingUserMessage]
                : this.getHistoryShallow(true),
              resolveSlimmingConfig(this.config.getChatCompression())
                .imageTokenEstimate,
            ))
          : this.lastPromptTokenCount;
    debugLogger.debug(
      `[compaction] token-count provenance: prompt_id=${promptId}, ` +
        `originalTokenCount=${originalTokenCount}, ` +
        `estimated=${originalTokenCountIsEstimated}`,
    );
    const service = new ChatCompressionService();
    const { newHistory, info } = await service.compress(this, {
      promptId,
      force,
      config: this.config,
      consecutiveFailures: this.consecutiveFailures,
      originalTokenCount,
      pendingUserMessage: options?.pendingUserMessage,
      precomputedEffectiveTokens: options?.precomputedEffectiveTokens,
      requestGenerationConfig: options?.requestGenerationConfig,
      trigger: options?.trigger,
      customInstructions: options?.customInstructions,
      signal,
    });
    // The service owns the compression outcome; LlmChat owns the input
    // provenance. Expose it so UIs can mark estimated banner numbers
    // instead of presenting cross-path scale changes as lost context
    // (#9309).
    info.originalTokenCountIsEstimated = originalTokenCountIsEstimated;

    // ChatCompressionService reads the keyless count getters, which adopt
    // the ACTIVE route — flipping the slots away from the request route
    // adopted above whenever the two differ (non-exact override sends).
    // Re-adopt the request route so neither the COMPRESSED stamp below nor
    // the caller's post-compression sizing anchors on the flipped
    // attribution (#9506).
    this.adoptTokenCountsForRoute(options?.requestRouteKey);

    if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
      // ChatCompressionService owns provenance. Keep a conservative fallback
      // for older/custom implementations that omit the field, but preserve an
      // explicit authoritative `false`.
      info.newTokenCountIsEstimated ??= true;
      if (!options?.deferChatCompressionRecord) {
        this.chatRecordingService?.recordChatCompression({
          info,
          compressedHistory: newHistory,
        });
      }
      this.setHistory(newHistory);
      debugLogger.debug('[FILE_READ_CACHE] clear after auto tryCompress');
      this.config.getFileReadCache().clear();
      // Compression rewrote the shared history every retained entry sizes,
      // so ALL retained counts are stale — not just the current route's.
      // Drop them, or a later keyed read adopts a pre-compression count and
      // the session-token-limit gate blocks a prompt that fits the
      // compressed history (#9506).
      this.tokenCountsByRouteKey.clear();
      // Loaded-skill tracking was conservatively cleared by the setHistory
      // above — no second sync here.
      this.setLastPromptTokenCount(
        info.newTokenCount,
        info.newTokenCountIsEstimated,
      );
      // setLastPromptTokenCount re-keyed the fresh count to the ACTIVE
      // route, but in-send callers compress for the REQUEST route: the
      // session-token-limit gate reads by that key (client.ts's sole
      // SessionTokenLimitExceeded yield site), and a request that ends
      // without a usage report (abort, 400 — the reactive-overflow path
      // exists for exactly those) never stamps a count of its own. Re-key
      // the fresh count to the request route, retaining it under the
      // active key first: the compressed history is shared, so the count
      // must anchor BOTH routes' next gate reads (#9506).
      if (
        options?.requestRouteKey &&
        this.tokenCountsRouteKey !== options.requestRouteKey
      ) {
        this.retainCurrentTokenCounts();
        this.tokenCountsRouteKey = options.requestRouteKey;
        // Same invariant as the other count writers: the fresh count
        // supersedes anything the request route retained.
        this.tokenCountsByRouteKey.delete(options.requestRouteKey);
      }
      this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
      // Reset the consecutive-failure counter on success so a forced /compress
      // (or any successful compaction) recovers a chat whose breaker had
      // tripped.
      this.consecutiveFailures = 0;
      this.hardRescueFailureCount = 0;
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
    // A pre-switch route's count must not anchor fast-compression sizing
    // for the active route (#9454).
    this.adoptTokenCountsForRoute();
    // Use the same estimator on both sides so the NOOP gate compares
    // apples to apples. The API-authoritative lastPromptTokenCount is
    // then adjusted by the estimated delta — never replaced wholesale.
    const beforeEstimate = estimateContentTokens(this.history);
    const projectRoot = this.config.getProjectRoot();
    const targetDir = this.config.getTargetDir?.() ?? projectRoot;

    // Step 1: force microcompaction (clear old tool results + media)
    const mcResult = microcompactHistory(
      this.history,
      null,
      this.config.getClearContextOnIdle(),
      {
        force: true,
        preserveReadFileResult: (filePath) =>
          isManagedMemoryPath(filePath, projectRoot, targetDir),
      },
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
          originalTokenCountIsEstimated: this.promptCountIsEstimateDerived(),
          compressionStatus: CompressionStatus.NOOP,
        },
      };
    }

    const reduction = beforeEstimate - afterEstimate;
    const apiBaseline = this.lastPromptTokenCount || beforeEstimate;
    const baselineIsEstimated = this.promptCountIsEstimateDerived();
    const adjustedTokenCount = Math.max(0, apiBaseline - reduction);

    debugLogger.debug(
      `[compaction] fast token-count provenance: ` +
        `originalTokenCount=${apiBaseline}, estimated=${baselineIsEstimated}`,
    );

    const info: ChatCompressionInfo = {
      originalTokenCount: apiBaseline,
      newTokenCount: adjustedTokenCount,
      originalTokenCountIsEstimated: baselineIsEstimated,
      newTokenCountIsEstimated: true,
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
    this.lastPromptTokenCount = adjustedTokenCount;
    this.lastPromptTokenCountIsEstimated = true;
    this.tokenCountsRouteKey = this.currentRouteKey();
    // Fast compression rewrote the shared history every retained entry
    // sizes, so ALL retained counts are stale — the other routes' entries
    // describe the same pre-compression history (#9506).
    this.tokenCountsByRouteKey.clear();
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
    goalContext?: GoalTurnPermit,
    options?: LlmChatSendOptions,
  ): Promise<AsyncGenerator<StreamEvent>> {
    const turnGoalContext = goalContext ? { ...goalContext } : undefined;
    const fullTurnRoute = model.endsWith('\0');
    const exactRoute = fullTurnRoute
      ? await this.config
          .getBaseLlmClient()
          .resolveForModel(model.slice(0, -1), { failClosed: true })
      : undefined;
    if (exactRoute) {
      model = exactRoute.model;
    }
    // Both arms are one call: for a non-exact send `exactRoute` is
    // undefined, and `resolvedModelIdentity`'s second parameter defaults to
    // `getContentGeneratorConfig()` — including when passed an explicit
    // undefined. Keeping a single call site means a future change to how
    // the request route is identified cannot drift between the arms.
    const requestRouteKey = this.config.getModelRouteIdentity(
      model,
      exactRoute?.contentGeneratorConfig,
    );
    // Counts recorded for a route other than this request's target must not
    // anchor its admission/clamp/compression decisions (#9454). Comparing
    // against the REQUEST route — resolved above — keeps an exact `\0`
    // route's decisions off the active route's counts, and a differing
    // `model` param gets its own identity instead of borrowing the active
    // route's. The crossing retains the current counts under their own
    // route key so a later turn back on that route restores them (#9506).
    this.adoptTokenCountsForRoute(requestRouteKey);
    const requestModalities =
      exactRoute?.contentGeneratorConfig.modalities ??
      this.config.getEffectiveInputModalities();

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
    let manualPlanExitNoticeVersion: number | undefined;
    let manualPlanExitNoticeText: string | undefined;

    // Determine the ceiling for this turn's output request. The clamp below
    // (see clampOutputTokensToWindow) sizes the actual max_tokens to the room
    // left in the window, so output can never overflow the context limit and
    // compaction thresholds run against the FULL window — no output
    // reservation is subtracted (this replaces the #5957/#6266 reservation
    // machinery; see the max-tokens-window-clamp design doc).
    //
    // The ceiling is the explicit user/subagent value when one is set
    // (params.config.maxOutputTokens from subagents, samplingParams.max_tokens
    // or QWEN_CODE_MAX_OUTPUT_TOKENS from user config), else
    // defaultOutputCeiling(model) (the model's output limit clipped to
    // OUTPUT_TOKEN_CEILING).
    const cgConfigForThresholds =
      exactRoute?.contentGeneratorConfig ??
      this.config.getContentGeneratorConfig();
    const parsedEnvMaxTokensForClamp = parsePositiveIntegerEnvValue(
      process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
    );
    const explicitOutputCeiling: number | undefined =
      params.config?.maxOutputTokens ??
      cgConfigForThresholds?.samplingParams?.max_tokens ??
      parsedEnvMaxTokensForClamp;
    const outputCeiling: number =
      explicitOutputCeiling ?? defaultOutputCeiling(model);
    // Declared at function level so the MAX_TOKENS escalation path inside
    // the generator closure can re-clamp against the same window and prompt
    // estimate.
    const contextWindowForClamp =
      cgConfigForThresholds?.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;
    let promptTokensForClamp = 0;

    let currentUserContent: Content | undefined;
    try {
      // The send-lock above is held but the generator's `finally` (which
      // resolves it) has not run yet. Any setup error before returning the
      // generator must release the lock or subsequent sends will block forever
      // at `await this.sendPromise`.
      // Build the user content BEFORE compression so the cheap-gate can size
      // the upcoming prompt — closes the "first send after inherited history"
      // gap where `lastPromptTokenCount === 0` and the gate would otherwise
      // see only the stale prior-turn count (0).
      let userContent = createUserContent(params.message);
      const toolOutputBudget = this.config.getToolOutputBatchBudget?.();
      if (
        toolOutputBudget !== undefined &&
        Number.isFinite(toolOutputBudget) &&
        userContent.parts
      ) {
        const [guarded] = enforceFunctionResponseBudget(
          [
            {
              callId: 'send-boundary',
              toolName: 'tool-response-batch',
              responseParts: userContent.parts,
            },
          ],
          toolOutputBudget,
        );
        if (guarded.responseParts !== userContent.parts) {
          debugLogger.warn(
            `Tool response send guard reduced an unfinalized batch to ${toolOutputBudget} characters.`,
          );
          userContent = { ...userContent, parts: guarded.responseParts };
        }
      }

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
      // The cheap-gate consecutive-failure counter is NOT pre-reset here.
      // force=true already bypasses that breaker, while hard-rescue itself is
      // bounded by hardRescueFailureCount so persistent pre-send rescue
      // failures fall through to reactive overflow after a few strikes.
      // Thresholds gate on the full window: the output clamp guarantees the
      // response fits, so nothing needs to be pre-reserved for it.
      const { hard } = computeThresholds(
        contextWindowForClamp,
        this.config.getAutoCompactThreshold(),
      );
      const imageTokenEstimate = resolveSlimmingConfig(
        this.config.getChatCompression(),
      ).imageTokenEstimate;
      // When lastPromptTokenCount > 0, estimatePromptTokens uses the
      // API-authoritative previous prompt count + the previous response's
      // output token count + a tiny estimate of just the new user message.
      // It does NOT touch the history at all in that branch, so skip the
      // costly `getHistory(true)` clone on the steady-state path.
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
        this.lastOutputTokenCount,
        imageTokenEstimate,
      );
      const isHardTier = effectiveTokens >= hard;
      const shouldForceFromHard =
        !exactRoute &&
        isHardTier &&
        this.hardRescueFailureCount < MAX_CONSECUTIVE_FAILURES;
      const historyBeforeHardRescue = shouldForceFromHard
        ? this.getHistoryShallow()
        : undefined;
      const lastPromptTokenCountBeforeHardRescue = this.lastPromptTokenCount;
      const lastPromptTokenCountWasEstimatedBeforeHardRescue =
        this.lastPromptTokenCountIsEstimated;
      // The rescue's COMPRESSED stamp zeroes lastOutputTokenCount (via
      // setLastPromptTokenCount), so the rollback below must restore the
      // output half of the resurrected count pair alongside the prompt
      // half, or the next turn's additive prompt estimate under-counts by
      // the last response's size (#9506).
      const lastOutputTokenCountBeforeHardRescue = this.lastOutputTokenCount;
      // tryCompress re-stamps tokenCountsRouteKey to the ACTIVE route (via
      // setLastPromptTokenCount on the success path) even though this send
      // targets the REQUEST route — and hard-rescue only fires for
      // non-exact sends, whose request key can differ from the active one.
      // Capture the key so the rollback below restores the resurrected
      // count's original route attribution along with the count itself.
      const tokenCountsRouteKeyBeforeHardRescue = this.tokenCountsRouteKey;
      // Snapshot the retention map too: the rescue's compression consumes
      // retained entries mid-flight (ChatCompressionService's keyless getter
      // reads adopt the active route, deleting-and-consuming its entry) and
      // a successful compression clears the map outright. Without the
      // snapshot the rollback would restore the slots but not the map,
      // leaving the resurrected route's count nowhere (#9506).
      const retainedTokenCountsBeforeHardRescue = new Map(
        this.tokenCountsByRouteKey,
      );
      const hardRescueFailureCountBeforeHardRescue =
        this.hardRescueFailureCount;
      if (shouldForceFromHard) {
        debugLogger.warn(
          `[compaction] hard-tier rescue triggered: prompt_id=${prompt_id}, effectiveTokens=${effectiveTokens}, hard=${hard}, hardRescueAttempt=${this.hardRescueFailureCount + 1}, consecutiveFailures=${this.consecutiveFailures}.`,
        );
      } else if (isHardTier && !exactRoute) {
        debugLogger.warn(
          `[compaction] hard-tier rescue skipped after ${this.hardRescueFailureCount} failed attempts; relying on reactive overflow recovery. prompt_id=${prompt_id}, effectiveTokens=${effectiveTokens}, hard=${hard}.`,
        );
      }

      if (exactRoute || (isHardTier && !shouldForceFromHard)) {
        compressionInfo = {
          originalTokenCount: effectiveTokens,
          newTokenCount: effectiveTokens,
          compressionStatus: CompressionStatus.NOOP,
        };
      } else {
        compressionInfo = await this.tryCompress(
          prompt_id,
          shouldForceFromHard,
          params.config?.abortSignal,
          {
            pendingUserMessage: userContent,
            precomputedEffectiveTokens: effectiveTokens,
            requestGenerationConfig: params.config,
            requestRouteKey,
            deferChatCompressionRecord: shouldForceFromHard,
            // Hard-rescue is force=true to bypass the cheap-gate breaker
            // but it remains a semantically AUTOMATIC trigger. Tag the
            // compactTrigger explicitly as 'auto' so PostCompact hooks are
            // classified correctly while the pending user message preserves
            // any active tool-call / response pairing.
            trigger: shouldForceFromHard ? 'auto' : undefined,
          },
        );
      }
      const localPromptTokensAfterCompression = shouldForceFromHard
        ? estimatePromptTokens(
            this.lastPromptTokenCount > 0 ? [] : this.getHistoryShallow(true),
            userContent,
            this.lastPromptTokenCount,
            this.lastOutputTokenCount,
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
        if (shouldForceFromHard) {
          this.hardRescueFailureCount =
            hardRescueFailureCountBeforeHardRescue + 1;
        }
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
          // setHistory conservatively cleared loaded-skill tracking; the
          // restored bodies re-arm it on their next invoke.
          this.lastPromptTokenCount = lastPromptTokenCountBeforeHardRescue;
          this.lastPromptTokenCountIsEstimated =
            lastPromptTokenCountWasEstimatedBeforeHardRescue;
          this.lastOutputTokenCount = lastOutputTokenCountBeforeHardRescue;
          this.tokenCountsRouteKey = tokenCountsRouteKeyBeforeHardRescue;
          // Restore the retention map alongside the slots: the rescue's
          // compression consumed/cleared entries mid-flight, and without
          // the restore the resurrected route's count would survive
          // nowhere — its next gate read would pass with 0 (#9506). The
          // snapshot predates the rescue, so it already satisfies the
          // invariant (no entry for the resurrected slot key).
          this.tokenCountsByRouteKey.clear();
          for (const [
            retainedRouteKey,
            retainedCounts,
          ] of retainedTokenCountsBeforeHardRescue) {
            this.tokenCountsByRouteKey.set(retainedRouteKey, retainedCounts);
          }
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
            `${compressionInfo.newTokenCount}, hardRescueFailureCount=` +
            `${this.hardRescueFailureCount}, consecutiveFailures=` +
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

      if (this.manualPlanExitNoticesEnabled) {
        const notice = this.config.takePendingManualPlanExitNotice();
        if (notice) {
          manualPlanExitNoticeVersion = notice.version;
          manualPlanExitNoticeText = getManualPlanExitSystemReminder(
            notice.currentMode,
          );
          userContent = {
            ...userContent,
            parts: [
              ...(userContent.parts ?? []),
              {
                text: manualPlanExitNoticeText,
              },
            ],
          };
        }
      }

      // Add user content to history ONCE before any attempts.
      this.history.push(userContent);
      currentUserContent = userContent;
      userContentAdded = true;
      // Record that the user content landed (see `userContentPushCount`). The
      // setup-error path below decrements this if it rolls the push back.
      this.userContentPushCount++;
      // Per-send orphan repair (belt-and-suspenders alongside the
      // startChat load-time pass). Runs AFTER user content lands so a
      // user-supplied tool_result closes the pair before we synthesize
      // anything. An ordinary prompt that races a restore re-hang must
      // still close the pair — `model[functionCall] → user[text]` is
      // rejected by Anthropic-compatible providers. Restore itself sends
      // the real functionResponse, so this pass is a no-op on that path.
      const inlineRepair = repairOrphanedToolUseTurns(
        this.history,
        ORPHAN_TOOL_USE_REPAIR_REASON,
      );
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
      requestContents = this.getRequestHistoryForRoute(
        currentUserContent,
        requestModalities,
      );

      // Window-clamp the output request AFTER compression has settled the
      // history: max_tokens = min(ceiling, window − prompt − margin), floored
      // at MIN_CLAMPED_OUTPUT_TOKENS. Computed here in the send path — not in
      // the shared provider code — so the API-authoritative
      // lastPromptTokenCount is in scope and side queries (which set their
      // own maxOutputTokens via getBaseLlmClient()) stay exempt by
      // construction. This makes `prompt + max_tokens ≤ window` an invariant
      // on every main-turn request (issue #5950).
      //
      // When lastPromptTokenCount > 0 (steady state, or refreshed to
      // newTokenCount by compression/resume), re-estimate from the counts —
      // cheap, no history walk. When it is still 0, reuse the pre-push gate
      // estimate: userContent is already in history here, so a fresh history
      // walk would double-count it. Estimate-derived counts can omit the
      // system prompt, tool definitions, and skill content (see
      // estimatePromptTokens — "typically ~15-20K of under-estimate"). Some
      // counts based on prior API usage already preserve part of that
      // overhead, but conservatively double-counting it is safe and
      // self-corrects when provider usage arrives. An under-count is the ONE
      // way `prompt + max_tokens` can still overflow the window, so keep the
      // pad until provider usage replaces the estimate.
      promptTokensForClamp =
        this.lastPromptTokenCount > 0
          ? estimatePromptTokens(
              [],
              userContent,
              this.lastPromptTokenCount,
              this.lastOutputTokenCount,
              imageTokenEstimate,
              /* conservative= */ true,
            )
          : effectiveTokens;
      if (this.promptCountIsEstimateDerived()) {
        promptTokensForClamp += ESTIMATE_CLAMP_OVERHEAD_PAD;
        debugLogger.debug(
          `[clamp] estimate-derived prompt count; padded by ` +
            `${ESTIMATE_CLAMP_OVERHEAD_PAD}: ` +
            `promptTokensForClamp=${promptTokensForClamp}, ` +
            `count=${this.lastPromptTokenCount}`,
        );
      }
      const clampedMaxOutputTokens = clampOutputTokensToWindow(
        outputCeiling,
        contextWindowForClamp,
        promptTokensForClamp,
      );
      params = {
        ...params,
        config: {
          ...params.config,
          maxOutputTokens: clampedMaxOutputTokens,
        },
      };
    } catch (error) {
      if (userContentAdded) {
        this.history.pop();
        // The push above was rolled back, so undo its count too.
        this.userContentPushCount--;
      }
      if (manualPlanExitNoticeVersion !== undefined) {
        this.config.restorePendingManualPlanExitNotice(
          manualPlanExitNoticeVersion,
        );
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
        let transientInvalidStreamRetryCount = 0;
        let protocolTagLeakRetryCount = 0;
        const totalInvalidStreamRetryCount = () =>
          transientInvalidStreamRetryCount + protocolTagLeakRetryCount;
        // The armed attempt can be rescheduled by a competing retry path
        // (rate limit, transport replay/continuation, reactive compression)
        // before its outcome is known; the rescheduled attempt is still the
        // last one the exhausted invalid-stream budget allows, so keep the
        // one-shot quiet-completion acceptance armed for it (#9026).
        const rearmQuietAcceptanceIfBudgetSpent = () => {
          // Keyed to the transient bucket only: quiet completions surface
          // as NO_TOOL_RESULT_PROGRESS (a transient type), so only a spent
          // transient budget entitles the next attempt to acceptance. A
          // tag-leak-only exhaustion must not arm — a quiet ending still
          // has its full retry-first budget ahead of it (#7039).
          if (
            transientInvalidStreamRetryCount >=
            INVALID_STREAM_RETRY_CONFIG.transientMaxRetries
          ) {
            acceptQuietToolResultCompletionOnNextAttempt = true;
          }
        };
        let transportStreamRetryCount = 0;
        // Continuation recovery for mid-stream socket closes (issue #7832).
        // `transportContinuationText` accumulates every plain-text chunk this
        // send has already handed to callers across all continuation attempts,
        // so each attempt can show the model its own visible output and ask it
        // to resume instead of replaying (which would duplicate that output).
        // Attempts are folded in one at a time, each with any overlap it
        // replayed stripped, so the buffer holds no fragment twice.
        let transportContinuationCount = 0;
        let transportContinuationText = '';
        // Text delivered by the attempt currently running, before it is folded
        // into `transportContinuationText`. Kept separate so the overlap a
        // continuation attempt replays is stripped once, at the attempt
        // boundary where it occurs, rather than per chunk — the overlap scan is
        // suffix-anchored and would eat legitimately repeated text mid-stream.
        let transportAttemptText = '';
        // Text delivered *before* the attempt currently running. Empty unless
        // a continuation is in flight. `processStreamResponse` only pushes the
        // final attempt's own output to history, so this is what has to be
        // prepended once the send succeeds, or the next turn would see the
        // model's answer starting mid-sentence.
        let transportContinuationPrefix = '';
        let reactiveCompressionAttempted = false;
        let suppressNextRetryEvent = false;
        let streamYieldedAnyChunk = false;

        // Read per-config overrides; fall back to built-in defaults.
        const cgConfig =
          exactRoute?.contentGeneratorConfig ??
          self.config.getContentGeneratorConfig();
        const requestOverrides = exactRoute
          ? {
              contentGenerator: exactRoute.contentGenerator,
              retryAuthType: exactRoute.retryAuthType,
              retryErrorCodes: exactRoute.retryErrorCodes,
            }
          : undefined;
        const maxRateLimitRetries =
          cgConfig?.maxRetries ?? RATE_LIMIT_RETRY_OPTIONS.maxRetries;
        const retryInitialDelayMs =
          cgConfig?.retryInitialDelayMs ??
          RATE_LIMIT_RETRY_OPTIONS.initialDelayMs;
        const retryMaxDelayMs =
          cgConfig?.retryMaxDelayMs ?? RATE_LIMIT_RETRY_OPTIONS.maxDelayMs;
        const extraRetryErrorCodes = cgConfig?.retryErrorCodes;

        // Max output tokens escalation: when no user/env override is set and
        // the model hits MAX_TOKENS, retry once with the escalated limit.
        let maxTokensEscalated = false;
        const parsedEnvMaxTokens = parsePositiveIntegerEnvValue(
          process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
        );
        const hasUserMaxTokensOverride =
          (cgConfig?.samplingParams?.max_tokens !== undefined &&
            cgConfig?.samplingParams?.max_tokens !== null) ||
          parsedEnvMaxTokens !== undefined;
        // params.config.maxOutputTokens is set by the first-send clamp; the
        // outputCeiling fallback is defensive and should not fire in practice.
        const effectiveInitialMaxOutputTokens =
          params.config?.maxOutputTokens ?? outputCeiling;
        const escalatedLimit = clampOutputTokensToWindow(
          OUTPUT_TOKEN_CEILING,
          contextWindowForClamp,
          promptTokensForClamp,
        );
        const shouldEscalateMaxOutputTokens =
          effectiveInitialMaxOutputTokens < escalatedLimit;

        let lastFinishReason: string | undefined;

        /**
         * Contents for the next attempt. Identical to `requestContents` on
         * every normal send; while a transport continuation is pending it
         * appends the two synthetic turns that carry the delivered output and
         * the instruction to resume from it. Built per attempt and never
         * written to `self.history`, so the synthetic turns cannot leak into
         * durable history, the JSONL transcript, or a later compression —
         * unlike the MAX_TOKENS recovery loop, which has to route through
         * history and clean up afterwards with `coalesceRecoveryPairs`.
         */
        const buildAttemptContents = (): Content[] =>
          transportContinuationPrefix.length > 0
            ? [
                ...requestContents,
                {
                  role: 'model',
                  parts: [{ text: transportContinuationPrefix }],
                },
                createUserContent([
                  {
                    text: buildRecoveryMessageFromText(
                      TRANSPORT_CONTINUATION_MESSAGE,
                      transportContinuationPrefix,
                    ),
                  },
                ]),
              ]
            : requestContents;

        /**
         * Forget any in-flight continuation.
         *
         * Called from every branch that re-sends the *original* request, since
         * those emit a `RETRY` without `isContinuation` and the UI drops the
         * delivered text on that event. The request has to drop it too, or the
         * resend would keep asking the model to resume output the caller no
         * longer has — and a later success would merge that discarded text back
         * into history, leaving the UI and history permanently out of step.
         */
        const resetTransportContinuation = () => {
          transportContinuationCount = 0;
          transportContinuationText = '';
          transportAttemptText = '';
          transportContinuationPrefix = '';
        };

        // Fold the running attempt's text into the accumulated buffer,
        // stripping any overlap it replayed from the previous attempt's tail,
        // so the accumulated buffer never contains text twice.
        //
        // Called on the cut exit only. The success exit merges the prefix into
        // history and breaks, and nothing reads the buffer after the loop, so
        // folding there would have no reader. A post-loop read added later
        // (telemetry, a MAX_TOKENS-recovery guard) would be missing the final
        // attempt's text and must fold on the success path too.
        const foldTransportAttemptText = () => {
          transportContinuationText += getRecoveryContinuationSuffix(
            transportContinuationText,
            transportAttemptText,
          );
          transportAttemptText = '';
        };

        let acceptQuietToolResultCompletionOnNextAttempt = false;
        for (;;) {
          transportAttemptText = '';
          let streamYieldedChunk = false;
          let streamYieldedContentChunk = false;
          // A cut that already delivered a `functionCall` cannot be continued
          // from — see the continuation gate below.
          let streamYieldedFunctionCall = false;
          try {
            if (suppressNextRetryEvent) {
              // The branch that scheduled this attempt already emitted its own
              // RETRY, and — if that RETRY was a fresh restart rather than a
              // continuation — already called `resetTransportContinuation`.
              // Resetting again here would clear the state of a continuation
              // that is legitimately in flight.
              suppressNextRetryEvent = false;
            } else if (
              rateLimitRetryCount > 0 ||
              totalInvalidStreamRetryCount() > 0 ||
              transportStreamRetryCount > 0 ||
              transportContinuationCount > 0
            ) {
              // A fresh-restart retry reaching this point means a branch that
              // does not set `suppressNextRetryEvent` (rate limit, invalid
              // stream) chose to re-send the original request.
              resetTransportContinuation();
              yield { type: StreamEventType.RETRY };
            }

            const acceptQuietToolResultCompletion =
              acceptQuietToolResultCompletionOnNextAttempt;
            acceptQuietToolResultCompletionOnNextAttempt = false;
            const stream = await self.makeApiCallAndProcessStream(
              model,
              buildAttemptContents(),
              params,
              prompt_id,
              requestOverrides,
              requestRouteKey,
              turnGoalContext,
              // Captured by value, so the attempt records exactly the prefix
              // `buildAttemptContents()` just asked the model to resume from,
              // even if a later branch resets the continuation.
              transportContinuationPrefix.length > 0
                ? transportContinuationPrefix
                : undefined,
              acceptQuietToolResultCompletion,
            );

            lastFinishReason = undefined;
            for await (const chunk of stream) {
              if (hasCandidateOutput(chunk)) {
                streamYieldedChunk = true;
                streamYieldedAnyChunk = true;
              }
              if (hasNonThoughtCandidateParts(chunk)) {
                streamYieldedContentChunk = true;
              }
              // Mirror the visible text into the continuation buffer as it is
              // yielded. Reading it back off history is not an option on the
              // transport path: processStreamResponse deliberately does NOT
              // persist a text-only partial turn when the stream throws, so at
              // the catch below history holds nothing about what the user
              // already saw.
              const chunkParts = chunk.candidates?.[0]?.content?.parts;
              transportAttemptText += getPlainTextFromParts(chunkParts);
              if (chunkParts?.some((part) => part.functionCall)) {
                streamYieldedFunctionCall = true;
              }
              const fr = chunk.candidates?.[0]?.finishReason;
              if (fr) lastFinishReason = fr;
              yield { type: StreamEventType.CHUNK, value: chunk };
            }

            lastError = null;
            // The merge itself now happens inside `processStreamResponse`,
            // which folds the prefix into the parts before it writes either
            // the JSONL record or the history turn (issue #8094). Merging
            // again here would risk double-applying it: the dedup helper only
            // strips a replayed prefix that clears its significance floor, so
            // a short prefix would survive the second pass and be doubled.
            transportContinuationPrefix = '';
            break;
          } catch (error) {
            lastError = error;
            // This attempt is over; fold what it delivered into the running
            // buffer before any branch below reads it. Doing this here rather
            // than per chunk keeps the overlap scan anchored at the attempt
            // boundary, which is the only place a replay can occur.
            foldTransportAttemptText();

            // Handle rate-limit / throttling errors returned as stream content.
            // These arrive as StreamContentError with finish_reason="error_finish"
            // from the pipeline, containing the throttling message in the content.
            // Covers TPM throttling, GLM rate limits, and other provider throttling.
            // Classify once per failed attempt; reused by the rate-limit
            // diagnostics below and the transport-retry decision further down.
            const classification = classifyRetryError(error, {
              authType: cgConfig?.authType,
              extraRetryErrorCodes,
            });

            // Permanent quota exhaustion (e.g. Bailian token-plan "1-week
            // quota has been exhausted, will reset at ...") can arrive
            // mid-stream as a StreamContentError, bypassing retryWithBackoff
            // (which only wraps stream establishment). Fast-fail before the
            // rate-limit branch: its 429 code would otherwise schedule a 1-5
            // minute delay on an error that cannot succeed until the reset
            // time. Throws a plain Error (no .status) and skips model
            // fallback, matching the retryWithBackoff fast-fail.
            if (isQuotaExhaustedError(error)) {
              debugLogger.warn('Quota exhausted mid-stream, fast-failing', {
                retryPath: 'stream',
                retryDecision: 'fail-fast',
                errorKind: classification.kind,
                classificationReason: classification.reason,
              });
              throw new Error(formatQuotaExhaustedMessage(error), {
                cause: error,
              });
            }

            const isRateLimit = isRateLimitError(error, extraRetryErrorCodes);
            if (isRateLimit) {
              const details = getRateLimitErrorDetails(error);
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
                self.popPendingPartialAssistantTurn();
                rateLimitRetryCount++;
                const delayMs = getRateLimitRetryDelayMs(rateLimitRetryCount, {
                  ...RATE_LIMIT_RETRY_OPTIONS,
                  initialDelayMs: retryInitialDelayMs,
                  maxDelayMs: retryMaxDelayMs,
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
                await delayPromise;
                rearmQuietAcceptanceIfBudgetSpent();
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

            // Replay only curated socket-level failures before any
            // content (non-thought output) has reached callers.
            // Thinking-only output does not block the replay: such an
            // attempt persists nothing (error-path persistence
            // requires a delivered functionCall, which this gate
            // excludes), and the partial turn is popped wholesale
            // below as defense in depth — so nothing the caller saw
            // from that attempt can appear twice. Thinking models can
            // spend minutes in that phase, exactly when gateways
            // close long-lived SSE connections (#7832).
            if (
              isRetryableStreamTransportError(classification) &&
              !streamYieldedContentChunk &&
              // `streamYieldedContentChunk` is per-attempt, so on its own it
              // cannot tell "nothing has been delivered" from "this attempt
              // was cut while thinking, after earlier attempts already put
              // text on screen". Only the first is replayable; replaying the
              // second discards output the caller is watching. The
              // accumulated buffer is what distinguishes them, and it must be
              // consulted here because this branch is checked before the
              // continuation one below.
              transportContinuationText.trim().length === 0 &&
              transportStreamRetryCount <
                TRANSPORT_STREAM_RETRY_CONFIG.maxRetries
            ) {
              self.popPendingPartialAssistantTurn();
              transportStreamRetryCount++;
              const delayMs =
                TRANSPORT_STREAM_RETRY_CONFIG.initialDelayMs *
                transportStreamRetryCount;
              debugLogger.warn('Transport stream retry scheduled', {
                retryPath: 'stream',
                retryDecision: 'retry',
                attempt: transportStreamRetryCount,
                maxRetries: TRANSPORT_STREAM_RETRY_CONFIG.maxRetries,
                retryDelayMs: delayMs,
                yieldedNonContentChunks: streamYieldedChunk,
                errorKind: classification.kind,
                transportCode: classification.transportCode,
              });
              yield { type: StreamEventType.RETRY };
              // A replay is a fresh restart, so anything a previous
              // continuation had staged must go. The gate above now admits
              // only an empty accumulated buffer, which leaves nothing for
              // this to clear — it stays as an assertion of that invariant,
              // so a future gate change cannot leak staged text into a
              // restarted attempt.
              resetTransportContinuation();
              suppressNextRetryEvent = true;
              await delay(delayMs, params.config?.abortSignal).promise;
              rearmQuietAcceptanceIfBudgetSpent();
              continue;
            }
            // Continuation recovery (issue #7832). Once answer text has been
            // delivered, replaying is off the table — it would duplicate what
            // the caller already has — but propagating is not the only
            // alternative left. Gateways that cap SSE connection lifetime
            // (DashScope closes at ~3-5 min) cut long generations partway
            // through the answer, which is precisely when the replay gate is
            // shut, so large outputs failed outright however many retries were
            // configured. Instead of replaying, keep the delivered text and
            // ask the model to continue from it — the same shape the MAX_TOKENS
            // truncation path already uses: show the model its own partial
            // output, inject a resume instruction, and signal the UI with
            // `isContinuation` so it keeps its text buffer rather than
            // discarding it.
            //
            // A cut that delivered a `functionCall` is excluded: injecting a
            // user turn between a `functionCall` and its `functionResponse`
            // produces a sequence providers reject (the same constraint the
            // MAX_TOKENS recovery loop enforces via its `hasFunctionCall`
            // check), and the scheduler's repair path already covers it.
            const canContinueAfterTransportCut =
              isRetryableStreamTransportError(classification) &&
              !streamYieldedFunctionCall &&
              transportContinuationText.trim().length > 0 &&
              transportContinuationCount <
                TRANSPORT_STREAM_RETRY_CONFIG.maxContinuationRetries;
            if (canContinueAfterTransportCut) {
              self.popPendingPartialAssistantTurn();
              transportContinuationCount++;
              // Everything delivered so far — across earlier continuation
              // attempts too, since `transportContinuationText` accumulates
              // and is never reset while continuing. Each attempt's own text
              // was folded in at the catch above with its replayed overlap
              // stripped, so this carries no fragment twice.
              transportContinuationPrefix = transportContinuationText;
              const delayMs =
                TRANSPORT_STREAM_RETRY_CONFIG.initialDelayMs *
                transportContinuationCount;
              debugLogger.warn('Transport stream continuation scheduled', {
                retryPath: 'stream',
                retryDecision: 'continue',
                attempt: transportContinuationCount,
                maxRetries:
                  TRANSPORT_STREAM_RETRY_CONFIG.maxContinuationRetries,
                retryDelayMs: delayMs,
                errorKind: classification.kind,
                transportCode: classification.transportCode,
                deliveredChars: transportContinuationText.length,
              });
              // `isContinuation` keeps the UI's text buffer, so the next
              // attempt's chunks append to what is already on screen instead
              // of replacing it. The delivered text and the resume
              // instruction ride along in `buildAttemptContents()`.
              yield { type: StreamEventType.RETRY, isContinuation: true };
              suppressNextRetryEvent = true;
              await delay(delayMs, params.config?.abortSignal).promise;
              rearmQuietAcceptanceIfBudgetSpent();
              continue;
            }
            if (isRetryableStreamTransportError(classification)) {
              // Reached only when neither branch above fired: content was
              // already delivered so replaying would duplicate it, or the
              // replay budget is exhausted, or continuation is unavailable
              // (function-call cut, no text to anchor on, or its own budget
              // exhausted).
              debugLogger.warn('Transport stream retry not taken', {
                retryPath: 'stream',
                retryDecision: streamYieldedContentChunk
                  ? 'skipped_after_content'
                  : 'exhausted',
                attempts: transportStreamRetryCount,
                maxRetries: TRANSPORT_STREAM_RETRY_CONFIG.maxRetries,
                continuationAttempts: transportContinuationCount,
                maxContinuationRetries:
                  TRANSPORT_STREAM_RETRY_CONFIG.maxContinuationRetries,
                errorKind: classification.kind,
                transportCode: classification.transportCode,
              });
            }

            const contextOverflow = getContextLengthExceededInfo(error);
            if (contextOverflow.isExceeded) {
              if (!exactRoute && !reactiveCompressionAttempted) {
                reactiveCompressionAttempted = true;
                // Only the provider-reported actual count is authoritative.
                // Limit/config/default fallbacks are projections and must
                // keep the estimated marker in compression banners.
                const reactiveOriginalTokenCountIsEstimated =
                  contextOverflow.actualTokens === undefined;
                const reactiveOriginalTokenCount =
                  contextOverflow.actualTokens ??
                  contextOverflow.limitTokens ??
                  cgConfig?.contextWindowSize ??
                  DEFAULT_TOKEN_LIMIT;
                debugLogger.warn(
                  'Context length exceeded; attempting reactive compression.',
                );
                try {
                  const reactiveInfo = await self.tryCompress(
                    prompt_id,
                    true,
                    params.config?.abortSignal,
                    {
                      originalTokenCountOverride: {
                        count: reactiveOriginalTokenCount,
                        isEstimated: reactiveOriginalTokenCountIsEstimated,
                      },
                      precomputedEffectiveTokens: reactiveOriginalTokenCount,
                      requestGenerationConfig: params.config,
                      requestRouteKey,
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
                    self.popPendingPartialAssistantTurn();

                    // Reactive compression replaces the committed user turn.
                    // Keep its one-shot notice in the rebuilt retry request.
                    const noticeText = manualPlanExitNoticeText;
                    if (
                      noticeText &&
                      !self.history.some((content) =>
                        content.parts?.some((part) =>
                          part.text?.includes(noticeText),
                        ),
                      )
                    ) {
                      const lastContent = self.history.at(-1);
                      if (lastContent?.role === 'user') {
                        lastContent.parts = [
                          ...(lastContent.parts ?? []),
                          { text: noticeText },
                        ];
                      } else {
                        self.history.push(
                          createUserContent([{ text: noticeText }]),
                        );
                      }
                    }
                    requestContents = self.getRequestHistoryForRoute(
                      currentUserContent,
                      requestModalities,
                    );
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
                    // Compression rebuilt `requestContents` from scratch, so
                    // any continuation staged against the old contents is
                    // stale — and the RETRY above already told the UI to drop
                    // the delivered text.
                    resetTransportContinuation();
                    suppressNextRetryEvent = true;
                    rearmQuietAcceptanceIfBudgetSpent();
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

            if (
              error instanceof InvalidStreamError &&
              (error.type === 'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS' ||
                (error.type === 'NO_RESPONSE_TEXT' &&
                  lastFinishReason === FinishReason.MAX_TOKENS)) &&
              !maxTokensEscalated &&
              !hasUserMaxTokensOverride &&
              shouldEscalateMaxOutputTokens
            ) {
              lastError = null;
              lastFinishReason = FinishReason.MAX_TOKENS;
              break;
            }

            // Invalid stream responses use INVALID_STREAM_RETRY_CONFIG, which
            // is independent from HTTP retries handled by retryWithBackoff.
            const isInvalidStreamError = error instanceof InvalidStreamError;
            const maxInvalidStreamRetries =
              isInvalidStreamError && error.type === 'PROTOCOL_TAG_LEAK'
                ? INVALID_STREAM_RETRY_CONFIG.protocolTagLeakMaxRetries
                : INVALID_STREAM_RETRY_CONFIG.transientMaxRetries;
            const invalidStreamRetryCount =
              isInvalidStreamError && error.type === 'PROTOCOL_TAG_LEAK'
                ? protocolTagLeakRetryCount
                : transientInvalidStreamRetryCount;
            if (
              isInvalidStreamError &&
              invalidStreamRetryCount < maxInvalidStreamRetries
            ) {
              self.popPendingPartialAssistantTurn();
              const nextInvalidStreamRetryCount = invalidStreamRetryCount + 1;
              if (error.type === 'PROTOCOL_TAG_LEAK') {
                protocolTagLeakRetryCount = nextInvalidStreamRetryCount;
              } else {
                transientInvalidStreamRetryCount = nextInvalidStreamRetryCount;
              }
              // The armed attempt itself can fail with an invalid-stream
              // error and be rescheduled here; rearm so the acceptance is
              // not lost across error types (a tag-leak retry scheduled
              // after the transient budget is spent must still land armed).
              // Transient-keyed, so a tag-leak-only exhaustion never arms
              // prematurely (#9026, #7039 retry-first).
              rearmQuietAcceptanceIfBudgetSpent();
              const delayMs =
                INVALID_STREAM_RETRY_CONFIG.initialDelayMs *
                nextInvalidStreamRetryCount;
              debugLogger.warn(
                `Invalid stream [${(error as InvalidStreamError).type}] ` +
                  `(retry ${nextInvalidStreamRetryCount}/${maxInvalidStreamRetries}). ` +
                  `Waiting ${delayMs / 1000}s before retrying...`,
              );
              logContentRetry(
                self.config,
                new ContentRetryEvent(
                  nextInvalidStreamRetryCount - 1,
                  (error as InvalidStreamError).type,
                  delayMs,
                  model,
                ),
              );
              yield { type: StreamEventType.RETRY };
              await delay(delayMs, params.config?.abortSignal).promise;
              continue;
            }
            break;
          }
        }

        // Max output tokens handling: if the retry loop succeeded but hit
        // MAX_TOKENS, retry once at an escalated output limit only when that
        // would raise the effective initial limit. The escalation target is
        // OUTPUT_TOKEN_CEILING, routed through the same window clamp as the
        // initial request so the retry itself cannot overflow the window.
        // When the initial limit is already at the ceiling (for example the
        // clamp was binding), skip the no-op escalation call but still run
        // continuation recovery on the partial response. These follow-up
        // streams still need the same InvalidStreamError retry guard as the
        // main send loop; otherwise a leaked protocol-tag turn would bypass
        // the primary rollback/retry path entirely.
        const rollbackRecoveryAttempt = () => {
          // Pop the partial `model[fc]` FIRST (if processStreamResponse
          // pushed one before re-throwing), THEN the recovery user turn.
          // Reversed order would strand `OUTPUT_RECOVERY_MESSAGE` as a real
          // user turn. Index-checked pop mirrors `popPartialIfPushed`
          // above — see the design note above
          // `ORPHAN_TOOL_USE_REPAIR_REASON` for the wedge mechanism and
          // the partial-push marker lifecycle.
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
        };
        type InvalidStreamRetryEvent =
          | Extract<StreamEvent, { type: StreamEventType.CHUNK }>
          | Extract<StreamEvent, { type: StreamEventType.RETRY }>;
        const streamWithInvalidStreamRetries = async function* (
          buildAttempt: () => {
            requestContents: Content[];
            params: SendMessageParameters;
            rollback: () => void;
          },
          retryEvent: Extract<StreamEvent, { type: StreamEventType.RETRY }> = {
            type: StreamEventType.RETRY,
          },
        ): AsyncGenerator<InvalidStreamRetryEvent> {
          let transientRetryCount = 0;
          let protocolTagLeakRetryCount = 0;
          let acceptQuietToolResultCompletionOnNextAttempt = false;
          for (;;) {
            const attemptState = buildAttempt();
            try {
              const acceptQuietToolResultCompletion =
                acceptQuietToolResultCompletionOnNextAttempt;
              acceptQuietToolResultCompletionOnNextAttempt = false;
              const stream = await self.makeApiCallAndProcessStream(
                model,
                attemptState.requestContents,
                attemptState.params,
                prompt_id,
                requestOverrides,
                requestRouteKey,
                turnGoalContext,
                undefined,
                acceptQuietToolResultCompletion,
              );
              for await (const chunk of stream) {
                yield { type: StreamEventType.CHUNK, value: chunk };
              }
              return;
            } catch (error) {
              attemptState.rollback();
              if (!(error instanceof InvalidStreamError)) throw error;

              const maxContinuationRetries =
                error.type === 'PROTOCOL_TAG_LEAK'
                  ? INVALID_STREAM_RETRY_CONFIG.protocolTagLeakMaxRetries
                  : INVALID_STREAM_RETRY_CONFIG.transientMaxRetries;
              const continuationRetryCount =
                error.type === 'PROTOCOL_TAG_LEAK'
                  ? protocolTagLeakRetryCount
                  : transientRetryCount;
              if (continuationRetryCount >= maxContinuationRetries) {
                throw error;
              }

              const nextContinuationRetryCount = continuationRetryCount + 1;
              if (error.type === 'PROTOCOL_TAG_LEAK') {
                protocolTagLeakRetryCount = nextContinuationRetryCount;
              } else {
                transientRetryCount = nextContinuationRetryCount;
              }
              // Same arming rule as the main send loop (#9026): keyed to
              // the transient bucket only (quiet completions surface as a
              // transient-type error), so a tag-leak-only exhaustion does
              // not arm prematurely (#7039 retry-first).
              if (
                transientRetryCount >=
                INVALID_STREAM_RETRY_CONFIG.transientMaxRetries
              ) {
                acceptQuietToolResultCompletionOnNextAttempt = true;
              }
              const delayMs =
                INVALID_STREAM_RETRY_CONFIG.initialDelayMs *
                nextContinuationRetryCount;
              debugLogger.warn(
                `Invalid stream [${error.type}] during output continuation ` +
                  `(retry ${nextContinuationRetryCount}/${maxContinuationRetries}). ` +
                  `Waiting ${delayMs / 1000}s before retrying...`,
              );
              logContentRetry(
                self.config,
                new ContentRetryEvent(
                  nextContinuationRetryCount - 1,
                  error.type,
                  delayMs,
                  model,
                ),
              );
              yield retryEvent;
              await delay(delayMs, attemptState.params.config?.abortSignal)
                .promise;
            }
          }
        };
        if (
          lastError === null &&
          lastFinishReason === FinishReason.MAX_TOKENS &&
          !maxTokensEscalated &&
          !hasUserMaxTokensOverride
        ) {
          maxTokensEscalated = true;
          let recoveryFinishReason: string | undefined = lastFinishReason;
          let recoveryParams: SendMessageParameters = params;

          if (shouldEscalateMaxOutputTokens) {
            debugLogger.info(
              `Output truncated at ${effectiveInitialMaxOutputTokens} tokens. ` +
                `Escalating to ${escalatedLimit} tokens.`,
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
            yield {
              type: StreamEventType.RETRY,
              maxOutputTokensEscalated: escalatedLimit,
            };
            // Retry with escalated max_tokens
            const escalatedParams: SendMessageParameters = {
              ...params,
              config: {
                ...params.config,
                maxOutputTokens: escalatedLimit,
              },
            };
            recoveryParams = escalatedParams;
            recoveryFinishReason = undefined;
            for await (const event of streamWithInvalidStreamRetries(() => ({
              requestContents,
              params: escalatedParams,
              rollback: () => self.popPendingPartialAssistantTurn(),
            }))) {
              if (event.type === StreamEventType.RETRY) {
                yield event;
                continue;
              }
              const fr = event.value.candidates?.[0]?.finishReason;
              if (fr) recoveryFinishReason = fr;
              yield event;
            }
          } else {
            debugLogger.info(
              `Output truncated at ${effectiveInitialMaxOutputTokens} tokens; ` +
                `skipping no-op escalation to ${escalatedLimit} tokens and running recovery.`,
            );
          }

          // Recovery: if the escalated response (or, when escalation is a
          // no-op, the initial response) is still truncated, keep the partial
          // response in history and inject a recovery message so the model can
          // continue from where it left off.
          let recoveryCount = 0;
          let successfulRecoveries = 0;
          while (
            recoveryFinishReason === FinishReason.MAX_TOKENS &&
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
              `Output still truncated after max_tokens handling. ` +
                `Recovery attempt ${recoveryCount}/${MAX_OUTPUT_RECOVERY_ATTEMPTS}.`,
            );
            // The partial model response is already in history
            // (pushed by processStreamResponse). Push a recovery user
            // message so the model sees its partial output and continues.
            const recoveryUserContent = createUserContent([
              { text: buildOutputRecoveryMessage(lastEntry) },
            ]);
            // Signal UI/turn to clear pending (incomplete) tool calls.
            // isContinuation tells the UI to keep the text buffer so the
            // model's continuation appends to the previous partial output.
            yield { type: StreamEventType.RETRY, isContinuation: true };
            recoveryFinishReason = undefined;

            // Re-clamp maxOutputTokens for THIS iteration: the prompt has
            // grown by the previous partial response, so the value clamped
            // before the first send would overflow the window if reused
            // (prompt + stale max_tokens > window). Two independent
            // estimates, take the max:
            // - Count-based: lastPromptTokenCount/lastOutputTokenCount are
            //   refreshed from each response's usage metadata — authoritative
            //   when fresh, but a session-level value: a response that OMITS
            //   usage mid-recovery leaves it frozen while history keeps
            //   growing (inconsistent usage reporting from self-hosted
            //   backends is an anticipated failure class here).
            // - Fresh walk of the actual outgoing contents, padded like the
            //   first send: structurally reflects in-turn growth no matter
            //   what usage was reported, while the pad covers the
            //   system/tool overhead a history walk cannot see.
            // The max is conservative in the safe direction only: near the
            // margin the two roughly agree (walk + pad ≈ authoritative
            // count), and whichever went stale or blind is overruled.
            const recoveryImageTokenEstimate = resolveSlimmingConfig(
              self.config.getChatCompression(),
            ).imageTokenEstimate;
            const countBasedRecoveryEstimate =
              self.lastPromptTokenCount > 0
                ? estimatePromptTokens(
                    [],
                    recoveryUserContent,
                    self.lastPromptTokenCount,
                    self.lastOutputTokenCount,
                    recoveryImageTokenEstimate,
                    /* conservative= */ true,
                  )
                : 0;
            self.history.push(recoveryUserContent);
            const recoveryContents = self.getRequestHistoryForRoute(
              currentUserContent,
              requestModalities,
            );
            self.history.pop();
            const walkRecoveryEstimate =
              estimateContentTokens(
                recoveryContents,
                recoveryImageTokenEstimate,
              ) + ESTIMATE_CLAMP_OVERHEAD_PAD;
            const recoveryPromptEstimate = Math.max(
              countBasedRecoveryEstimate,
              walkRecoveryEstimate,
            );
            // recoveryParams is always `params` or `escalatedParams`, both of
            // which have maxOutputTokens set; the `?? outputCeiling` is a
            // defensive fallback that never fires in practice.
            const recoveryCeiling =
              recoveryParams.config?.maxOutputTokens ?? outputCeiling;
            const iterationParams: SendMessageParameters = {
              ...recoveryParams,
              config: {
                ...recoveryParams.config,
                maxOutputTokens: clampOutputTokensToWindow(
                  recoveryCeiling,
                  contextWindowForClamp,
                  recoveryPromptEstimate,
                ),
              },
            };

            try {
              for await (const event of streamWithInvalidStreamRetries(
                () => {
                  self.history.push(recoveryUserContent);
                  return {
                    requestContents: self.getRequestHistoryForRoute(
                      currentUserContent,
                      requestModalities,
                    ),
                    params: iterationParams,
                    rollback: rollbackRecoveryAttempt,
                  };
                },
                { type: StreamEventType.RETRY, isContinuation: true },
              )) {
                if (event.type === StreamEventType.RETRY) {
                  yield event;
                  continue;
                }
                const fr = event.value.candidates?.[0]?.finishReason;
                if (fr) recoveryFinishReason = fr;
                yield event;
              }
              // Iteration fully succeeded: both the user recovery turn and
              // the model continuation turn are now in history and can be
              // coalesced back into the preceding model entry after the loop.
              successfulRecoveries++;
            } catch (recoveryError) {
              rollbackRecoveryAttempt();
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
            const totalAttempts = totalInvalidStreamRetryCount() + 1;
            logContentRetryFailure(
              self.config,
              new ContentRetryFailureEvent(
                totalAttempts,
                lastError.type,
                model,
              ),
            );
          }

          // === Model fallback chain ===
          // When the primary model's retries exhaust on a capacity/availability
          // error, try configured fallback models in sequence. Each fallback
          // model gets its own fresh retry budget.
          //
          // Constraints:
          // - Do NOT trigger fallback when persistent mode is active
          //   (QWEN_CODE_UNATTENDED_RETRY) — persistent mode retries the primary
          //   model indefinitely by design.
          // - Maximum 3 fallback transitions (capped by config normalization).
          // - Fallback is only for capacity/availability errors (429/503/529),
          //   not for auth/billing/client errors.
          const fallbackModels =
            exactRoute || options?.disableModelFallbacks
              ? []
              : self.config.getModelFallbacks();

          if (
            fallbackModels.length > 0 &&
            !isUnattendedMode() &&
            !streamYieldedAnyChunk
          ) {
            let currentErrorClassification = classifyRetryError(lastError, {
              authType: cgConfig?.authType,
              extraRetryErrorCodes,
            });

            if (isFallbackEligible(currentErrorClassification)) {
              let fallbackSucceeded = false;
              let fallbackIndex = 0;
              let currentModel = model;
              let currentResolvedModel = cgConfig?.model ?? model;
              let fallbackStreamYieldedAnyChunk = false;

              for (const fallbackModelId of fallbackModels) {
                // Skip fallback models that match the current/primary model
                if (
                  fallbackModelId === model ||
                  fallbackModelId === currentModel
                ) {
                  debugLogger.warn(
                    `[FALLBACK] Skipping fallback model "${fallbackModelId}": ` +
                      `same as current model.`,
                  );
                  continue;
                }

                // Resolve the fallback model's content generator
                let fallbackGenerator: ContentGenerator;
                let fallbackRetryAuthType: string | undefined;
                let fallbackRetryErrorCodes: readonly number[] | undefined;
                let resolvedFallbackModel: string;
                let fallbackModalities: InputModalities | undefined;
                try {
                  const resolved = await self.config
                    .getBaseLlmClient()
                    .resolveForModel(fallbackModelId, { failClosed: true });
                  fallbackGenerator = resolved.contentGenerator;
                  fallbackRetryAuthType = resolved.retryAuthType;
                  fallbackRetryErrorCodes = resolved.retryErrorCodes;
                  resolvedFallbackModel = resolved.model;
                  fallbackModalities =
                    resolved.contentGeneratorConfig?.modalities;
                } catch (resolveError) {
                  if (isAbortError(resolveError)) throw resolveError;
                  const resolveErrorMessage =
                    resolveError instanceof Error
                      ? resolveError.message
                      : String(resolveError);
                  debugLogger.warn(
                    `[FALLBACK] Failed to resolve fallback model ` +
                      `"${fallbackModelId}": ` +
                      `${resolveErrorMessage}. ` +
                      `Trying next fallback.`,
                  );
                  continue;
                }

                if (resolvedFallbackModel === currentResolvedModel) {
                  debugLogger.warn(
                    `[FALLBACK] Skipping fallback model "${fallbackModelId}": ` +
                      `resolved model "${resolvedFallbackModel}" matches ` +
                      `the current model.`,
                  );
                  continue;
                }
                fallbackIndex++;

                debugLogger.warn(
                  `[FALLBACK] Model "${currentModel}" exhausted retries ` +
                    `(reason: ${currentErrorClassification.reason}, ` +
                    `status: ${currentErrorClassification.statusCode ?? 'unknown'}). ` +
                    `Switching to fallback model "${fallbackModelId}" ` +
                    `(${fallbackIndex}/${fallbackModels.length}).`,
                );

                // Emit fallback event so the UI can notify the user
                yield {
                  type: StreamEventType.MODEL_FALLBACK,
                  info: {
                    fromModel: currentModel,
                    toModel: resolvedFallbackModel,
                    statusCode: currentErrorClassification.statusCode,
                    fallbackIndex,
                  },
                };

                // Remove the partial assistant turn from history before the
                // fallback model starts producing its own response.
                self.popPendingPartialAssistantTurn();

                // Run the fallback model through the existing API-call wiring.
                let currentFallbackYieldedAnyChunk = false;
                try {
                  const fallbackRequestContents =
                    self.getRequestHistoryForRoute(
                      currentUserContent,
                      fallbackModalities ?? {},
                    );
                  // Stamp the fallback-served counts under the REQUEST route
                  // key: a fallback serves on behalf of the same session
                  // request (the session model never changes), and the
                  // session-token-limit gate in Client reads the count keyed
                  // by the request route. Attributing the count to the
                  // fallback's own route would make every later gate read
                  // invalidate it, silently disabling the limit for any
                  // session ever served through fallback (#9454).
                  for await (const event of self.makeFallbackStream(
                    resolvedFallbackModel,
                    fallbackRequestContents,
                    params,
                    prompt_id,
                    fallbackGenerator,
                    fallbackRetryAuthType,
                    fallbackRetryErrorCodes,
                    requestRouteKey,
                    turnGoalContext,
                  )) {
                    const emittedUserVisibleOutput =
                      event.type !== StreamEventType.CHUNK ||
                      hasCandidateOutput(event.value);
                    if (emittedUserVisibleOutput) {
                      currentFallbackYieldedAnyChunk = true;
                      fallbackStreamYieldedAnyChunk = true;
                    }
                    yield event;
                  }

                  // Fallback succeeded
                  lastError = null;
                  fallbackSucceeded = true;
                  debugLogger.info(
                    `[FALLBACK] Successfully completed request with ` +
                      `fallback model "${resolvedFallbackModel}".`,
                  );
                  return;
                } catch (fallbackError) {
                  if (isAbortError(fallbackError)) throw fallbackError;
                  lastError = fallbackError;

                  if (currentFallbackYieldedAnyChunk) {
                    self.popPendingPartialAssistantTurn();
                    debugLogger.warn(
                      `[FALLBACK] Fallback model "${resolvedFallbackModel}" ` +
                        `failed after emitting output. Popped the partial ` +
                        `assistant turn and stopped the fallback chain to ` +
                        `avoid duplicating user-visible output.`,
                    );
                    break;
                  }

                  // Classify the fallback error to decide whether to continue
                  // to the next fallback or give up
                  const fallbackClassification = classifyRetryError(
                    fallbackError,
                    {
                      authType: fallbackRetryAuthType,
                      extraRetryErrorCodes: fallbackRetryErrorCodes,
                    },
                  );

                  const canTryNextFallback = isFallbackEligible(
                    fallbackClassification,
                  );
                  debugLogger.warn(
                    `[FALLBACK] Fallback model "${resolvedFallbackModel}" also ` +
                      `failed (reason: ${fallbackClassification.reason}, ` +
                      `status: ${fallbackClassification.statusCode ?? 'unknown'}). ` +
                      `${canTryNextFallback ? 'Checking remaining fallbacks.' : 'Stopping fallback chain.'}`,
                  );

                  currentModel = resolvedFallbackModel;
                  currentResolvedModel = resolvedFallbackModel;
                  currentErrorClassification = fallbackClassification;

                  // Only continue to next fallback if this error is also
                  // fallback-eligible. Auth/client errors should fail immediately.
                  if (!canTryNextFallback) {
                    debugLogger.warn(
                      `[FALLBACK] Error from "${resolvedFallbackModel}" is not ` +
                        `fallback-eligible (${fallbackClassification.reason}). ` +
                        `Stopping fallback chain.`,
                    );
                    break;
                  }
                }
              }

              if (!fallbackSucceeded) {
                if (!fallbackStreamYieldedAnyChunk) {
                  self.popPendingPartialAssistantTurn();
                }
                debugLogger.warn(
                  '[FALLBACK] Fallback chain exhausted without success. ' +
                    'Throwing last error.',
                );
              }
            } else {
              debugLogger.warn(
                '[FALLBACK] Fallback chain skipped: primary error is not ' +
                  'fallback-eligible ' +
                  `(reason: ${currentErrorClassification.reason}, ` +
                  `diagnosis: ${currentErrorClassification.diagnosis}, ` +
                  `status: ${currentErrorClassification.statusCode ?? 'unknown'}, ` +
                  `error: ${lastError instanceof Error ? lastError.message : String(lastError)}).`,
              );
            }
          } else if (
            fallbackModels.length > 0 &&
            !isUnattendedMode() &&
            streamYieldedAnyChunk
          ) {
            debugLogger.warn(
              '[FALLBACK] Fallback chain skipped because the primary model ' +
                'already emitted user-visible output.',
            );
          }

          if (lastError) {
            throw lastError;
          }
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

  /**
   * Makes an API call with retry logic and returns the processed stream.
   *
   * When called without `overrides`, uses the session's primary content
   * generator and provider config (the common path for the main model).
   * Pass `overrides` to run against a different content generator — used
   * by the fallback chain to call alternative models without duplicating
   * the retry wiring.
   */
  private async makeApiCallAndProcessStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
    overrides?: {
      contentGenerator: ContentGenerator;
      retryAuthType?: string;
      retryErrorCodes?: readonly number[];
    },
    routeKey = this.currentRouteKey(),
    goalContext?: GoalTurnPermit,
    transportContinuationPrefix?: string,
    acceptQuietToolResultCompletion = false,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const generator =
      overrides?.contentGenerator ?? this.config.getContentGenerator();
    const apiCall = () =>
      generator.generateContentStream(
        {
          model,
          contents: requestContents,
          config: { ...this.generationConfig, ...params.config },
        },
        prompt_id,
      );
    const cgConfig = this.config.getContentGeneratorConfig();
    const authType = overrides?.retryAuthType ?? cgConfig?.authType;
    const extraRetryErrorCodes =
      overrides?.retryErrorCodes ?? cgConfig?.retryErrorCodes;
    // Fallback models never enter persistent retry mode — persistent mode
    // is the caller's explicit opt-in for the primary model only.
    const persistentMode = overrides ? false : isUnattendedMode();
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

        // Transient network errors (ECONNRESET, ETIMEDOUT, etc.) carry no HTTP
        // status and would otherwise fall through every predicate above.
        if (
          classifyRetryError(error, { extraRetryErrorCodes }).kind ===
          'transport'
        ) {
          return true;
        }

        return false;
      },
      authType,
      extraRetryErrorCodes,
      persistentMode,
      signal: params.config?.abortSignal,
      ...(persistentMode
        ? {
            heartbeatFn: (info: HeartbeatInfo) => {
              process.stderr.write(
                `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
              );
            },
          }
        : {}),
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

    return this.processStreamResponse(
      model,
      rejectDegradedPlaceholderResponse(streamResponse),
      routeKey,
      goalContext,
      transportContinuationPrefix,
      acceptQuietToolResultCompletion,
    );
  }

  private async *makeFallbackStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
    contentGenerator: ContentGenerator,
    retryAuthType?: string,
    retryErrorCodes?: readonly number[],
    routeKey?: string,
    goalContext?: GoalTurnPermit,
  ): AsyncGenerator<StreamEvent> {
    const stream = await this.makeApiCallAndProcessStream(
      model,
      requestContents,
      params,
      prompt_id,
      { contentGenerator, retryAuthType, retryErrorCodes },
      routeKey,
      goalContext,
    );

    for await (const chunk of stream) {
      yield { type: StreamEventType.CHUNK, value: chunk };
    }
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
   * Copies history containers, Part objects, and nested functionResponse parts
   * without cloning large leaf payloads. Consumers must not mutate leaf
   * payload objects.
   */
  getHistoryShallow(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    return history.map(copyContentContainer);
  }

  getHistoryForForkWindow(): Content[] {
    const history = this.history.slice(getStartupContextLength(this.history));
    return extractCuratedHistory(history).map(copyContentContainer);
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
            (part): part is { text: string } =>
              typeof part.text === 'string' && !part.thought,
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
   * Monotonic count of user-content pushes that survived into history (see the
   * field doc). Snapshot it before a send and compare after to tell whether the
   * send actually pushed the user content — robust to auto-compression, which
   * changes history length without touching this counter.
   */
  getUserContentPushCount(): number {
    return this.userContentPushCount;
  }

  /**
   * Set of `functionResponse.id` strings in user turns. Walk-only,
   * no clone — `useLlmStream.handleCompletedTools` calls this per
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
   * Map of handled tool-call id → (name, args) fingerprint for duplicate
   * provider-id replay detection: model-turn `functionCall`s whose id has a
   * matching user-turn `functionResponse`. Walk-only, no clone, same
   * rationale as {@link getHistoryFunctionResponseIds}; fingerprints of
   * large args are cached per part object (see getFunctionCallFingerprint).
   */
  getHistoryToolCallFingerprints(): Map<string, string> {
    const fingerprintsById = new Map<string, string>();
    const respondedIds = new Set<string>();
    for (const entry of this.history) {
      if (entry.role === 'user') {
        for (const part of entry.parts ?? []) {
          const id = part.functionResponse?.id;
          if (id) respondedIds.add(id);
        }
        continue;
      }
      for (const part of entry.parts ?? []) {
        const functionCall = part.functionCall;
        if (functionCall?.id && !fingerprintsById.has(functionCall.id)) {
          fingerprintsById.set(
            functionCall.id,
            getFunctionCallFingerprint(functionCall),
          );
        }
      }
    }
    const handled = new Map<string, string>();
    for (const id of respondedIds) {
      const fingerprint = fingerprintsById.get(id);
      if (fingerprint !== undefined) handled.set(id, fingerprint);
    }
    return handled;
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

  /**
   * Replaces the `plan` argument of an `exit_plan_mode` `functionCall` in
   * history with a short reference, keeping every other part and argument
   * intact.
   *
   * The full plan text a model submits to `exit_plan_mode` stays in history
   * as its own tool-call arguments; on long conversations models
   * occasionally regurgitate chunks of that blob in later responses
   * (#6237). Once the plan is approved it is persisted to disk by
   * `Config.savePlan`, so the in-context copy can be swapped for a pointer
   * without losing information. Rejected plans are left untouched — the
   * model needs the text to revise them.
   *
   * When `expectedPlan` is provided the rewrite additionally requires the
   * in-history plan to equal it byte-for-byte. Callers pass the on-disk
   * plan-file content here so the pointer can never claim a save that
   * failed (`savePlanBestEffort` swallows filesystem errors) or reference
   * a file that holds a different plan.
   *
   * The entry is replaced immutably at the same index; the partial-push
   * markers compare by index and role, so this cannot desync them.
   *
   * @returns true when a matching functionCall was found and rewritten.
   */
  redactApprovedPlanFromHistory(
    callId: string,
    replacement: string,
    expectedPlan?: string,
  ): boolean {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry?.role !== 'model' || !entry.parts) continue;
      const partIdx = entry.parts.findIndex(
        (part) =>
          part.functionCall?.id === callId &&
          canonicalPlanToolName(part.functionCall.name) ===
            ToolNames.EXIT_PLAN_MODE,
      );
      if (partIdx === -1) continue;
      const part = entry.parts[partIdx]!;
      const functionCall = part.functionCall!;
      const plan = (functionCall.args ?? {})['plan'];
      if (typeof plan !== 'string') {
        return false;
      }
      if (expectedPlan !== undefined && plan !== expectedPlan) {
        return false;
      }
      const newParts = [...entry.parts];
      newParts[partIdx] = {
        ...part,
        functionCall: {
          ...functionCall,
          args: { ...functionCall.args, plan: replacement },
        },
      };
      this.history[i] = { ...entry, parts: newParts };
      return true;
    }
    return false;
  }

  /**
   * Read-side counterpart of {@link redactApprovedPlanFromHistory}: the
   * chat-recording JSONL captured the assistant turn (with the full plan
   * argument) before the tool ran, so a `--resume` / `--continue` reload
   * re-feeds the plan text the in-session redaction already removed
   * (#6237). Every wholesale history load re-applies the redaction to
   * approved `exit_plan_mode` calls.
   *
   * Only calls whose in-history plan matches the current on-disk plan file
   * are rewritten — same never-lie rule as the write side. With several
   * approved plans in one session the file holds only the last one, so
   * earlier calls rehydrate unredacted; safe, just not minimal.
   */
  private redactApprovedPlansFromLoadedHistory(): void {
    const hasPlanCall = this.history.some((entry) =>
      entry?.parts?.some(
        (part) =>
          canonicalPlanToolName(part.functionCall?.name) ===
          ToolNames.EXIT_PLAN_MODE,
      ),
    );
    if (!hasPlanCall) return;
    let planPath: string;
    let savedPlan: string;
    try {
      planPath = this.config.getPlanFilePath();
      savedPlan = fs.readFileSync(planPath, 'utf-8');
    } catch (err) {
      // No plan file (never saved, or save failed): leave history alone —
      // never swap plan text for a pointer to a file that is not there.
      // Logged (unlike a bare swallow) so a --resume that silently skips
      // the redaction is traceable under DEBUG.
      debugLogger.debug(
        `Skipping load-side plan redaction, plan file unavailable: ${err}`,
      );
      return;
    }
    const redacted = redactApprovedPlansInHistory(
      this.history,
      savedPlan,
      planPath,
    );
    if (redacted) {
      this.history = redacted;
    } else {
      // hasPlanCall was true, so a null here means every exit_plan_mode
      // call was skipped (unapproved, id-less, or plan text differing
      // from the saved file) — trace it for "plan still in history"
      // triage, mirroring the write side.
      debugLogger.debug(
        `Load-side plan redaction left history unchanged: no approved ` +
          `exit_plan_mode call matches the plan file at ${planPath}.`,
      );
    }
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
    this.redactApprovedPlansFromLoadedHistory();
    // Wholesale replacement can drop resident skill bodies (compression,
    // /restore, session-manager load_history, ACP restoreSessionHistory
    // all land here). Conservatively clear the tracking so an evicted
    // skill never stays stuck behind the dedup guard; a still-resident
    // body costs at most one duplicate injection on the next invoke.
    if (!this.isForkedChat) {
      clearLoadedSkillTracking(this.config.getToolRegistry(), 'setHistory');
    }
  }

  truncateHistory(keepCount: number): void {
    const prevLen = this.history.length;
    this.history = this.history.slice(0, keepCount);
    // Truncation can drop the entry the partial-push marker points at,
    // or leave it valid but shift the meaning of nearby indices. Reset
    // both fields rather than try to fix them up — they're per-send and
    // ephemeral, so losing them across a truncate is safe (the
    // sendMessageStream that pushed them has already finished or will
    // start fresh on the next call).
    if (this.history.length < prevLen && !this.isForkedChat) {
      // Truncation may have dropped a skill body; conservative clear
      // re-arms reload (see setHistory for the trade-off).
      clearLoadedSkillTracking(
        this.config.getToolRegistry(),
        'truncateHistory',
      );
    }
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
   * Pop orphaned trailing user entries from chat history.
   * In a valid conversation the last entry is always a model response;
   * any trailing user entries are leftovers from a request that failed.
   */
  stripOrphanedUserEntriesFromHistory(): Content[] {
    const strippedEntries: Content[] = [];
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
      strippedEntries.unshift(this.history.pop()!);
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
    if (strippedEntries.length > 0 && !this.isForkedChat) {
      // The stripped entries may have carried a skill body; conservative
      // clear re-arms reload (see setHistory for the trade-off). A forked
      // chat shares the parent's tracker while holding only a tail slice,
      // so only the authoritative session's chat may clear.
      clearLoadedSkillTracking(
        this.config.getToolRegistry(),
        'stripOrphanedUserEntries',
      );
    }
    this.clearPendingPartialState();
    return strippedEntries;
  }

  /**
   * Instance wrapper around the free-function {@link repairOrphanedToolUseTurns}.
   * See the canonical note above `ORPHAN_TOOL_USE_REPAIR_REASON`.
   */
  repairOrphanedToolUseTurns(
    reason?: string,
    options?: RepairOrphanedToolUseOptions,
  ): {
    injected: Array<{ callId: string; name: string }>;
    droppedDuplicates: Array<{ callId: string; name: string }>;
  } {
    return repairOrphanedToolUseTurns(this.history, reason, options);
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

  /**
   * @param transportContinuationPrefix - Text a previous attempt already
   *   delivered before a socket cut, which this attempt was asked to resume
   *   from (issue #7832). On success it is folded into the response parts
   *   before either durable write, so the JSONL transcript and in-memory
   *   history carry the same merged turn (issue #8094). Undefined on every
   *   non-continuation send.
   */
  private async *processStreamResponse(
    model: string,
    streamResponse: AsyncGenerator<GenerateContentResponse>,
    routeKey: string,
    goalContext?: GoalTurnPermit,
    transportContinuationPrefix?: string,
    acceptQuietToolResultCompletion = false,
  ): AsyncGenerator<GenerateContentResponse> {
    // Collect ALL parts from the model response (including thoughts for recording)
    const allModelParts: Part[] = [];
    const usedToolCallIds = collectToolCallIdsFromHistory(this.history);
    const rawToolCallIdsInCurrentTurn = new Set<string>();
    const reservedToolCallIds = new Map<string, string>();
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;
    let coercedUsage:
      | {
          promptTokenCount: number;
          totalTokenCount: number;
          candidatesTokenCount: number;
          cachedContentTokenCount: number;
          thoughtsTokenCount: number;
        }
      | undefined;

    let hasToolCall = false;
    let hasFinishReason = false;
    const protocolTagDetector = new LeadingProtocolTagLeakDetector();
    let pendingProtocolParts: Part[] = [];
    const takePendingProtocolParts = (): Part[] => {
      const parts = pendingProtocolParts;
      pendingProtocolParts = [];
      const released: Part[] = [];
      for (const part of parts) {
        const previous = released.at(-1);
        if (
          previous &&
          isValidNonThoughtTextPart(previous) &&
          isValidNonThoughtTextPart(part)
        ) {
          previous.text! += part.text!;
        } else {
          released.push(isValidNonThoughtTextPart(part) ? { ...part } : part);
        }
      }
      return released;
    };
    let protocolTextWasSuppressed = false;
    const currentUserTurn = this.history[this.history.length - 1];
    const isToolResultContinuation =
      currentUserTurn?.role === 'user' &&
      currentUserTurn.parts?.some((part) => part.functionResponse) === true;
    let deferredFinishReason: FinishReason | undefined;
    // Captured if the upstream stream throws mid-iteration (typical on weak
    // networks: SSE drops between `content_block_stop` of a tool_use and the
    // terminal `message_stop`). We still build / record / push a partial
    // assistant turn below before re-throwing — see the dedicated branch in
    // the post-loop block for why this is needed to keep tool_use/tool_result
    // pairing intact across the failure.
    let streamError: unknown = null;

    try {
      for await (const chunk of streamResponse) {
        const preparations = getToolCallPreparations(chunk);
        if (preparations.length > 0) {
          setToolCallPreparations(
            chunk,
            preparations.map((preparation) => ({
              ...preparation,
              callId: reserveModelToolCallId(
                preparation.callId,
                usedToolCallIds,
                reservedToolCallIds,
              ),
            })),
          );
        }

        // Use ||= to avoid later usage-only chunks (no candidates) overwriting
        // a finishReason that was already seen in an earlier chunk.
        hasFinishReason ||=
          chunk?.candidates?.some((candidate) => candidate.finishReason) ??
          false;

        if (isValidResponse(chunk)) {
          const candidate = chunk.candidates?.[0];
          let content = candidate?.content;
          if (candidate?.finishReason && !content?.parts) {
            protocolTagDetector.finish();
            if (protocolTagDetector.leaked) {
              pendingProtocolParts = [];
            } else {
              const parts = takePendingProtocolParts();
              if (parts.length > 0) {
                content = {
                  ...content,
                  role: content?.role ?? 'model',
                  parts,
                };
                candidate.content = content;
              }
            }
          }
          if (content?.parts) {
            const outputParts: Part[] = [];
            for (const part of content.parts) {
              if (
                isToolResultContinuation &&
                !part.thought &&
                part.text?.trim() === GEMINI_EMPTY_CONTENT_PLACEHOLDER
              ) {
                continue;
              }
              if (typeof part.text !== 'string' || part.thought) {
                if (
                  pendingProtocolParts.length > 0 ||
                  protocolTagDetector.leaked
                ) {
                  pendingProtocolParts.push(part);
                } else {
                  outputParts.push(part);
                }
                continue;
              }
              const text = protocolTagDetector.accept(part.text);
              if (text) {
                if (pendingProtocolParts.length > 0) {
                  outputParts.push(...takePendingProtocolParts(), part);
                } else {
                  outputParts.push({ ...part, text });
                }
                continue;
              }
              pendingProtocolParts.push(...outputParts.splice(0), part);
              protocolTextWasSuppressed ||= part.text.length > 0;
            }
            content.parts = outputParts;
            if (candidate?.finishReason) {
              protocolTagDetector.finish();
              if (protocolTagDetector.leaked) {
                pendingProtocolParts = [];
              } else {
                content.parts.push(...takePendingProtocolParts());
              }
            }
            content.parts = normalizeModelToolCallIds(
              content.parts,
              usedToolCallIds,
              rawToolCallIdsInCurrentTurn,
              reservedToolCallIds,
            );
            syncFunctionCallsField(chunk, content.parts);

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
          const hasUsablePromptTokenCount =
            typeof usageMetadata.promptTokenCount === 'number' &&
            Number.isFinite(usageMetadata.promptTokenCount) &&
            usageMetadata.promptTokenCount >= 0;
          const hasUsableTotalTokenCount =
            typeof usageMetadata.totalTokenCount === 'number' &&
            Number.isFinite(usageMetadata.totalTokenCount) &&
            usageMetadata.totalTokenCount >= 0;
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
          const thoughtsTokenCount = coerceUsageCount(
            usageMetadata.thoughtsTokenCount,
            'thoughtsTokenCount',
          );
          // Stash coerced values so recordAssistantTurn can reuse them
          // without re-calling coerceUsageCount inline.
          coercedUsage = {
            promptTokenCount,
            totalTokenCount,
            candidatesTokenCount,
            cachedContentTokenCount,
            thoughtsTokenCount,
          };
          const lastPromptTokenCount = hasUsablePromptTokenCount
            ? promptTokenCount
            : totalTokenCount;
          if (lastPromptTokenCount) {
            // Always update the per-chat counter so this chat (including
            // subagents) can make its own compaction decisions.
            // Retain whatever route's counts currently occupy the slots
            // before overwriting them: a foreign-keyed slot holds another
            // route's state that its next keyed read still needs — mid-send
            // compression can leave the slots keyed to the active route
            // even though this report comes from the request route (#9506).
            if (
              this.tokenCountsRouteKey !== undefined &&
              this.tokenCountsRouteKey !== routeKey
            ) {
              this.retainCurrentTokenCounts();
            }
            this.lastPromptTokenCount = lastPromptTokenCount;
            this.lastPromptTokenCountIsEstimated = false;
            this.lastOutputTokenCount = hasUsablePromptTokenCount
              ? getUsageOutputTokenCountForPromptEstimate({
                  promptTokenCount,
                  ...(hasUsableTotalTokenCount ? { totalTokenCount } : {}),
                  candidatesTokenCount,
                  thoughtsTokenCount,
                })
              : 0;
            // Attribute these counts to the route that reported them so a
            // later model switch invalidates them (#9454).
            this.tokenCountsRouteKey = routeKey;
            // A fresh API report supersedes anything retained for this
            // route while another route owned the slots (#9506).
            this.tokenCountsByRouteKey.delete(routeKey);
            // Mirror to the global telemetry only when wired — subagents
            // pass `telemetryService=undefined` to keep their context usage
            // out of the main session's UI counters.
            this.telemetryService?.setLastPromptTokenCount(
              lastPromptTokenCount,
            );
            if (cachedContentTokenCount && this.telemetryService) {
              this.telemetryService.setLastCachedContentTokenCount(
                cachedContentTokenCount,
              );
            }
          }
        }

        if (isToolResultContinuation) {
          // Do not let consumers commit Finished before post-stream validation
          // can reject a semantically empty continuation.
          for (const candidate of chunk.candidates ?? []) {
            if (candidate.finishReason) {
              deferredFinishReason ??= candidate.finishReason;
              delete candidate.finishReason;
            }
          }
        }

        if (
          !chunk.candidates?.length ||
          preparations.length > 0 ||
          !protocolTextWasSuppressed ||
          !protocolTagDetector.blockingOutput
        ) {
          yield chunk;
        }
      }
    } catch (e) {
      streamError = e;
    }

    if (
      streamError === null &&
      pendingProtocolParts.length > 0 &&
      (hasToolCall ||
        pendingProtocolParts.some((part) => part.functionCall !== undefined))
    ) {
      protocolTagDetector.finish();
      if (protocolTagDetector.leaked) {
        pendingProtocolParts = [];
      } else {
        const parts = normalizeModelToolCallIds(
          takePendingProtocolParts(),
          usedToolCallIds,
          rawToolCallIdsInCurrentTurn,
          reservedToolCallIds,
        );
        const chunk = {
          candidates: [{ content: { role: 'model', parts } }],
        } as GenerateContentResponse;
        syncFunctionCallsField(chunk, parts);
        hasToolCall ||= parts.some((part) => part.functionCall);
        allModelParts.push(...parts);
        yield chunk;
      }
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

    let contentParts = allModelParts.filter((part) => !part.thought);
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

    let contentText = consolidatedHistoryParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('')
      .trim();

    // Deferred until after the throw sites below so a protocol-tag leak
    // or stream-validation failure cannot dispatch a recovered call that
    // the retry path would then execute a second time.
    let recoveredChunk: GenerateContentResponse | null = null;

    // XML tool call fallback: some models (e.g. qwen3.8-max-preview in very
    // long contexts) occasionally emit tool calls as raw XML in the content
    // field instead of using the structured tool_calls array. Detect and
    // recover these so the agent loop is not broken. See #8003.
    if (
      streamError === null &&
      !hasToolCall &&
      hasFinishReason &&
      contentText &&
      containsXmlToolCalls(contentText)
    ) {
      const recovery = tryRecoverXmlToolCalls(contentText);
      if (recovery.recovered) {
        hasToolCall = true;
        // recovery.remainingText is derived from the join of ALL text
        // parts, so every text part is consumed. Remove them, reinsert
        // remainingText at the first text position so non-text parts
        // (inlineData/fileData) keep their original relative order, and
        // append functionCallParts at the end.
        const textIndices: number[] = [];
        for (let i = 0; i < consolidatedHistoryParts.length; i++) {
          if (consolidatedHistoryParts[i]!.text !== undefined)
            textIndices.push(i);
        }
        for (let j = textIndices.length - 1; j >= 0; j--) {
          consolidatedHistoryParts.splice(textIndices[j]!, 1);
        }
        const insertAt = Math.min(
          textIndices[0] ?? 0,
          consolidatedHistoryParts.length,
        );
        if (recovery.remainingText) {
          consolidatedHistoryParts.splice(insertAt, 0, {
            text: recovery.remainingText,
          });
        }
        consolidatedHistoryParts.push(...recovery.functionCallParts);
        // Recompute contentText and contentParts so the JSONL recording
        // below stays aligned with in-memory history (--resume fidelity).
        contentText = consolidatedHistoryParts
          .filter((part) => part.text)
          .map((part) => part.text)
          .join('')
          .trim();
        contentParts = consolidatedHistoryParts;
        // Build a synthetic chunk so the agent loop (turn.ts) actually
        // executes the recovered tool calls; yielded after the throw sites.
        const syntheticChunk = {
          candidates: [
            {
              content: { role: 'model', parts: recovery.functionCallParts },
            },
          ],
        } as GenerateContentResponse;
        syncFunctionCallsField(syntheticChunk, recovery.functionCallParts);
        recoveredChunk = syntheticChunk;
        debugLogger.warn(
          `XML tool call fallback: recovered ${recovery.functionCallParts.length} tool call(s) [${recovery.functionCallParts.map((p) => p.functionCall?.name).join(', ')}] from plain text content (contentLength=${contentText.length})`,
        );
      } else {
        debugLogger.warn(
          `XML tool call fallback: detected XML tool calls but recovery was rejected (prose ratio too high or no parameterized blocks), contentLength=${contentText.length}`,
        );
      }
    }

    if (streamError === null && protocolTagDetector.leaked && !hasToolCall) {
      throw new InvalidStreamError(
        'Model response started with leaked protocol tags.',
        'PROTOCOL_TAG_LEAK',
      );
    }

    // Stream validation logic: A stream is considered successful if:
    // 1. There's a tool call (tool calls can end without explicit finish reasons), OR
    // 2. There's a finish reason AND we have non-empty response text or thought text
    //
    // Thought-only responses remain valid for ordinary user turns. After a
    // tool result, they do not advance the agent without text or another
    // tool call, so they retry (#7039) — and once that retry budget is
    // exhausted the quiet completion is accepted rather than failing the
    // run (#9026): some model families legitimately end turns silently
    // after a tool result.
    const hasAnyContent = contentText || thoughtText;
    const lacksVisibleToolResultProgress =
      isToolResultContinuation &&
      (!contentText || contentText === GEMINI_EMPTY_CONTENT_PLACEHOLDER);
    let acceptedQuietToolResultCompletion = false;
    if (
      streamError === null &&
      !hasToolCall &&
      (!hasFinishReason || !hasAnyContent || lacksVisibleToolResultProgress)
    ) {
      if (!hasFinishReason) {
        throw new InvalidStreamError(
          'Model stream ended without a finish reason.',
          'NO_FINISH_REASON',
        );
      }
      if (lacksVisibleToolResultProgress) {
        const truncatedAtMaxTokens =
          deferredFinishReason === FinishReason.MAX_TOKENS;
        // Only STOP is a complete, non-truncated, non-blocked quiet turn end.
        // Unknown converter fall-through values such as
        // FINISH_REASON_UNSPECIFIED must fail closed instead of being accepted
        // as an empty model turn.
        const unsupportedQuietFinishReason =
          deferredFinishReason !== FinishReason.STOP;
        if (
          truncatedAtMaxTokens ||
          unsupportedQuietFinishReason ||
          !acceptQuietToolResultCompletion
        ) {
          throw new InvalidStreamError(
            'Model stream ended after a tool result without visible progress.',
            truncatedAtMaxTokens
              ? 'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS'
              : 'NO_TOOL_RESULT_PROGRESS',
          );
        }
        // Retry budget exhausted and the model still ends the turn quietly
        // with a valid finish reason (#9026). Accept it as completion.
        // When the attempt produced nothing at all, the canonical
        // placeholder is appended to `acceptedTurnParts` below — the
        // single source for both the JSONL record and the history push,
        // keeping user/model alternation well-formed for the next request
        // while transcript and history agree.
        acceptedQuietToolResultCompletion = true;
        debugLogger.warn(
          'Accepting quiet post-tool-result completion after retry budget ' +
            'exhaustion (#9026)',
        );
      } else {
        throw new InvalidStreamError(
          'Model stream ended with empty response text.',
          'NO_RESPONSE_TEXT',
        );
      }
    }

    if (recoveredChunk) {
      yield recoveredChunk;
    }

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
    // Transport-continuation merge (issue #8094). `allModelParts` is
    // per-attempt, so a continuation's parts carry the resumed remainder only.
    // Fold the already-delivered prefix back in HERE — into the parts
    // themselves, before either durable write — so the JSONL record below and
    // the `this.history.push` further down are derived from the same data and
    // cannot disagree. Otherwise `--resume` rehydrates a turn that starts
    // mid-sentence while the live session shows a coherent answer.
    //
    // Merging in one place is load-bearing, not tidiness:
    //   - Computing the record's text and history's text from separate
    //     expressions lets them drift. They already would: `contentText` is
    //     trimmed (see its definition above) while the pushed parts are raw,
    //     so deduping the record against the trimmed text fuses words when the
    //     remainder opens with whitespace ("The result is" + " 42." →
    //     "The result is42.").
    //   - Writing them at different times opens a window. The record is
    //     appended below, the history push happens after it, and a
    //     `deferredFinishReason` chunk is yielded after that — a suspension
    //     point. A consumer abandoning iteration there (an abort inside
    //     `Turn.run`) would strand a merged record against a remainder-only
    //     history, and the JSONL is append-only so nothing reconciles it.
    //
    // Placed after the stream-validation throws above so an empty continuation
    // still fails validation on its own merits rather than being masked by the
    // prefix.
    //
    // Success only. On `streamError !== null` the parts must keep matching the
    // remainder-only partial that survives in history (the
    // `pendingPartialAssistantRecord` path below) — the prefix belongs to an
    // attempt that did not survive, and a fresh-restart retry discards it via
    // `resetTransportContinuation`.
    if (streamError === null && transportContinuationPrefix) {
      const textIndex = consolidatedHistoryParts.findIndex(isPlainTextPart);
      if (textIndex < 0) {
        // Continuation returned no text of its own (e.g. only a functionCall).
        // `thoughtContentPart` is prepended separately at the push below, so
        // index 0 here is already "after any leading thought part".
        consolidatedHistoryParts.unshift({ text: transportContinuationPrefix });
      } else {
        const remainderPart = consolidatedHistoryParts[textIndex] as Part & {
          text: string;
        };
        consolidatedHistoryParts[textIndex] = {
          ...remainderPart,
          text: mergeDeliveredPrefix(
            transportContinuationPrefix,
            remainderPart.text,
          ),
        };
      }
      contentText = consolidatedHistoryParts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('')
        .trim();
    }
    // The exact parts the accepted turn will carry into `this.history.push`
    // below — computed once, before the JSONL record, so an accepted quiet
    // completion records exactly what history keeps (including non-text
    // parts like inlineData, which have no slot in the text/toolCall
    // assembly and would otherwise desync transcript from history on
    // `--resume`).
    const acceptedTurnParts: Part[] = [
      ...(thoughtContentPart ? [thoughtContentPart] : []),
      ...consolidatedHistoryParts,
    ];
    if (acceptedQuietToolResultCompletion && acceptedTurnParts.length === 0) {
      acceptedTurnParts.push({ text: GEMINI_EMPTY_CONTENT_PLACEHOLDER });
    }
    if (
      willPersistToHistory &&
      (acceptedQuietToolResultCompletion ||
        thoughtContentPart ||
        contentText ||
        hasToolCall ||
        usageMetadata)
    ) {
      const contextWindowSize =
        this.config.getContentGeneratorConfig()?.contextWindowSize;
      const recordArgs = {
        model,
        message: acceptedQuietToolResultCompletion
          ? acceptedTurnParts
          : [
              ...(thoughtContentPart ? [thoughtContentPart] : []),
              ...(contentText ? [{ text: contentText }] : []),
              ...(hasToolCall
                ? contentParts
                    .map(redactStructuredOutputArgsForRecording)
                    .filter(
                      (
                        p,
                      ): p is {
                        functionCall: NonNullable<Part['functionCall']>;
                      } => p !== null,
                    )
                : []),
            ],
        tokens: coercedUsage
          ? { ...usageMetadata, ...coercedUsage }
          : usageMetadata,
        contextWindowSize,
        ...(goalContext ? { goalContext: { ...goalContext } } : {}),
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
        // dedup in `useLlmStream.handleCompletedTools` already logs
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

    this.history.push({
      role: 'model',
      parts: acceptedTurnParts,
    });
    if (deferredFinishReason) {
      yield {
        candidates: [{ finishReason: deferredFinishReason }],
        usageMetadata,
      } as GenerateContentResponse;
    }
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

/** @deprecated Use `LlmChat`; retained until a future major release. */
export { LlmChat as GeminiChat };
