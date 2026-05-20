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
import { getHeapStatistics } from 'node:v8';
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

// Leave roughly 30% V8 heap headroom for compression's transient allocations.
const HEAP_PRESSURE_COMPRESSION_RATIO = 0.7;
const HEAP_PRESSURE_COMPRESSION_COOLDOWN_MS = 30_000;

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

/**
 * Walk `history` left-to-right and close every dangling tool_use ↔ tool_result
 * pair so the wire format the next API call sees is always
 * `model[fc] → user[fr]` with the `fr` blocks at the head of the immediately
 * following user turn. Two fix-ups can run for each `model[functionCall]`:
 *
 *  - SYNTHESIZE: for any `functionCall.id` not echoed back by ANY of the
 *    consecutive user turns that follow it (up to the next model turn or
 *    end-of-history), insert a synthetic `functionResponse` carrying an
 *    `error` field — the close analogue of upstream Claude Code's
 *    `yieldMissingToolResultBlocks` (`query.ts:123-149`).
 *  - HOIST: for any `functionCall.id` whose real `functionResponse` lives in
 *    a non-adjacent following user turn (typical shape:
 *    `model[fc], user[text], user[fr_real]` — produced when a user aborts a
 *    long-running tool, types a follow-up, and the React scheduler's late
 *    `submitQuery` appends the real `fr` as a SEPARATE user entry), MOVE the
 *    real `fr` part out of its original turn into the adjacent one. Without
 *    hoisting, the synthesis pass correctly skips the call (a real `fr`
 *    exists somewhere later) but the wire layout still serializes
 *    `model[tool_use] → user[text] → user[tool_result]`, which
 *    Anthropic-compatible backends reject with "tool_use_id ... must have a
 *    corresponding tool_use block in the previous message".
 *
 * Mutates `history` in place and returns the set of injected `(callId, name)`
 * tuples so callers (the React tool scheduler) can dedupe a real `tool_result`
 * if the in-flight tool completes after the repair. Hoisted ids are NOT in
 * the returned list — the real `fr` is already present in history, so the
 * scheduler's existing history-based dedup handles them without extra entries.
 *
 * The injection target for synthesized parts follows this rule:
 *  - If the next entry is a `user` turn → insert synthetic parts at the head
 *    (before any non-`functionResponse` parts; after any pre-existing real
 *    `functionResponse` parts so caller-supplied ordering is preserved).
 *  - If the next entry is a `model` turn or end-of-history → insert a new
 *    `user` turn between them carrying just the synthetic parts.
 *
 * This is the qwen-code analogue of upstream Claude Code's
 * `yieldMissingToolResultBlocks` (`query.ts:123-149`). Upstream can call it
 * unconditionally at every error path because their `StreamingToolExecutor`
 * is in-band — they atomically `.discard()` in-flight tools at the synthesis
 * point. Our React scheduler runs out-of-band, so the caller pairs this with
 * dedup in `handleCompletedTools` (which skips submission for any callId
 * already present in history). See PR review thread on #4176 for the full
 * race-class analysis.
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

/**
 * Output of the decision phase for one scanned model turn. Encodes
 * exactly which mutations the next phase should apply:
 *  - `synthesizeIds`: ids that have no matching fr anywhere — synthesize an
 *    `error` `functionResponse` for each.
 *  - `hoistedParts`: parts to MOVE into the adjacent user turn (the
 *    canonical survivor for each id whose fr lives in a non-adjacent
 *    later turn).
 *  - `removalTargets`: parts to SPLICE out of `history` — covers both
 *    hoist survivors (so they only remain in the new location) and
 *    duplicate copies of any id.
 *  - `droppedDuplicates`: callIds whose duplicates we removed; returned
 *    by the function so callers can log the cleanup.
 */
interface RepairPlan {
  modelIdx: number;
  scanEnd: number;
  synthesizeIds: Array<[string, string]>;
  hoistedParts: Part[];
  removalTargets: Array<{ turnIdx: number; partIdx: number }>;
  droppedDuplicates: Array<{ callId: string; name: string }>;
}

/**
 * SCAN PHASE — collect `expected` from the `model[functionCall]` turn
 * at `modelIdx` and `matched` from every consecutive user turn that
 * follows. Pure read; no mutation.
 *
 * Storing ALL locations (not just the first) is load-bearing for the
 * duplicate case: if the same callId is echoed back more than once
 * across the consecutive user turns (e.g.
 * `model[fc id=cid], user[text], user[fr cid], user[fr cid]` — possible
 * when the React scheduler retries the late `submitQuery` and a
 * duplicate fr lands), hoisting only the first would leave the
 * duplicate behind. The wire payload then serializes
 *   `model[tool_use] -> user[tool_result] -> user[tool_result]`
 * and the backend rejects the trailing block as an orphan
 * ("tool_use_id ... must have a corresponding tool_use block in the
 * previous message").
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
 * DECISION PHASE — classify each expected callId into synthesize /
 * hoist / skip-already-adjacent, and collect every duplicate copy for
 * removal. Pure compute; no mutation. The plan returned here drives
 * the mutation phase exactly.
 *
 * Classification rules per callId:
 *   - No matching fr anywhere     → SYNTHESIZE an error fr.
 *   - First match adjacent (modelIdx+1) → SKIP relocation. (Duplicates,
 *     if any, are still removed below.)
 *   - First match non-adjacent    → HOIST: move the canonical part into
 *     the adjacent user turn; remove the original location.
 * In all matched cases, drop EVERY duplicate beyond the first so the
 * wire payload contains exactly one fr per call.
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
 * MUTATION PHASE — apply the plan to `history` in place. Returns the
 * number of new user turns inserted before `modelIdx + 1` (currently
 * always 0 or 1), which the caller uses to advance its forward-walk
 * cursor past anything the loop should not revisit.
 *
 * Order matters here:
 *  1. Splice removal targets in (turnIdx desc, partIdx desc) so earlier
 *     removals don't shift indices for later ones.
 *  2. Drop user turns within `[modelIdx + 2, scanEnd)` that are now
 *     empty after the splice. Walk back-to-front for the same reason.
 *     The immediately-adjacent turn (`modelIdx + 1`) is preserved even
 *     if empty — we rewrite its parts in step 3.
 *  3. Inject `[...synthetic, ...hoisted]` at the head of the adjacent
 *     user turn (before any non-fr parts) OR insert a new user turn
 *     between `modelIdx` and whatever follows.
 *
 * Anthropic-compatible backends require the tool_result blocks at the
 * head of the immediately following user message; appending instead
 * (`[text, fr]`) re-triggers the 400 the synthesis pass exists to
 * escape. Mirrors upstream Claude Code's `hoistToolResults`.
 *
 * CONSEQUENCE OF REMOVAL of the head-insert: dropping this hoist (e.g.
 * naively `next.parts = [...existing, ...partsToInject]`) re-introduces
 * the "tool_use_id ... must have a corresponding tool_use block in the
 * previous message" 400 the synthesis pass exists to prevent. Do not
 * "simplify" this branch.
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
   * Per-chat sticky flag. After an unforced compression attempt fails (empty
   * summary or inflated token count), automatic compaction is suppressed
   * for the remainder of this chat to avoid burning compression API calls
   * in a loop. Manual `/compress` still works (it passes `force=true`).
   */
  private hasFailedCompressionAttempt = false;

  /**
   * Index into `this.history` of the model turn that `processStreamResponse`
   * persisted on the CURRENT in-flight attempt's mid-stream error. `null` if
   * no partial has been pushed (the common case).
   *
   * The retry loop in `sendMessageStream` reads this on every catch to roll
   * the partial back BEFORE retrying — without that pop, a retryable
   * mid-stream error (rate limit, transient stream anomaly) leaves the
   * failed attempt's `model[functionCall]` in history, and the successful
   * retry's response lands as a SECOND consecutive model turn (invalid
   * user/model alternation, plus the failed-attempt tool_use is orphan on
   * the wire — the very wedge this whole subsystem is meant to escape).
   *
   * Reset to `null` on every `sendMessageStream` entry so a marker left
   * over from a prior unretryable break doesn't bleed into the next send.
   */
  private pendingPartialAssistantTurnIndex: number | null = null;

  /**
   * Deferred-flush record for the partial assistant turn pushed on a
   * mid-stream error. Stashed instead of immediately appended to the
   * chat-recording JSONL so a subsequent retry-success can roll back the
   * persisted record alongside the in-memory pop. Without deferral, the
   * JSONL transcript keeps the failed attempt even though live history
   * dropped it — `--resume` rehydrates the failed `model[functionCall]`
   * turn and the resumed model context picks up a tool_use the in-session
   * run intentionally discarded.
   *
   * Lifecycle is paired with `pendingPartialAssistantTurnIndex`:
   *  - Set together on stream-error + hasToolCall + hasContent.
   *  - Cleared together by `popPartialIfPushed` when the retry loop
   *    rolls the partial back.
   *  - Flushed together to JSONL after the retry loop exits if the
   *    partial survived (unretryable break path → about to throw to
   *    the caller). At that point the partial is durable in memory and
   *    the recording must match.
   *  - Reset on `sendMessageStream` entry / setHistory / clearHistory /
   *    truncateHistory / addHistory / stripThoughtsFromHistory so a leak
   *    from any exotic path can't bleed into a future send.
   */
  private pendingPartialAssistantRecord:
    | Parameters<ChatRecordingService['recordAssistantTurn']>[0]
    | null = null;

  /**
   * Reset both partial-push markers in lockstep. Extracted so the seven
   * call sites that need to drop both fields (sendMessageStream entry,
   * popPartialIfPushed, clearHistory, addHistory, setHistory,
   * truncateHistory, stripThoughtsFromHistory) can't drift apart — a
   * future history-mutating method that only clears one would leak the
   * other into a later flush. The fields ARE always paired by lifecycle
   * (set together on stream-error stash, popped together on retry, flushed
   * together at the rethrow site), so any single-field reset is a bug.
   */
  private clearPendingPartialState(): void {
    this.pendingPartialAssistantTurnIndex = null;
    this.pendingPartialAssistantRecord = null;
  }

  /**
   * Heap-pressure compaction is process-wide pressure applied per chat. If one
   * heap-triggered attempt cannot reduce history, briefly back off this chat
   * so every subsequent send does not immediately pay for another compression
   * side query while memory is already tight.
   */
  private heapPressureCompressionCooldownUntil = 0;

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
    const heapPressureRatio = force ? null : this.getHeapPressureRatio();
    const heapPressureCooldownActive =
      !force && Date.now() < this.heapPressureCompressionCooldownUntil;
    const bypassTokenThreshold =
      heapPressureRatio !== null &&
      heapPressureRatio >= HEAP_PRESSURE_COMPRESSION_RATIO &&
      !heapPressureCooldownActive;
    if (bypassTokenThreshold) {
      // Temporary safety net: token-based compaction can be too late for
      // large-context sessions because JS heap pressure may hit first.
      // Do not use force=true here because that carries manual /compress
      // semantics in ChatCompressionService.
      debugLogger.warn(
        `Heap pressure at ${(heapPressureRatio * 100).toFixed(1)}%; ` +
          'attempting auto-compaction before token threshold.',
      );
    } else if (
      heapPressureRatio !== null &&
      heapPressureRatio >= HEAP_PRESSURE_COMPRESSION_RATIO &&
      heapPressureCooldownActive
    ) {
      debugLogger.debug(
        `Heap pressure at ${(heapPressureRatio * 100).toFixed(1)}%; ` +
          'skipping heap-pressure auto-compaction during cooldown.',
      );
    }

    const service = new ChatCompressionService();
    const { newHistory, info } = await service.compress(this, {
      promptId,
      force,
      model,
      config: this.config,
      hasFailedCompressionAttempt: this.hasFailedCompressionAttempt,
      originalTokenCount:
        options?.originalTokenCountOverride ?? this.lastPromptTokenCount,
      bypassTokenThreshold,
      trigger: options?.trigger,
      signal,
    });

    if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
      this.chatRecordingService?.recordChatCompression({
        info,
        compressedHistory: newHistory,
      });
      // Auto-compaction replaces history in place — no env-context refresh
      // here. Manual /compress goes through GeminiClient.tryCompressChat,
      // which calls startChat() to re-prepend a fresh env snapshot. See
      // GeminiClient.sendMessageStream for the rationale behind the split.
      this.setHistory(newHistory);
      // Compaction summarises away prior full-Read tool results, but the
      // FileReadCache still treats those reads as "in this conversation".
      // A follow-up Read could then return the file_unchanged placeholder
      // pointing at content the model can no longer retrieve from history.
      debugLogger.debug('[FILE_READ_CACHE] clear after auto tryCompress');
      this.config.getFileReadCache().clear();
      this.lastPromptTokenCount = info.newTokenCount;
      // Mirror to the global singleton only when wired (main session).
      // Subagents pass `telemetryService=undefined` to keep their context
      // usage out of the main agent's UI counters.
      this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
      // Re-enable auto-compaction so a forced /compress recovers a chat
      // that an earlier auto-attempt latched off.
      this.hasFailedCompressionAttempt = false;
      this.heapPressureCompressionCooldownUntil = 0;
    } else if (bypassTokenThreshold) {
      // If heap-pressure compaction cannot reduce history (NOOP or failure),
      // avoid repeatedly cloning history and/or paying side-query latency while
      // the process-wide pressure remains high.
      this.heapPressureCompressionCooldownUntil =
        Date.now() + HEAP_PRESSURE_COMPRESSION_COOLDOWN_MS;
    } else if (isCompressionFailureStatus(info.compressionStatus)) {
      // Track failed attempts (only mark as failed if not forced) so we
      // stop spending compression-API calls on a chat that can't shrink.
      // Heap-pressure attempts are a safety net, not evidence that normal
      // token-threshold compaction should be latched off for this chat.
      if (!force) {
        this.hasFailedCompressionAttempt = true;
      }
    }

    return info;
  }

  private getHeapPressureRatio(): number | null {
    try {
      const { used_heap_size: usedHeapSize, heap_size_limit: heapLimit } =
        getHeapStatistics();
      if (
        !Number.isFinite(usedHeapSize) ||
        usedHeapSize < 0 ||
        !Number.isFinite(heapLimit) ||
        heapLimit <= 0
      ) {
        return null;
      }
      return usedHeapSize / heapLimit;
    } catch {
      return null;
    }
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
      // Close any dangling `model[functionCall]` whose `functionResponse`
      // never landed by the time we compose the request. Runs AFTER the
      // user-supplied turn lands so a tool_result the user is supplying
      // gets the first chance to close the pair before we synthesize an
      // `error` `functionResponse`. Covers:
      //   - Stream errored mid-tool_use (partial assistant push left a
      //     dangling functionCall), then the React scheduler's eventual
      //     tool_result lost the race against a Ctrl+Y retry whose
      //     onAllToolCallsComplete fired into `isResponding=true` and
      //     skipped submission.
      //   - The same shape from a process crash / OOM mid-flight (the
      //     transcript JSONL preserves the dangling model[fc] across
      //     `--resume`; `startChat()` calls this once on load, but a
      //     belt-and-suspenders pass here covers anything that slipped
      //     past — including dangling shapes the load-time repair didn't
      //     visit because compaction / setHistory ran after it).
      // The React scheduler's late real result is then dedup'd against
      // chat.history in `useGeminiStream.handleCompletedTools` so the
      // synthetic doesn't collide with it on the wire.
      //
      // Diagnostic: log non-empty inline-repair results. The startChat()
      // path logs synthesis events through `repairOrphanedToolUseTurnsInHistory`
      // (`[REPAIR] Synthesized N functionResponse(s) ...`) and dedup events
      // through `useGeminiStream.handleCompletedTools` (`[REPAIR] Dropping ...`),
      // but this inline call site was previously silent — when a dedup-drop
      // log shows up, investigators had no way to tell whether the
      // synthetic was planted at session-load or at this per-send pass.
      // Tag the log site so the lifecycle anchor is unambiguous.
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
        // Symmetrical with the synthesis log: a duplicate-only repair
        // (no synthesis, no hoist) here would otherwise be silent.
        debugLogger.warn(
          `[REPAIR] sendMessageStream inline pass dropped ` +
            `${inlineRepair.droppedDuplicates.length} duplicate ` +
            `functionResponse(s): ` +
            inlineRepair.droppedDuplicates
              .map((entry) => `${entry.name}(${entry.callId})`)
              .join(', '),
        );
      }
      requestContents = this.getHistory(true);
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

            // If `processStreamResponse` persisted a partial assistant turn
            // (mid-stream error after a `functionCall` was already yielded),
            // every retry-and-continue path below must drop that turn first.
            // Otherwise a successful retry's response lands AFTER the stale
            // failed-attempt model turn — two consecutive `model` entries
            // with an orphan tool_use in the first, re-triggering the
            // "tool_use_id ... corresponding tool_use" 400 this fix is
            // supposed to escape. Paths that `break` (unretryable) keep
            // the partial — the caller will see it as part of the error
            // surface.
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
            if (isRateLimit && rateLimitRetryCount < maxRateLimitRetries) {
              popPartialIfPushed();
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
                    // Defense-in-depth no-op: tryCompress() succeeded
                    // means it has already replaced this.history via
                    // setHistory(), which calls clearPendingPartialState()
                    // — so by the time we reach this line, the marker is
                    // null and popPartialIfPushed splices nothing. We
                    // keep the call as a uniformity assertion against
                    // future refactors that might switch tryCompress to
                    // an in-place mutation: in that world, the marker
                    // would NOT be reset by setHistory and this call
                    // becomes the only thing that drops the stale
                    // partial before requestContents is rebuilt below.
                    // Removing it would couple correctness to the
                    // implementation detail "setHistory always clears
                    // the marker", which the other retry branches don't
                    // share.
                    popPartialIfPushed();
                    requestContents = self.getHistory(true);
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
              createUserContent([{ text: OUTPUT_RECOVERY_MESSAGE }]),
            );
            // Signal UI/turn to clear pending (incomplete) tool calls.
            // isContinuation tells the UI to keep the text buffer so the
            // model's continuation appends to the previous partial output.
            yield { type: StreamEventType.RETRY, isContinuation: true };
            // Re-send with the updated history (includes partial + recovery)
            const recoveryContents = self.getHistory(true);
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
              //
              // Order matters: when the recovery stream errors AFTER
              // yielding a `functionCall` chunk, `processStreamResponse`
              // pushes a partial `model` turn into history before
              // re-throwing. The naive "if last is user, pop" check
              // would then no-op (last is now the partial `model`),
              // leaving `user(OUTPUT_RECOVERY_MESSAGE)` stranded as a
              // real user turn the user never sent. Two consequences:
              //  - the control-prompt text (which carries instructions
              //    meant only for the model's own continuation context)
              //    pollutes durable history and biases later turns,
              //  - the inline repair on the next sendMessageStream
              //    synthesizes an `error` `functionResponse` for the
              //    dangling `functionCall`, which the
              //    `handleCompletedTools` history-based dedup then drops
              //    when the React scheduler's REAL tool result arrives,
              //    so the model sees an "execution result was not
              //    recorded" error for a tool that actually succeeded.
              // Pop the partial model turn FIRST, then the recovery
              // user turn. The partial-push markers are also cleared
              // in lockstep so the outer `finally` JSONL flush can't
              // resurrect a partial we just deleted from live history.
              //
              // Index-checked pop instead of a positional `pop()` so
              // we match the diagnostic standard set by
              // `popPartialIfPushed` above (splice at `idx` + warn on
              // bounds/role mismatch). The two rollback strategies
              // share an undocumented positional assumption: nothing
              // mutates `this.history` between
              // `processStreamResponse`'s push and the for-await
              // catch here. If a future change inserts a mutation in
              // that window (compression side-effect, abort-signal
              // handler, telemetry hook), a naked
              // `history.pop()` would silently remove the wrong
              // entry while `clearPendingPartialState()` clears
              // markers for the actual partial — leaving it
              // permanently stranded with no log trail. The warn
              // makes any future violation visible immediately.
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
        streamDoneResolver!();
        // Flush any deferred partial-tool_use record into the JSONL
        // transcript. The retry loop and the post-loop max-tokens
        // escalation block can BOTH leave one of these on the chat:
        //
        //  - Retry loop: any partial rolled back by popPartialIfPushed
        //    has its stash cleared; any partial that survived (success
        //    break with no partial set, or unretryable break with the
        //    partial kept) leaves its record set so we record-and-clear
        //    it here.
        //  - Max-tokens escalation: the escalated stream re-enters
        //    `processStreamResponse`, which sets a NEW
        //    `pendingPartialAssistantRecord` if it errors mid-tool_use.
        //    That throw propagates through the for-await above without
        //    touching the (now-passed) retry-loop catch, so without a
        //    flush in `finally` the partial would be live in
        //    `this.history` (the escalated processStreamResponse already
        //    pushed it) but absent from the JSONL transcript. `--resume`
        //    would then rehydrate a truncated transcript whose live
        //    history disagrees with disk, and
        //    `repairOrphanedToolUseTurnsInHistory` would find nothing to
        //    repair on load — the React scheduler's late real result
        //    becomes a permanent orphan, reproducing the exact wedge
        //    this PR prevents.
        //
        // Putting the flush in `finally` covers ALL throw paths
        // (escalation, post-retry-loop `throw lastError`, the for-await
        // consumer's `.return()` if it abandons the generator) and the
        // normal completion path with a single statement. The marker
        // and stash are dropped together to preserve the
        // "marker non-null ⇔ stash non-null" invariant.
        if (self.pendingPartialAssistantRecord) {
          // Recording-service errors (disk full, write permission,
          // serialization failure) MUST NOT propagate out of the
          // generator's `finally` — that would mask the real send
          // outcome (success or original throw) with a JSONL-write
          // error the caller can't usefully act on. Instead, log and
          // drop the record: the partial is already durable in
          // `this.history`, so live behavior is unaffected; only the
          // disk transcript loses this turn (eventual consistency
          // restored on the next successful flush of any other turn).
          try {
            self.chatRecordingService?.recordAssistantTurn(
              self.pendingPartialAssistantRecord,
            );
          } catch (recordErr) {
            // Error-level (not warn): a persistent JSONL write failure
            // (disk full, permission, serialization) silently loses
            // every deferred partial after this point — exactly the
            // class of failure that warrants monitoring attention.
            // Transient failures still bubble through as a single
            // error per occurrence; if logs are spammed it's an
            // operational signal that the recording layer is broken,
            // not noise.
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
   * Returns a defensive copy of the last raw history entry without cloning the
   * full conversation. This avoids O(history) cloning, though cloning the last
   * entry is still proportional to that entry's own size.
   */
  getLastHistoryEntry(): Content | undefined {
    return this.getHistoryTail(1)[0];
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
   * Returns the set of `functionResponse.id` values present anywhere
   * in user turns of the raw chat history. Walks `this.history` in
   * place — no `structuredClone`, no per-part copy — so it is safe to
   * call on hot paths (e.g. on every tool-completion batch in
   * `useGeminiStream.handleCompletedTools`).
   *
   * The dedup pass only needs id strings; routing it through
   * {@link getHistory} would deep-clone the entire conversation
   * (recursive `structuredClone` over every part, including large tool
   * outputs) on every batch and visibly stall the React UI thread on
   * long sessions (200+ entries with sizable tool results).
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
    // The marker is per-send-attempt. Today's callers (cancelled-tool
    // synthesis in useGeminiStream, ACP session injects,
    // shellCommandProcessor) only run between sends, so the originating
    // sendMessageStream has either already popped the partial via the
    // retry loop or hit an unrecoverable break — in both cases the
    // marker is no longer load-bearing.
    //
    // If a future code path ever calls addHistory BETWEEN the partial
    // push and the retry attempt, silently clearing the marker would
    // strand the partial: popPartialIfPushed would no-op, the failed
    // attempt's `model[functionCall]` would survive into the retry,
    // and a successful retry's response would land as a SECOND
    // consecutive model turn (the wedge this whole subsystem exists
    // to prevent). The log below makes that coupling observable —
    // anyone investigating a stale-partial bug will see this log line
    // pointing straight at the offending caller. Error-level (not
    // warn) because this is a true invariant violation: the existing
    // call graph cannot legitimately hit this branch, so any
    // occurrence is a real bug in a future caller, not noise.
    if (
      this.pendingPartialAssistantTurnIndex !== null ||
      this.pendingPartialAssistantRecord !== null
    ) {
      debugLogger.error(
        '[INVARIANT_VIOLATION] addHistory called while a partial-push ' +
          'marker is active — clearing it. This is unexpected during an active sendMessageStream ' +
          'and likely indicates a new caller violating the between-sends ' +
          'invariant. See comment at GeminiChat.addHistory for context.',
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
   * Repair the inverse of `stripOrphanedUserEntriesFromHistory`: close every
   * dangling `model[functionCall]` whose corresponding `user[functionResponse]`
   * never landed (e.g. process crash between the partial-tool_use push and
   * tool completion, or Ctrl+Y race before in-flight scheduler completed).
   *
   * Returns the list of synthesized `(callId, name)` tuples so the React
   * tool scheduler can dedupe its eventual real `tool_result` for those
   * callIds (see `handleCompletedTools` in `useGeminiStream.ts`).
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
          const lastPromptTokenCount =
            usageMetadata.promptTokenCount || usageMetadata.totalTokenCount;
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
          if (usageMetadata.cachedContentTokenCount && this.telemetryService) {
            this.telemetryService.setLastCachedContentTokenCount(
              usageMetadata.cachedContentTokenCount,
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
        tokens: usageMetadata,
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

    // Mid-stream failure recovery: if the upstream stream threw (typical on
    // weak networks — SSE cut between a tool_use `content_block_stop` and
    // the terminal `message_stop`) AND any `functionCall` chunk was already
    // yielded to consumers, we must persist the partial assistant turn here.
    //
    // The content generator (Anthropic / OpenAI) emits a `functionCall` part
    // only at the end of a tool_use block. Once yielded, `Turn.run` registers
    // a `ToolCallRequest` event, the React tool scheduler queues the call,
    // and `handleCompletedTools` will fire `submitQuery(..., ToolResult)` —
    // pushing a user message with `functionResponse` into history — even
    // though the parent stream errored. Without preserving the matching
    // tool_use on the model side, the next request body would have
    // `user → user[tool_result]` with no tool_use in between, and the
    // Anthropic-compatible API (DeepSeek, Anthropic, etc.) rejects with
    //   "tool_use_id ... must have a corresponding tool_use block in the
    //    previous message"
    // — an unrecoverable state because Ctrl+Y's `stripOrphanedUserEntries`
    // only strips trailing user entries; the lost tool_use can't be
    // resurrected.
    //
    // Plain-text partial turns (no functionCall yielded) are deliberately
    // NOT persisted — the Retry path pops the trailing user prompt and
    // re-issues it; a stale partial-text model turn between them would
    // either bias the retry or surface as a duplicate.
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

      precedingModel.parts = [
        ...(precedingModel.parts ?? []),
        ...(modelContinuation.parts ?? []),
      ];
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
