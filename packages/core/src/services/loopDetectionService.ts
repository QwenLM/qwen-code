/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ServerGeminiStreamEvent } from '../core/turn.js';
import { GeminiEventType } from '../core/turn.js';
import type { ThoughtSummary } from '../utils/thoughtUtils.js';
import {
  logLoopDetected,
  logLoopDetectionDisabled,
} from '../telemetry/loggers.js';
import {
  LoopDetectedEvent,
  LoopDetectionDisabledEvent,
  LoopType,
} from '../telemetry/types.js';
import type { Config } from '../config/config.js';
import { getToolCallRepeatKey } from '../utils/tool-call-repeat-key.js';
import { BATCH_BUDGET_FIT_PREFIX } from '../utils/tool-response-finalizer.js';
import {
  FULL_OUTPUT_DIGEST_LABEL,
  OUTPUT_TOO_LARGE_PREFIX,
  PERSISTED_OUTPUT_OPEN_TAG,
  PERSISTED_PREVIEW_MARKER,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
  TRUNCATED_PART_MARKER,
} from '../utils/truncation.js';

// Re-exported for existing importers (daemon turn-loop guard); the
// implementation lives in a leaf module so replay detection in
// toolCallIdUtils can share it without an import cycle through this
// service's turn.js dependency.
export { getToolCallRepeatKey };

// Consecutive identical tool calls (same name + identical args) tolerated
// before the always-on guard halts the turn. Repeating an identical call
// yields an identical result, so this is never a productive pattern. Kept
// below the DashScope server-side "Repetitive tool calls detected" threshold
// so the client breaks the loop before the server rejects the whole
// conversation with a 400 (issue #5019).
const TOOL_CALL_LOOP_THRESHOLD = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;
const MAX_HISTORY_LENGTH = 1000;

// Tools whose identical arguments do NOT imply an identical result: they
// read shared state that other agents can mutate between calls (issue
// #9450 — a teammate polling `task_list` while peers keep completing tasks
// was halted by the argument-only guards). For these tools the guards below
// become result-aware: repetition only counts as a loop when the observed
// results are unchanged too. Intentionally narrow — deterministic tools keep
// the argument-only behavior, and other team tools (`send_message`,
// `task_update`) have different mutation/delivery semantics and stay out.
const STATEFUL_READ_TOOLS: ReadonlySet<string> = new Set(['task_list']);

/**
 * Whether a tool is a stateful read tool (see STATEFUL_READ_TOOLS).
 * Exported so the daemon's turn-loop guard (ACP Session) applies the same
 * result-aware treatment as this service — the two runtimes must not drift
 * (issue #9450 requirement #6).
 */
export function isStatefulReadTool(toolName: string): boolean {
  return STATEFUL_READ_TOOLS.has(toolName);
}

// Bound for the callId → request map used to pair tool results with their
// requests (recordToolResultByCallId). Parallel tool batches are far smaller;
// the cap only protects against unpaired entries accumulating.
const MAX_TRACKED_TOOL_REQUESTS = 500;

// Thought tracking
const THOUGHT_REPEAT_THRESHOLD = 3;
const MAX_THOUGHT_HISTORY = 50;

// File read tracking.
//
// Thresholds were raised from 5/10 because a prompt like "summarize this
// project" legitimately opens with `list_directory` + several parallel
// `read_file` calls in a single turn, which previously tripped the detector
// on its first productive move. 8/15 leaves enough headroom for that shape
// while still catching pathological read-only churn. Combined with the
// cold-start exemption below (see `hasSeenNonReadTool`), a turn that has
// only ever performed read-like actions is treated as exploration, not a
// loop — once any non-read tool lands, the detector activates.
const FILE_READ_THRESHOLD = 8;
const FILE_READ_WINDOW = 15;

// Action stagnation tracking
const STAGNATION_THRESHOLD = 8;

// Similar shell inspection commands are precise enough to guard always-on
// when the model keeps rewriting overview-style repository checks instead of
// making progress. Use the same threshold as the heuristic action-stagnation
// guard to leave room for legitimate branch-review inspection.
const SHELL_COMMAND_STAGNATION_THRESHOLD = STAGNATION_THRESHOLD;

// Global tool call duplicate tracking: how many times the same (tool, args)
// pair must appear across the entire turn (not necessarily consecutively)
// before it is treated as a loop. Exported so the daemon's turn-loop guard
// (ACP Session) applies the same stuck-repetition signal as this service.
export const GLOBAL_DUPLICATE_THRESHOLD = 6;

// Alternating pattern detection: number of complete AB cycles needed to
// trip the detector (3 cycles = 6 calls: A B A B A B).
const ALTERNATING_PATTERN_CYCLES = 3;

// Default per-turn tool call cap. Circuit breaker against runaway turns.
// Not gated by skipLoopDetection, but configurable via the
// `model.maxToolCallsPerTurn` setting (values <= 0 disable the cap) and
// suppressed by an explicit in-session disable. A "turn" for cap purposes
// is one model turn plus its ToolResult continuations; a blocking Stop-hook
// continuation (e.g. a /goal iteration) starts a fresh budget via
// loopDetector.reset() in client.ts, so the cap bounds each iteration
// rather than an entire goal chain.
//
// This default is a *soft* cap: once the turn exceeds it, the cap only halts
// when a stuck-repetition signal is present (the model keeps repeating the
// same call). A productive turn (diverse calls, no repetition) is allowed to
// continue up to the hard cap below. This avoids halting legitimately large
// multi-package implementation turns (modern models make hundreds of calls).
// NOTE: this adaptive behavior applies only to the default; an *explicitly*
// set `model.maxToolCallsPerTurn` is honored as a hard cap (the released
// contract) — see checkTurnToolCallCap.
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 100;

// Hard cap = soft cap * this multiplier, for the adaptive (default) cap only.
// Absolute backstop that halts regardless of repetition, so a runaway that
// varies its arguments on every call (which no repetition signal catches) is
// still bounded. With the default soft cap of 100 this is 1000 — high enough
// that modern models making hundreds of legitimate calls per task are not
// false-positived, while still bounding a pathological runaway.
const ADAPTIVE_CAP_HARD_MULTIPLIER = 10;

/**
 * Halt predicate of the per-turn tool-call cap, shared with the daemon's
 * turn-loop guard (ACP Session's recordDaemonToolCalls) so both runtimes
 * decide identically and cannot drift. `cap` is the resolved effective cap
 * from getMaxToolCallsPerTurn (Infinity when disabled); `maxKeyRepeat` is
 * the turn's running max count of any single (tool, args) repeat key.
 * Returns true when a turn that has emitted `totalCalls` calls must halt:
 * always past an explicit cap (the released hard-cap contract), and past
 * the adaptive default cap only on a stuck-repetition signal or at the
 * hard backstop (see checkTurnToolCallCap).
 */
export function shouldHaltOnTurnToolCallCap(
  totalCalls: number,
  maxKeyRepeat: number,
  cap: number,
  isExplicitCap: boolean,
): boolean {
  if (totalCalls <= cap) return false;
  const hardCap = cap * ADAPTIVE_CAP_HARD_MULTIPLIER;
  const stuck = maxKeyRepeat >= GLOBAL_DUPLICATE_THRESHOLD;
  return isExplicitCap || totalCalls > hardCap || stuck;
}

// Producer shapes of the oversized-result stubs (see utils/truncation.ts
// and the batch-budget finalizer). Recognition is anchored on these
// prefixes: task results such as task_list embed peer-authored text
// verbatim, and that text can quote stub markers (this PR puts a
// `Full output sha256: <hex>` line into every oversized output, and agents
// quote stubs into board state). Honoring a marker found MID-string would
// let quoted content collapse or vary the whole-board fingerprint —
// re-shipping the #9450 false halt via content. Every shape here embeds a
// per-call unique artifact path in its envelope, which is exactly why it
// must be reduced to its digest; content that merely contains (or even
// starts with) the digest label carries no per-call path and is
// fingerprinted verbatim instead.
const STUB_PRODUCER_PREFIXES: readonly string[] = [
  PERSISTED_OUTPUT_OPEN_TAG,
  OUTPUT_TOO_LARGE_PREFIX,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
  // The batch-budget finalizer's fitText header.
  BATCH_BUDGET_FIT_PREFIX,
];

/**
 * Extracts the sha256 digest a stub producer embedded for the FULL
 * pre-truncation output, anchored to a producer line: the label must start
 * its line and be followed by exactly 64 hex chars ending the line. A
 * mid-string mention of the label (e.g. board content quoting a stub) never
 * matches. Returns null when no anchored digest is present.
 */
function extractAnchoredStubDigest(value: string): string | null {
  let searchFrom = 0;
  for (;;) {
    const index = value.indexOf(FULL_OUTPUT_DIGEST_LABEL, searchFrom);
    if (index < 0) return null;
    const digestStart = index + FULL_OUTPUT_DIGEST_LABEL.length;
    const lineAnchored = index === 0 || value[index - 1] === '\n';
    if (lineAnchored) {
      const digest = value.slice(digestStart, digestStart + 64);
      const terminator = value[digestStart + 64];
      if (
        /^[0-9a-f]{64}$/.test(digest) &&
        (terminator === undefined || terminator === '\n' || terminator === '\r')
      ) {
        return digest;
      }
    }
    searchFrom = index + 1;
  }
}

/**
 * Reduces an oversized-result stub to its semantic payload for
 * fingerprinting. Oversized tool results are rewritten into truncation
 * stubs: a `<persisted-output>` envelope embedding the unique
 * `<toolResultsDir>/<callId>.txt` path, an unwrapped `Output too large
 * (...)` envelope whose session-dependent note can also vary between
 * calls, the `truncateAndSaveToFile` shape embedding a random temp-file
 * name, or a batch-budget fit whose header embeds a per-call artifact
 * path. Hashing the envelope would make every fingerprint unique per call
 * — silently disabling every result-aware guard for exactly the largest
 * results. The producers embed a sha256 of the full pre-truncation output
 * (FULL_OUTPUT_DIGEST_LABEL); prefer it over any visible content, because
 * previews and head+tail payloads only cover the first/last chars — a
 * board mutating in the dropped band must still fingerprint differently
 * each poll (and a frozen board identically) no matter which stub shape
 * carries it. The digest-first rule also covers stubs nested inside a
 * further batch-budget fit, where the outer digest fingerprints the inner
 * stub as a whole. Stubs without a digest line fall back to the shape's
 * visible payload after its stable marker. The markers are the shared
 * constants from utils/truncation.ts and the batch-budget finalizer so the
 * parser cannot drift from the producer. The `<persisted-stub>` sentinel
 * keeps a stub fingerprint from ever colliding with a small literal output
 * that matches the payload.
 *
 * Stub recognition is gated on the producer prefixes (see
 * STUB_PRODUCER_PREFIXES) and the digest must be line-anchored with a full
 * 64-hex payload, so arbitrary result text that merely contains the label
 * is fingerprinted verbatim instead of being collapsed to a quoted window.
 */
function stripPersistenceEnvelope(value: string): string {
  const isProducerStub = STUB_PRODUCER_PREFIXES.some((prefix) =>
    value.startsWith(prefix),
  );
  if (!isProducerStub) {
    return value;
  }

  const digest = extractAnchoredStubDigest(value);
  if (digest !== null) {
    return `<persisted-stub>sha256:${digest}`;
  }

  const isPreviewStub =
    value.startsWith(PERSISTED_OUTPUT_OPEN_TAG) ||
    value.startsWith(OUTPUT_TOO_LARGE_PREFIX);
  if (isPreviewStub) {
    const marker = `${PERSISTED_PREVIEW_MARKER}\n`;
    const index = value.indexOf(marker);
    if (index >= 0) {
      return `<persisted-stub>${value.slice(index + marker.length)}`;
    }
    return value;
  }
  if (value.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX)) {
    const marker = `\n${TRUNCATED_PART_MARKER}`;
    const index = value.indexOf(marker);
    if (index >= 0) {
      return `<persisted-stub>${value.slice(index + marker.length)}`;
    }
  }
  return value;
}

/**
 * Reconstructs the model-visible result text from tool response parts.
 * Only the fingerprint of this text is retained by the guards, never the
 * text itself. Returns null when the parts carry no functionResponse
 * content. Shared by this service and the daemon's turn-loop guard (ACP
 * Session) so both runtimes fingerprint results identically and cannot
 * drift (issue #9450 requirement #6).
 */
export function extractToolResultText(
  responseParts: readonly Part[],
): string | null {
  const chunks: string[] = [];
  for (const part of responseParts) {
    const functionResponse = part.functionResponse;
    if (!functionResponse) continue;
    // Oversized results arrive as persistence stubs whose envelope embeds
    // a per-call unique file path; fingerprint the semantic payload only
    // (see stripPersistenceEnvelope) so identical underlying results stay
    // identical no matter where they were persisted.
    chunks.push(
      JSON.stringify(functionResponse.response ?? {}, (_key, value) =>
        typeof value === 'string' ? stripPersistenceEnvelope(value) : value,
      ),
    );
  }
  return chunks.length > 0 ? chunks.join('\n') : null;
}

/**
 * sha256 fingerprint of a tool result's model-visible text (see
 * extractToolResultText), or null when the parts carry no functionResponse
 * content. Shared with the daemon's turn-loop guard for the same
 * cannot-drift reason as extractToolResultText.
 */
export function fingerprintToolResult(
  responseParts: readonly Part[],
): string | null {
  const resultText = extractToolResultText(responseParts);
  if (resultText === null) return null;
  return createHash('sha256').update(resultText).digest('hex');
}

/**
 * Service for detecting and preventing infinite loops in AI responses.
 * Monitors tool call repetitions and content sentence repetitions.
 */
export class LoopDetectionService {
  private readonly config: Config;
  private promptId = '';

  // Tool call tracking
  private lastToolCallKey: string | null = null;
  private toolCallRepetitionCount: number = 0;

  // Content streaming tracking
  private streamContentHistory = '';
  private contentStats = new Map<string, number[]>();
  private lastContentIndex = 0;
  private loopDetected = false;
  private inCodeBlock = false;

  // Session-level disable flag
  private disabledForSession = false;

  // Thought tracking
  private thoughtHistory: string[] = [];

  // Tool call tracking (for read-file loop + stagnation detection)
  private recentToolCalls: Array<{ name: string; args: object }> = [];

  // Action stagnation tracking: consecutive calls to the same tool *name*
  // (regardless of args). Distinct from checkToolCallLoop, which requires
  // identical name AND args. This catches parameter-thrashing loops where
  // the model keeps calling one tool with varying arguments.
  private sameNameStreak = 0;
  private lastSeenToolName: string | null = null;

  // Always-on shell inspection stagnation tracking. This is narrower than
  // action stagnation: it only covers overview-style git inspection commands
  // and excludes file-specific diffs that are normal during code review.
  private lastShellInspectionKey: string | null = null;
  private shellInspectionStreak = 0;

  // Cold-start gate for READ_FILE_LOOP: the opening exploration of a prompt
  // is almost always read-heavy (list + parallel reads). Until at least one
  // non-read-like tool fires, a window full of reads is treated as legitimate
  // exploration rather than loop evidence. Resets per-prompt in reset().
  private hasSeenNonReadTool = false;

  // Non-consecutive global duplicate tracking: counts every (tool, args)
  // pair seen across the entire turn. When any pair reaches
  // GLOBAL_DUPLICATE_THRESHOLD, the turn is halted.
  private globalToolCallCounts = new Map<string, number>();

  // Sliding window of recent tool-call keys for alternating-pattern
  // detection (ABABAB…). Kept at 2 * ALTERNATING_PATTERN_CYCLES entries.
  private recentToolCallKeys: string[] = [];

  // Total tool calls emitted in the current turn. Always-on circuit breaker
  // (see checkTurnToolCallCap for the adaptive soft/hard logic). Accumulates
  // across ToolResult continuations within a turn (reset() only runs for
  // top-level interactions).
  private turnToolCallTotal = 0;

  // Rollback floor for turnToolCallTotal: the committed total as of the last
  // completed round-trip (Finished event). A retry re-streams the failed
  // attempt's tool calls (Turn clears pendingToolCalls on retry), so on Retry
  // we roll back to this floor — discarding only the failed attempt, not the
  // counts from prior completed round-trips.
  private turnToolCallTotalCommitted = 0;

  // Always-on per-(tool,args) repeat tracker for the adaptive cap. The cap is
  // always-on, but globalToolCallCounts is only maintained inside the gated
  // heuristic path, so the cap keeps its own tracker to stay independent of
  // skipLoopDetection. capMaxKeyRepeat is the running max count of any single
  // (tool,args) key this turn — the stuck-repetition signal that decides
  // whether exceeding the soft cap halts (stuck) or is allowed (productive).
  private capKeyCounts = new Map<string, number>();
  private capMaxKeyRepeat = 0;

  // Stateful-read contribution to the cap's stuck signal: the running max of
  // the CURRENT consecutive-identical-result streaks (see
  // statefulRepeatState). Unlike capMaxKeyRepeat this disarms when a result
  // changes — a frozen-then-thawed board must release the cap exactly as it
  // releases the result-time global-duplicate count, so the adaptive cap
  // cannot latch a stale peak from a frozen phase and halt productive
  // polling just past the soft cap. Kept separate from capMaxKeyRepeat
  // (which stays a high-water mark for deterministic tools, where a 6x
  // repeat is never productive even if the model later varies its calls).
  private statefulCapKeyRepeat = 0;

  // Result-aware tracking for stateful read tools (see STATEFUL_READ_TOOLS).
  // Keyed by the (tool, args) repeat key. `resultsObserved` /
  // `unchangedStreak` count results within the CURRENT consecutive-identical
  // streak (restarted when the streak breaks); `lastFingerprint` survives
  // streak breaks so a state change is still visible across interleaved
  // calls (used by the action-stagnation reset).
  // `consecutiveIdenticalResults` is the stuck-repetition evidence for the
  // global-duplicate detector and the adaptive cap (replacing the
  // request-time global-duplicate counting and the cap's stuck-repetition
  // counting for these tools): it counts results that repeat the key's
  // IMMEDIATELY PRECEDING result (interleaved calls still accumulate) and
  // restarts at 1 whenever a result differs from its predecessor — the same
  // call returning changed state is productive and must not accumulate
  // toward either halt. Counting turn-wide (key, fingerprint) totals
  // instead would halt a board oscillating between two byte-identical
  // states even though every result there differs from its predecessor.
  private statefulRepeatState = new Map<
    string,
    {
      resultsObserved: number;
      unchangedStreak: number;
      consecutiveIdenticalResults: number;
      lastFingerprint: string | undefined;
    }
  >();

  // Stateful keys that recorded a result since the last Finished round-trip
  // boundary. At each Finished, keys NOT in this set produced no result for
  // a whole round-trip: the model moved on to other work, so their streak
  // evidence is abandoned and must stop feeding the cap's stuck signal —
  // otherwise a key abandoned after a frozen phase keeps its peak for the
  // whole prompt and the adaptive cap halts a productive turn just past the
  // soft cap (issue #9450). Keys that keep polling appear in every round's
  // results and are never decayed.
  private statefulResultKeysSinceLastFinished = new Set<string>();

  // callId → request pairing so results can be matched to their calls when
  // the runtime only has the response (populated on ToolCallRequest events,
  // consumed by recordToolResultByCallId).
  private requestByCallId = new Map<string, { name: string; args: object }>();

  // Repeat keys known to belong to a stateful read tool, so the
  // alternating-pattern carve-out can tell which window participants are
  // stateful (repeat keys are hashes and do not carry the tool name).
  private statefulRepeatKeys = new Set<string>();

  // Rolling per-key result fingerprints for the alternating-pattern
  // carve-out (see checkAlternatingPattern), capped at one window's worth
  // of occurrences per key so a full ABAB window is judged on the results
  // its own requests produced.
  private statefulAlternationHistory = new Map<string, string[]>();

  // Per-key count of stateful requests fed to the heuristic tier whose
  // results have NOT landed yet (incremented in addAndCheckHeuristicLoops,
  // decremented in recordToolResult). With parallel tool batches both
  // requests of a round reach the guard before that round's results land,
  // so a window judged on args alone would skip the exonerating result
  // check for occurrences still in flight and false-halt a productive
  // poller; the carve-out subtracts these from its expected results (issue
  // #9450). Reduces to the sequential arithmetic when results land before
  // the next request is fed.
  private statefulInFlight = new Map<string, number>();

  // Loop type of the most recent firing. Bubbled up through the
  // LoopDetected event so callers (non-interactive CLI, telemetry) can tell
  // the user which detector actually fired.
  private lastLoopType: LoopType | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Returns the LoopType of the most recent detection, or null if no loop
   * has been detected in the current prompt.
   */
  getLastLoopType(): LoopType | null {
    return this.lastLoopType;
  }

  getConsecutiveToolCallCount(): number {
    return this.toolCallRepetitionCount;
  }

  /**
   * Disables loop detection for the current session.
   */
  disableForSession(): void {
    this.disabledForSession = true;
    logLoopDetectionDisabled(
      this.config,
      new LoopDetectionDisabledEvent(this.promptId),
    );
  }

  /**
   * Records the executed result of a tool call so the guards can treat
   * stateful read tools (see STATEFUL_READ_TOOLS) result-aware: identical
   * arguments whose results keep changing are productive polling, not a
   * loop (issue #9450). Call this once per executed call, after execution
   * and before the model is re-prompted with the result. Runtime paths that
   * only hold the response (no name/args) can use recordToolResultByCallId.
   *
   * Returns true when the recorded result itself trips a detector (the
   * result-aware global-duplicate count); callers must then halt the turn
   * the same way they do for an event-detected loop.
   */
  recordToolResult(
    toolCall: { name: string; args: object },
    responseParts: readonly Part[],
  ): boolean {
    if (this.loopDetected) return true;
    if (this.disabledForSession) return false;
    if (!this.isStatefulReadTool(toolCall.name)) return false;

    const fingerprint = fingerprintToolResult(responseParts);
    if (fingerprint === null) return false;
    const key = this.getToolCallKey(toolCall);

    // Round-trip boundary bookkeeping: this key produced a result in the current
    // round, so the Finished-boundary decay must not treat it as abandoned
    // (see statefulResultKeysSinceLastFinished).
    this.statefulResultKeysSinceLastFinished.add(key);

    // One in-flight request for this key has landed: unreserve it for the
    // alternating-pattern carve-out (see statefulInFlight). Floored at zero
    // because results can be recorded without a heuristic feed when
    // skipLoopDetection keeps the heuristic tier off.
    const inFlight = this.statefulInFlight.get(key) ?? 0;
    if (inFlight > 0) {
      this.statefulInFlight.set(key, inFlight - 1);
    }

    // Rolling result history for the alternating-pattern carve-out (see
    // checkAlternatingPattern), capped at one window's occurrences per key.
    const history = this.statefulAlternationHistory.get(key) ?? [];
    history.push(fingerprint);
    if (history.length > ALTERNATING_PATTERN_CYCLES) {
      history.shift();
    }
    this.statefulAlternationHistory.set(key, history);

    // Consecutive-streak evidence for the always-on guard. The state entry
    // can predate the streak (lastFingerprint survives streak breaks), so
    // create it lazily but only count results while a streak exists.
    let state = this.statefulRepeatState.get(key);
    if (!state) {
      state = {
        resultsObserved: 0,
        unchangedStreak: 0,
        consecutiveIdenticalResults: 0,
        lastFingerprint: undefined,
      };
      this.statefulRepeatState.set(key, state);
    }
    const firstResult = state.lastFingerprint === undefined;
    const fingerprintChanged =
      !firstResult && state.lastFingerprint !== fingerprint;
    if (this.lastToolCallKey === key) {
      state.resultsObserved++;
      if (firstResult) {
        state.lastFingerprint = fingerprint;
      } else if (state.lastFingerprint === fingerprint) {
        state.unchangedStreak++;
      } else {
        state.unchangedStreak = 0;
        state.lastFingerprint = fingerprint;
      }
    } else {
      state.lastFingerprint = fingerprint;
    }

    // A changed result is observable progress: restart the same-name streak
    // so ACTION_STAGNATION does not fire on productive polling.
    if (fingerprintChanged && this.lastSeenToolName === toolCall.name) {
      this.sameNameStreak = 1;
    }

    // Consecutive identical-result counting (see statefulRepeatState): a
    // result that differs from the key's predecessor restarts the count, so
    // an oscillating board never accumulates toward either halt.
    const consecutiveIdentical = fingerprintChanged
      ? 1
      : state.consecutiveIdenticalResults + 1;
    state.consecutiveIdenticalResults = consecutiveIdentical;

    // Cap stuck signal from result evidence (see statefulCapKeyRepeat). A
    // raised peak must NOT latch: when a result changes, recompute the peak
    // from the keys' CURRENT streaks so a thawed board disarms the adaptive
    // cap exactly as it disarms the result-time global-duplicate count.
    if (consecutiveIdentical > this.statefulCapKeyRepeat) {
      this.statefulCapKeyRepeat = consecutiveIdentical;
    } else if (fingerprintChanged) {
      this.recomputeStatefulCapPeak();
    }

    // The global-duplicate detector is gated (skipLoopDetection) exactly as
    // its request-time counterpart in addAndCheckHeuristicLoops.
    if (
      !this.config.getSkipLoopDetection() &&
      consecutiveIdentical >= GLOBAL_DUPLICATE_THRESHOLD
    ) {
      this.lastLoopType = LoopType.GLOBAL_TOOL_CALL_DUPLICATE;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(
          LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
          this.promptId,
        ),
      );
      this.loopDetected = true;
      return true;
    }
    return false;
  }

  /**
   * Variant of recordToolResult for runtimes that only have the response:
   * the request is resolved through the callId pairing populated on
   * ToolCallRequest events. Unknown callIds (e.g. client-initiated calls
   * that never streamed through this service) are ignored.
   */
  recordToolResultByCallId(
    callId: string,
    responseParts: readonly Part[],
  ): boolean {
    const request = this.requestByCallId.get(callId);
    if (!request) return false;
    this.requestByCallId.delete(callId);
    return this.recordToolResult(
      { name: request.name, args: request.args },
      responseParts,
    );
  }

  /**
   * Notes that a call which streamed through the guards was suppressed
   * WITHOUT executing (a cross-round replay of an already-handled provider
   * call id, or an authorization rejection), so its synthetic response carries
   * no result evidence and must not be recorded via recordToolResult /
   * recordToolResultByCallId. The request-time reservations the guards made
   * when the call streamed in must unwind: the callId pairing is dropped (no
   * real result will land for it), the alternating-pattern carve-out's
   * in-flight reservation is released (otherwise the carve-out over-subtracts
   * in-flight counts and judges the window on too little evidence), and the
   * key is marked as having produced activity since the last Finished
   * boundary — the model DID re-issue the poll; suppression is the runtime's
   * machinery, not abandonment, so the decay must not wipe a live
   * frozen-board streak on the next boundary (the daemon twin skips decay
   * for batches that execute nothing instead — recordDaemonToolCalls in the
   * ACP Session). Without this, a replay-suppressed round is
   * indistinguishable from abandonment and disarms the result-aware halts.
   * Unknown callIds (never streamed through the guards) are ignored.
   */
  noteSuppressedToolCallByCallId(callId: string): void {
    const request = this.requestByCallId.get(callId);
    if (!request) return;
    this.requestByCallId.delete(callId);
    if (!this.isStatefulReadTool(request.name)) return;
    const key = this.getToolCallKey(request);
    // Floored at zero because the heuristic tier (the only writer besides
    // this unwind) may be off under skipLoopDetection; a stale decrement is
    // inert then — nothing reads the count until a Retry/reset clears it.
    const inFlight = this.statefulInFlight.get(key) ?? 0;
    if (inFlight > 0) {
      this.statefulInFlight.set(key, inFlight - 1);
    }
    this.statefulResultKeysSinceLastFinished.add(key);
  }

  private isStatefulReadTool(toolName: string): boolean {
    return isStatefulReadTool(toolName);
  }

  private getToolCallKey(toolCall: { name: string; args: object }): string {
    return getToolCallRepeatKey(toolCall.name, toolCall.args);
  }

  /**
   * Convenience aggregate that runs every tier in order: the always-on
   * safeties (consecutive-identical guard, shell inspection-command
   * stagnation guard, and per-turn cap) followed by the opt-in heuristics.
   * Intended as a single "check everything" entry point for unit tests.
   * Production code (client.ts) intentionally calls the tiers separately so
   * the `skipLoopDetection` gate can sit between them — a new guard added here
   * will NOT take effect in production unless it is also wired into
   * checkAlwaysOnSafeties or addAndCheckHeuristicLoops.
   * @param event - The stream event to process
   * @returns true if any tier detects a loop, false otherwise
   */
  addAndCheck(event: ServerGeminiStreamEvent): boolean {
    if (this.checkAlwaysOnSafeties(event)) {
      return true;
    }

    return this.addAndCheckHeuristicLoops(event);
  }

  addAndCheckHeuristicLoops(event: ServerGeminiStreamEvent): boolean {
    if (this.loopDetected || this.disabledForSession) {
      return this.loopDetected;
    }

    switch (event.type) {
      case GeminiEventType.ToolCallRequest: {
        // content chanting only happens in one single stream, reset if there
        // is a tool call in between
        this.resetContentTracking();
        // Thought repetition is only meaningful within a single contiguous
        // reasoning stream. Once a tool call lands, the model has made
        // observable progress — any prior thoughts should not carry over.
        this.thoughtHistory = [];

        this.trackToolCall(event.value);
        const toolCallKey = this.getToolCallKey(event.value);
        // Stateful read tools are counted post-execution in
        // recordToolResult, keyed on (call, result fingerprint) instead of
        // args alone (issue #9450).
        const stateful = this.isStatefulReadTool(event.value.name);
        if (stateful) {
          this.statefulRepeatKeys.add(toolCallKey);
          // This request is now in flight: its result has not landed yet,
          // so the alternating-pattern carve-out must not expect it (see
          // statefulInFlight). recordToolResult decrements when it lands.
          this.statefulInFlight.set(
            toolCallKey,
            (this.statefulInFlight.get(toolCallKey) ?? 0) + 1,
          );
        }
        const globalDup = stateful
          ? false
          : this.checkGlobalDuplicate(toolCallKey);
        const alternating = this.checkAlternatingPattern(toolCallKey);
        const readFileLoop = this.checkReadFileLoop();
        const actionStagnation = this.checkActionStagnation();

        this.loopDetected =
          globalDup || alternating || readFileLoop || actionStagnation;
        break;
      }
      case GeminiEventType.Retry: {
        // A retry replays the failed attempt's tool calls (Turn clears
        // pendingToolCalls on retry), so drop the heuristic duplicate counters
        // to avoid firing on a duplicated replay — e.g. 3 identical calls +
        // Retry + 3 more would otherwise hit the global-duplicate threshold of
        // 6. The always-on guards reset their own counters in
        // checkAlwaysOnSafeties' Retry branch (cap rollback + always-on
        // streak reset).
        this.globalToolCallCounts.clear();
        this.recentToolCallKeys = [];
        this.statefulAlternationHistory.clear();
        this.statefulRepeatKeys.clear();
        this.statefulInFlight.clear();
        break;
      }
      case GeminiEventType.Content: {
        this.loopDetected = this.checkContentLoop(event.value);
        break;
      }
      case GeminiEventType.Thought: {
        this.trackThought(event.value);
        this.loopDetected = this.checkRepetitiveThoughts();
        break;
      }
      default:
        break;
    }
    return this.loopDetected;
  }

  /**
   * Always-on safety checks that fire regardless of the `skipLoopDetection`
   * config default. Enforces three guards: the consecutive-identical tool-call
   * loop, the shell inspection-command stagnation loop, and the per-turn
   * tool-call cap. Call this before the gated heuristic checks so none of the
   * guards can be bypassed by `skipLoopDetection`. All three honor an
   * explicit in-session disable; the cap is additionally tunable via the
   * `model.maxToolCallsPerTurn` setting.
   */
  checkAlwaysOnSafeties(event: ServerGeminiStreamEvent): boolean {
    if (this.loopDetected) {
      return true;
    }

    // A model response (round-trip) finished cleanly: commit its tool-call
    // count as the rollback floor. The per-turn total accumulates across
    // ToolResult continuations, so the floor must track the last committed
    // round-trip rather than resetting to zero.
    if (event.type === GeminiEventType.Finished) {
      this.turnToolCallTotalCommitted = this.turnToolCallTotal;
      // Results are recorded between round-trips (after the Finished event
      // of the stream that emitted their calls), so at this boundary the
      // results recorded since the previous Finished are exactly the prior
      // round's executed results — the safe point to decay stateful keys
      // absent from them (see decayAbandonedStatefulStreaks).
      this.decayAbandonedStatefulStreaks();
      return false;
    }

    // A retry re-streams the failed attempt's tool calls, which would
    // double-count against both always-on guards. Roll the per-turn cap back
    // to the last committed round-trip (never below it — prior round-trips
    // stay) and drop the consecutive-identical streak so the replayed attempt
    // cannot push it over the threshold. The adaptive cap's repeat tracker is
    // cleared (consistent with how the heuristic path clears
    // globalToolCallCounts on retry): the replayed calls re-populate it, and a
    // stuck pattern simply re-accumulates toward the threshold.
    if (event.type === GeminiEventType.Retry) {
      this.turnToolCallTotal = this.turnToolCallTotalCommitted;
      this.resetToolCallCount();
      this.capKeyCounts.clear();
      this.capMaxKeyRepeat = 0;
      this.statefulCapKeyRepeat = 0;
      // A retry replays the failed attempt's tool calls; drop the stateful
      // result evidence too so the replayed attempt is judged on its own
      // results (the consecutive counts re-accumulate as results land,
      // consistent with the capKeyCounts/globalToolCallCounts clears).
      for (const state of this.statefulRepeatState.values()) {
        state.resultsObserved = 0;
        state.unchangedStreak = 0;
        state.consecutiveIdenticalResults = 0;
      }
      this.statefulResultKeysSinceLastFinished.clear();
      this.statefulAlternationHistory.clear();
      this.statefulRepeatKeys.clear();
      this.statefulInFlight.clear();
      return false;
    }

    if (event.type !== GeminiEventType.ToolCallRequest) {
      return false;
    }

    // All always-on guards below honor an explicit in-session disable (the
    // user's active "stop detecting" choice). When disabled there is no
    // consumer for the per-call key, so skip the SHA-256 hashing entirely.
    if (this.disabledForSession) {
      return false;
    }

    // Hash the (tool,args) key once and share it across the guards that need
    // it (consecutive-identical and the adaptive cap's stuck tracker). Args
    // can be large (e.g. write_file content), so avoid recomputing per guard.
    const key = this.getToolCallKey(event.value);
    const stateful = this.isStatefulReadTool(event.value.name);
    if (stateful) {
      this.statefulRepeatKeys.add(key);
    }

    // Pair requests with their later results (recordToolResultByCallId).
    // Only stateful read tools participate: recordToolResult rejects every
    // other tool, so tracking them would just accumulate full args objects
    // (write_file args can carry whole file contents) until eviction.
    if (event.value.callId && stateful) {
      this.requestByCallId.set(event.value.callId, {
        name: event.value.name,
        args: event.value.args,
      });
      if (this.requestByCallId.size > MAX_TRACKED_TOOL_REQUESTS) {
        const oldest = this.requestByCallId.keys().next().value;
        if (oldest !== undefined) this.requestByCallId.delete(oldest);
      }
    }

    // Always-on stuck-repetition tracking for the adaptive cap (see
    // checkTurnToolCallCap): lets the cap tell a productive turn from a stuck
    // one, regardless of skipLoopDetection. Stateful read tools are counted
    // post-execution instead (recordToolResult): the same call returning
    // changed state is productive and must not build the stuck signal.
    if (!stateful) {
      this.trackCapKeyRepeat(key);
    }

    // Consecutive identical tool calls (same name AND identical args) are the
    // one repetition signal precise enough to halt unconditionally — for
    // deterministic tools an identical call returns an identical result, so
    // it is never productive. Promoted here from the opt-in tier so it
    // protects every user regardless of the `skipLoopDetection` config
    // default: the DashScope server rejects this pattern with a 400 (issue
    // #5019) far below the per-turn cap, so the gated default left users
    // unprotected. For stateful read tools the guard additionally requires
    // the observed results to be unchanged (issue #9450).
    if (this.checkToolCallLoop(event.value, key)) {
      this.loopDetected = true;
      return true;
    }

    if (this.checkShellCommandStagnation(event.value)) {
      this.loopDetected = true;
      return true;
    }

    if (this.checkTurnToolCallCap()) {
      this.loopDetected = true;
      return true;
    }
    return false;
  }

  private checkToolCallLoop(
    toolCall: { name: string; args: object },
    key: string,
  ): boolean {
    if (this.lastToolCallKey === key) {
      this.toolCallRepetitionCount++;
    } else {
      // The streak moved on: restart the result evidence for both the old
      // and the new key so each consecutive streak is judged on the results
      // observed within it.
      for (const streakKey of [this.lastToolCallKey, key]) {
        if (!streakKey) continue;
        const state = this.statefulRepeatState.get(streakKey);
        if (state) {
          state.resultsObserved = 0;
          state.unchangedStreak = 0;
        }
      }
      this.lastToolCallKey = key;
      this.toolCallRepetitionCount = 1;
    }
    if (this.toolCallRepetitionCount >= TOOL_CALL_LOOP_THRESHOLD) {
      if (this.isStatefulReadTool(toolCall.name)) {
        // Result-aware guard (issue #9450): identical arguments to a stateful
        // read do not imply an identical result, so only halt when the
        // executed results corroborate the loop. By the Nth identical request
        // the prior N-1 results have been recorded; if they were ALL observed
        // and unchanged, the repetition is genuinely unproductive. If some
        // result changed, the model's re-poll was productive — restart the
        // streak instead of halting. Missing result evidence (results never
        // recorded for this streak) fails safe and keeps the pre-#9450
        // behavior, so the DashScope protection (#5019) is never loosened by
        // a wiring gap.
        const state = this.statefulRepeatState.get(key);
        const expectedResults = this.toolCallRepetitionCount - 1;
        if (state && state.resultsObserved >= expectedResults) {
          if (state.unchangedStreak < expectedResults - 1) {
            this.toolCallRepetitionCount = 1;
            state.resultsObserved = 0;
            state.unchangedStreak = 0;
            return false;
          }
        }
      }
      this.lastLoopType = LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(
          LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
          this.promptId,
        ),
      );
      return true;
    }
    return false;
  }

  private checkShellCommandStagnation(toolCall: {
    name: string;
    args: object;
  }): boolean {
    const key = this.getShellInspectionKey(toolCall);
    if (!key) {
      this.lastShellInspectionKey = null;
      this.shellInspectionStreak = 0;
      return false;
    }

    if (this.lastShellInspectionKey === key) {
      this.shellInspectionStreak++;
    } else {
      this.lastShellInspectionKey = key;
      this.shellInspectionStreak = 1;
    }

    if (this.shellInspectionStreak >= SHELL_COMMAND_STAGNATION_THRESHOLD) {
      this.lastLoopType = LoopType.SHELL_COMMAND_STAGNATION;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.SHELL_COMMAND_STAGNATION, this.promptId),
      );
      return true;
    }

    return false;
  }

  private getShellInspectionKey(toolCall: {
    name: string;
    args: object;
  }): string | null {
    if (toolCall.name !== 'run_shell_command') {
      return null;
    }

    const command = (toolCall.args as { command?: unknown }).command;
    if (typeof command !== 'string') {
      return null;
    }

    return this.isGitOverviewInspectionCommand(command)
      ? 'run_shell_command:git-inspection'
      : null;
  }

  private isGitOverviewInspectionCommand(command: string): boolean {
    // Only classify a command as overview inspection when *every* segment of
    // the shell chain is a git status/diff/ls-files overview. A chain that also
    // stages, commits, runs another tool, or inspects file-specific diffs is
    // making progress, so it must not share the stagnation bucket and trip a
    // false halt. Failing open is the safe direction for an always-on guard.
    const segments = command
      .split(/&&|\|\||[;&|\n]/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return false;
    }
    return segments.every((segment) => {
      const match =
        /^git(?:\s+(?:-C\s+\S+|--no-pager))*\s+(status|diff|ls-files)\b/i.exec(
          segment,
        );
      if (!match) {
        return false;
      }
      return (
        match[1]?.toLowerCase() !== 'diff' ||
        this.isOverviewGitDiff(segment.slice(match[0].length))
      );
    });
  }

  private isOverviewGitDiff(args: string): boolean {
    const trimmedArgs = args.trim();
    if (!trimmedArgs) {
      return true;
    }

    const tokens = trimmedArgs.split(/\s+/);
    const pathspecSeparatorIndex = tokens.indexOf('--');
    if (
      pathspecSeparatorIndex !== -1 &&
      pathspecSeparatorIndex < tokens.length - 1
    ) {
      return false;
    }

    return tokens.every(
      (token) => token.startsWith('-') || this.isGitRevisionToken(token),
    );
  }

  private isGitRevisionToken(token: string): boolean {
    return (
      token === 'HEAD' ||
      token === '@' ||
      /^(?:HEAD|@)(?:[~^]\d*)+$/.test(token) ||
      /^[0-9a-f]{7,40}$/i.test(token) ||
      /^[^\s]+\.{2,3}[^\s]+$/.test(token)
    );
  }

  /**
   * Detects content loops by analyzing streaming text for repetitive patterns.
   *
   * The algorithm works by:
   * 1. Appending new content to the streaming history
   * 2. Truncating history if it exceeds the maximum length
   * 3. Analyzing content chunks for repetitive patterns using hashing
   * 4. Detecting loops when identical chunks appear frequently within a short distance
   * 5. Disabling loop detection within code blocks to prevent false positives,
   *    as repetitive code structures are common and not necessarily loops.
   */
  private checkContentLoop(content: string): boolean {
    // Different content elements can often contain repetitive syntax that is not indicative of a loop.
    // To avoid false positives, we detect when we encounter different content types and
    // reset tracking to avoid analyzing content that spans across different element boundaries.
    const numFences = (content.match(/```/g) ?? []).length;
    const hasTable = /(^|\n)\s*(\|.*\||[|+-]{3,})/.test(content);
    // The `-` is placed first in both classes below so it is a literal member
    // rather than a range endpoint. Written mid-class it silently became one:
    // `[*-+]` was the range U+002A-U+002B, i.e. exactly {*, +}, so `- item`
    // -- the most common bullet in markdown -- was not recognised as a list
    // item and never reset tracking, letting a long bulleted list accumulate
    // until it tripped the repetition check and halted a healthy response.
    const hasListItem =
      /(^|\n)\s*[-*+]\s/.test(content) || /(^|\n)\s*\d+\.\s/.test(content);
    const hasHeading = /(^|\n)#+\s/.test(content);
    const hasBlockquote = /(^|\n)>\s/.test(content);
    // `[+-_=*]` was the range U+002B-U+005F, which covers every digit and
    // every uppercase letter, so `SELECT`, `12345`, `ABC` and `>>>` all read
    // as horizontal rules. A divider both resets tracking and returns early
    // below, so such content was excluded from the history entirely and a
    // model chanting one of those tokens could never be detected. Only the
    // \u2500-\u257F box-drawing span is meant to be a range.
    const isDivider = /^[-+_=*\u2500-\u257F]+$/.test(content);

    if (
      numFences ||
      hasTable ||
      hasListItem ||
      hasHeading ||
      hasBlockquote ||
      isDivider
    ) {
      // Reset tracking when different content elements are detected to avoid analyzing content
      // that spans across different element boundaries.
      this.resetContentTracking();
    }

    const wasInCodeBlock = this.inCodeBlock;
    this.inCodeBlock =
      numFences % 2 === 0 ? this.inCodeBlock : !this.inCodeBlock;
    if (wasInCodeBlock || this.inCodeBlock || isDivider) {
      return false;
    }

    this.streamContentHistory += content;

    this.truncateAndUpdate();
    return this.analyzeContentChunksForLoop();
  }

  /**
   * Truncates the content history to prevent unbounded memory growth.
   * When truncating, adjusts all stored indices to maintain their relative positions.
   */
  private truncateAndUpdate(): void {
    if (this.streamContentHistory.length <= MAX_HISTORY_LENGTH) {
      return;
    }

    // Calculate how much content to remove from the beginning
    const truncationAmount =
      this.streamContentHistory.length - MAX_HISTORY_LENGTH;
    this.streamContentHistory =
      this.streamContentHistory.slice(truncationAmount);
    this.lastContentIndex = Math.max(
      0,
      this.lastContentIndex - truncationAmount,
    );

    // Update all stored chunk indices to account for the truncation
    for (const [hash, oldIndices] of this.contentStats.entries()) {
      const adjustedIndices = oldIndices
        .map((index) => index - truncationAmount)
        .filter((index) => index >= 0);

      if (adjustedIndices.length > 0) {
        this.contentStats.set(hash, adjustedIndices);
      } else {
        this.contentStats.delete(hash);
      }
    }
  }

  /**
   * Analyzes content in fixed-size chunks to detect repetitive patterns.
   *
   * Uses a sliding window approach:
   * 1. Extract chunks of fixed size (CONTENT_CHUNK_SIZE)
   * 2. Hash each chunk for efficient comparison
   * 3. Track positions where identical chunks appear
   * 4. Detect loops when chunks repeat frequently within a short distance
   */
  private analyzeContentChunksForLoop(): boolean {
    while (this.hasMoreChunksToProcess()) {
      // Extract current chunk of text
      const currentChunk = this.streamContentHistory.substring(
        this.lastContentIndex,
        this.lastContentIndex + CONTENT_CHUNK_SIZE,
      );
      const chunkHash = createHash('sha256').update(currentChunk).digest('hex');

      if (this.isLoopDetectedForChunk(currentChunk, chunkHash)) {
        this.lastLoopType = LoopType.CHANTING_IDENTICAL_SENTENCES;
        logLoopDetected(
          this.config,
          new LoopDetectedEvent(
            LoopType.CHANTING_IDENTICAL_SENTENCES,
            this.promptId,
          ),
        );
        return true;
      }

      // Move to next position in the sliding window
      this.lastContentIndex++;
    }

    return false;
  }

  private hasMoreChunksToProcess(): boolean {
    return (
      this.lastContentIndex + CONTENT_CHUNK_SIZE <=
      this.streamContentHistory.length
    );
  }

  /**
   * Determines if a content chunk indicates a loop pattern.
   *
   * Loop detection logic:
   * 1. Check if we've seen this hash before (new chunks are stored for future comparison)
   * 2. Verify actual content matches to prevent hash collisions
   * 3. Track all positions where this chunk appears
   * 4. A loop is detected when the same chunk appears CONTENT_LOOP_THRESHOLD times
   *    within a small average distance (≤ 1.5 * chunk size)
   */
  private isLoopDetectedForChunk(chunk: string, hash: string): boolean {
    const existingIndices = this.contentStats.get(hash);

    if (!existingIndices) {
      this.contentStats.set(hash, [this.lastContentIndex]);
      return false;
    }

    if (!this.isActualContentMatch(chunk, existingIndices[0])) {
      return false;
    }

    existingIndices.push(this.lastContentIndex);

    if (existingIndices.length < CONTENT_LOOP_THRESHOLD) {
      return false;
    }

    // Analyze the most recent occurrences to see if they're clustered closely together
    const recentIndices = existingIndices.slice(-CONTENT_LOOP_THRESHOLD);
    const totalDistance =
      recentIndices[recentIndices.length - 1] - recentIndices[0];
    const averageDistance = totalDistance / (CONTENT_LOOP_THRESHOLD - 1);
    const maxAllowedDistance = CONTENT_CHUNK_SIZE * 1.5;

    return averageDistance <= maxAllowedDistance;
  }

  /**
   * Verifies that two chunks with the same hash actually contain identical content.
   * This prevents false positives from hash collisions.
   */
  private isActualContentMatch(
    currentChunk: string,
    originalIndex: number,
  ): boolean {
    const originalChunk = this.streamContentHistory.substring(
      originalIndex,
      originalIndex + CONTENT_CHUNK_SIZE,
    );
    return originalChunk === currentChunk;
  }

  /**
   * Records a structured thought summary for repetition detection. Uses both
   * subject and description so two thoughts with the same subject but
   * diverging descriptions are correctly treated as distinct progress.
   */
  private trackThought(summary: ThoughtSummary): void {
    const subject = summary.subject.trim().toLowerCase();
    const description = summary.description
      .trim()
      .toLowerCase()
      .substring(0, 200);
    const signature = `${subject}|${description}`;
    this.thoughtHistory.push(signature);
    if (this.thoughtHistory.length > MAX_THOUGHT_HISTORY) {
      this.thoughtHistory.shift();
    }
  }

  /**
   * Checks for repetitive thoughts pattern.
   *
   * Only fires when the last `THOUGHT_REPEAT_THRESHOLD` thoughts are the same
   * string. Earlier implementations counted repeats across the full retained
   * history, which caused false positives whenever the model revisited an
   * earlier phrase after making progress on an unrelated step.
   */
  private checkRepetitiveThoughts(): boolean {
    if (this.thoughtHistory.length < THOUGHT_REPEAT_THRESHOLD) {
      return false;
    }

    const recentThoughts = this.thoughtHistory.slice(-THOUGHT_REPEAT_THRESHOLD);
    const firstThought = recentThoughts[0];
    if (recentThoughts.every((thought) => thought === firstThought)) {
      this.lastLoopType = LoopType.REPETITIVE_THOUGHTS;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.REPETITIVE_THOUGHTS, this.promptId),
      );
      return true;
    }
    return false;
  }

  // Exact tool names that read content from the filesystem. A plain substring
  // match on tokens like "view" or "list" is unsafe because unrelated tools
  // (e.g. "review", "checklist_update") can incidentally contain those
  // tokens and get miscounted as file reads.
  private static readonly READ_LIKE_TOOL_NAMES: ReadonlySet<string> = new Set([
    'read_file',
    'read_many_files',
    'list_directory',
    'zoom_image',
  ]);

  // Prefix fallback for MCP-provided tools that follow the same naming
  // convention (e.g. `read_resource`, `list_projects`). The trailing
  // underscore anchors the match to a name segment so "review" and
  // "listener" are not treated as read-like.
  private static readonly READ_LIKE_NAME_PREFIXES: readonly string[] = [
    'read_',
    'list_',
  ];

  private isReadLikeTool(toolName: string): boolean {
    if (LoopDetectionService.READ_LIKE_TOOL_NAMES.has(toolName)) {
      return true;
    }
    return LoopDetectionService.READ_LIKE_NAME_PREFIXES.some((prefix) =>
      toolName.startsWith(prefix),
    );
  }

  /**
   * Tracks tool calls for subsequent loop detection.
   */
  private trackToolCall(toolCall: { name: string; args: object }): void {
    // Add to recent tool calls history
    this.recentToolCalls.push(toolCall);

    // Keep bounded history
    if (this.recentToolCalls.length > FILE_READ_WINDOW) {
      this.recentToolCalls.shift();
    }

    // Flip the cold-start gate once any non-read-like tool has been observed.
    // Opening exploration (list_directory + several read_file calls) should
    // not count as loop evidence on its own.
    if (!this.hasSeenNonReadTool && !this.isReadLikeTool(toolCall.name)) {
      this.hasSeenNonReadTool = true;
    }

    // Track same-name streak for action stagnation. Distinct from
    // checkToolCallLoop which requires identical args; this detector catches
    // "thrashing" where the same tool is called with varying arguments.
    if (this.lastSeenToolName === toolCall.name) {
      this.sameNameStreak++;
    } else {
      this.lastSeenToolName = toolCall.name;
      this.sameNameStreak = 1;
    }
  }

  /**
   * Checks for excessive file read operations without meaningful progress.
   */
  private checkReadFileLoop(): boolean {
    // Cold-start exemption: if no non-read-like tool has ever fired in this
    // prompt, the model is still in its opening exploration phase. Treat a
    // run of reads as legitimate discovery rather than a loop. Once any
    // write/execute/other tool lands, normal detection resumes.
    if (!this.hasSeenNonReadTool) {
      return false;
    }

    if (this.recentToolCalls.length < FILE_READ_THRESHOLD) {
      return false;
    }

    // Count how many of the recent tool calls were file reads
    const fileReadCount = this.recentToolCalls.filter((call) =>
      this.isReadLikeTool(call.name),
    ).length;

    if (fileReadCount >= FILE_READ_THRESHOLD) {
      this.lastLoopType = LoopType.READ_FILE_LOOP;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.READ_FILE_LOOP, this.promptId),
      );
      return true;
    }

    return false;
  }

  /**
   * Checks for action stagnation where the model performs different but equally unproductive actions.
   */
  private checkActionStagnation(): boolean {
    if (this.sameNameStreak >= STAGNATION_THRESHOLD) {
      this.lastLoopType = LoopType.ACTION_STAGNATION;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.ACTION_STAGNATION, this.promptId),
      );
      return true;
    }

    return false;
  }

  /**
   * Recomputes the cap's stateful stuck signal (statefulCapKeyRepeat) from
   * the keys' CURRENT consecutive-identical-result streaks, dropping any
   * latched peak that no longer reflects live evidence.
   */
  private recomputeStatefulCapPeak(): void {
    let peak = 0;
    for (const state of this.statefulRepeatState.values()) {
      if (state.consecutiveIdenticalResults > peak) {
        peak = state.consecutiveIdenticalResults;
      }
    }
    this.statefulCapKeyRepeat = peak;
  }

  /**
   * Round-trip boundary decay for the cap's stateful stuck signal. A key
   * that produced no result for a whole round-trip was abandoned: the model
   * moved on to other work, so its frozen-phase streak must stop feeding the
   * stuck signal. Without this the key map is add-only and the peak latches
   * for the whole prompt — the adaptive cap would then halt a productive
   * turn just past the soft cap on the abandoned key's stale peak (issue
   * #9450). Keys polled in every round-trip appear in the set and keep their
   * streaks, so a continuously frozen board still arms the cap. lastFingerprint
   * survives the decay: when polling resumes, the first fresh result is
   * still judged against the last observed one (changed → productive,
   * unchanged → the count re-accumulates toward the halt).
   */
  private decayAbandonedStatefulStreaks(): void {
    let decayed = false;
    for (const [key, state] of this.statefulRepeatState) {
      if (this.statefulResultKeysSinceLastFinished.has(key)) continue;
      if (
        state.consecutiveIdenticalResults > 0 ||
        state.resultsObserved > 0 ||
        state.unchangedStreak > 0
      ) {
        state.consecutiveIdenticalResults = 0;
        state.resultsObserved = 0;
        state.unchangedStreak = 0;
        decayed = true;
      }
    }
    this.statefulResultKeysSinceLastFinished.clear();
    if (decayed) {
      this.recomputeStatefulCapPeak();
    }
  }

  /**
   * Records a (tool,args) occurrence for the adaptive cap and updates the
   * running max repeat count. Always-on (called from checkAlwaysOnSafeties
   * with the already-hashed key).
   */
  private trackCapKeyRepeat(key: string): void {
    const count = (this.capKeyCounts.get(key) ?? 0) + 1;
    this.capKeyCounts.set(key, count);
    if (count > this.capMaxKeyRepeat) {
      this.capMaxKeyRepeat = count;
    }
  }

  /**
   * Per-turn cap. `getMaxToolCallsPerTurn()` is the configured value (already
   * resolved, Infinity when disabled). Independent of skipLoopDetection.
   *
   * Two behaviors depending on whether the value was explicitly configured:
   * - Explicit value: a hard cap (the released contract) — the turn halts on
   *   the call that exceeds it, with no adaptive extension.
   * - Default (unset): adaptive — once the turn exceeds the soft cap it halts
   *   only on a stuck-repetition signal (some (tool,args) call repeated
   *   GLOBAL_DUPLICATE_THRESHOLD times); a productive turn (diverse calls)
   *   continues up to the hard backstop (soft * ADAPTIVE_CAP_HARD_MULTIPLIER),
   *   which always halts to bound an argument-varying runaway.
   */
  private checkTurnToolCallCap(): boolean {
    this.turnToolCallTotal++;
    if (
      !shouldHaltOnTurnToolCallCap(
        this.turnToolCallTotal,
        // Request-time evidence (deterministic tools) and result-time
        // evidence (stateful reads) feed the same stuck signal; the
        // stateful half disarms when results change (statefulCapKeyRepeat).
        Math.max(this.capMaxKeyRepeat, this.statefulCapKeyRepeat),
        this.config.getMaxToolCallsPerTurn(),
        this.config.isMaxToolCallsPerTurnExplicit(),
      )
    ) {
      return false;
    }
    this.lastLoopType = LoopType.TURN_TOOL_CALL_CAP;
    logLoopDetected(
      this.config,
      new LoopDetectedEvent(LoopType.TURN_TOOL_CALL_CAP, this.promptId),
    );
    return true;
  }

  /**
   * Non-consecutive global duplicate detection: the SAME (tool, args) pair
   * need not appear consecutively — if it appears GLOBAL_DUPLICATE_THRESHOLD
   * times anywhere in the turn, it is treated as a loop. This catches models
   * that intersperse the stuck call among other actions.
   */
  private checkGlobalDuplicate(toolCallKey: string): boolean {
    const count = (this.globalToolCallCounts.get(toolCallKey) ?? 0) + 1;
    this.globalToolCallCounts.set(toolCallKey, count);

    if (count >= GLOBAL_DUPLICATE_THRESHOLD) {
      this.lastLoopType = LoopType.GLOBAL_TOOL_CALL_DUPLICATE;
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(
          LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
          this.promptId,
        ),
      );
      return true;
    }
    return false;
  }

  /**
   * Alternating-pattern detection: catches ABABAB… patterns where the model
   * flips between two distinct tool calls. Tracked via a sliding window of
   * tool-call keys; when the window fills with alternating A/B values the
   * turn is halted — except for stateful read participants whose observed
   * results keep changing (issue #9450), see the carve-out below.
   */
  private checkAlternatingPattern(toolCallKey: string): boolean {
    const maxLen = 2 * ALTERNATING_PATTERN_CYCLES;
    this.recentToolCallKeys.push(toolCallKey);
    if (this.recentToolCallKeys.length > maxLen) {
      this.recentToolCallKeys.shift();
    }

    if (this.recentToolCallKeys.length < maxLen) {
      return false;
    }

    // Extract the two alternating keys. If there are more than two distinct
    // keys in the window, there is no clean ABAB pattern.
    const [a, b] = this.recentToolCallKeys;
    if (a === b) return false; // not alternating, same tool

    for (let i = 0; i < maxLen; i++) {
      const expected = i % 2 === 0 ? a : b;
      if (this.recentToolCallKeys[i] !== expected) {
        return false;
      }
    }

    // Result-aware carve-out for stateful read tools (issue #9450):
    // identical arguments do not imply an identical result, so an ABAB
    // poller is only stuck when its observed results corroborate it. For
    // every stateful participant require the results produced by the
    // window's own prior requests, minus the requests still in flight (fed
    // to this tier but not yet answered — with parallel tool batches BOTH
    // requests of a round reach the guard before that round's results land,
    // so more than just the window-tail request can be in flight); if ANY
    // recorded result changed, the alternation is making observable
    // progress and the window restarts. Missing result evidence (results
    // never recorded) fails safe and keeps the argument-only halt, so a
    // wiring gap never loosens the guard. The per-key in-flight count
    // reduces to the sequential arithmetic (tail request in flight) when
    // each result lands before the next request is fed.
    for (const altKey of [a, b]) {
      if (!this.statefulRepeatKeys.has(altKey)) continue;
      const occurrences = this.recentToolCallKeys.filter(
        (windowKey) => windowKey === altKey,
      ).length;
      const inFlight = Math.min(
        this.statefulInFlight.get(altKey) ?? 0,
        occurrences,
      );
      const expectedResults = occurrences - inFlight;
      if (expectedResults <= 0) continue;
      const history = this.statefulAlternationHistory.get(altKey);
      if (!history || history.length < expectedResults) {
        continue;
      }
      const recent = history.slice(-expectedResults);
      if (recent.some((fp) => fp !== recent[0])) {
        this.recentToolCallKeys = [];
        return false;
      }
    }

    this.lastLoopType = LoopType.ALTERNATING_TOOL_CALL_PATTERN;
    logLoopDetected(
      this.config,
      new LoopDetectedEvent(
        LoopType.ALTERNATING_TOOL_CALL_PATTERN,
        this.promptId,
      ),
    );
    return true;
  }

  /**
   * Resets all loop detection state.
   */
  reset(promptId: string): void {
    this.promptId = promptId;
    this.resetToolCallCount();
    this.resetContentTracking();
    this.loopDetected = false;

    // Reset new tracking variables
    this.thoughtHistory = [];
    this.recentToolCalls = [];
    this.sameNameStreak = 0;
    this.lastSeenToolName = null;
    this.hasSeenNonReadTool = false;
    this.lastLoopType = null;
    this.globalToolCallCounts.clear();
    this.recentToolCallKeys = [];
    this.turnToolCallTotal = 0;
    this.turnToolCallTotalCommitted = 0;
    this.capKeyCounts.clear();
    this.capMaxKeyRepeat = 0;
    this.statefulCapKeyRepeat = 0;
    this.statefulRepeatState.clear();
    this.statefulResultKeysSinceLastFinished.clear();
    this.statefulRepeatKeys.clear();
    this.statefulAlternationHistory.clear();
    this.statefulInFlight.clear();
    this.requestByCallId.clear();
  }

  private resetToolCallCount(): void {
    this.lastToolCallKey = null;
    this.toolCallRepetitionCount = 0;
    this.lastShellInspectionKey = null;
    this.shellInspectionStreak = 0;
  }

  private resetContentTracking(resetHistory = true): void {
    if (resetHistory) {
      this.streamContentHistory = '';
    }
    this.contentStats.clear();
    this.lastContentIndex = 0;
  }
}
