/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ServerLlmStreamEvent } from '../core/turn.js';
import { LlmEventType } from '../core/turn.js';
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
import { getToolCallRepeatKey } from '../tools/tool-call-repeat-key.js';
import {
  FULL_OUTPUT_DIGEST_LABEL,
  PREVIEW_SIZE_CHARS,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
} from '../tools/truncation.js';

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
// Consecutive tool results carrying the same error signature tolerated
// before the always-on error-repetition guard halts the turn (issue
// #10887). Dead-end sessions kept re-running failing operations with varied
// arguments — every (tool, args) pair unique, so no argument-based
// repetition signal ever accumulated — while the same error kept returning
// (e.g. exit 128 / permission denied on every call). The streak is keyed by
// a fingerprint of the error payload and counts across arbitrary calls:
// successful results in between neither advance nor reset it (interleaved
// reads are exactly what let the reported loops slip past the stagnation
// detectors), and a different error signature restarts it. Deliberately low:
// a byte-identical error repeating across calls is never a productive
// signal — a corrected approach that still fails identically is exactly the
// dead end to surface to the user instead of burning tokens on.
const REPEATED_TOOL_ERROR_THRESHOLD = 3;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;
// Cap for the debug-log excerpt of a fired chanting region (~one period,
// see captureChantExcerpt).
const CHANT_EXCERPT_MAX_LENGTH = 80;
// Kept large enough that the long-period rule below can still see
// PERIODIC_OCCURRENCES_REQUIRED occurrences of a long (~700 char) repeated
// unit after truncation. The window also bounds the detectable unit length:
// a retained window holds at most floor((MAX_HISTORY_LENGTH -
// CONTENT_CHUNK_SIZE) / unitLength) + 1 occurrences of any one gram, which
// drops below PERIODIC_OCCURRENCES_REQUIRED for units of ~1 KB — the
// truncated-run path in isPeriodicChunkRepetition admits those once the
// history saturates. Units longer than ~MAX_HISTORY_LENGTH / 2 cannot
// accumulate even three in-window occurrences and remain out of reach.
const MAX_HISTORY_LENGTH = 4000;

// Truncation hysteresis slack. Once the history saturates, the physical
// trim (which walks the whole contentStats map to re-base stored indices)
// runs only when the length exceeds MAX_HISTORY_LENGTH by this margin,
// slicing back to exactly MAX_HISTORY_LENGTH — amortizing the walk over
// ~TRUNCATION_SLACK appended chars instead of paying it on every streamed
// event. Purely a memory/mechanics optimization: the detection logic always
// operates on the logical window of the last MAX_HISTORY_LENGTH chars (see
// windowStart), so detection decisions are identical regardless of how
// rarely the physical trim runs. Peak memory is bounded at
// MAX_HISTORY_LENGTH + TRUNCATION_SLACK chars.
const TRUNCATION_SLACK = 1000;

// Long-period verbatim repetition detection (issue #1775). A unit repeated
// verbatim spaces identical CONTENT_CHUNK_SIZE-grams exactly one unit-length
// apart, which the clustered rule cannot see: its average-distance bound
// (1.5 * CONTENT_CHUNK_SIZE) only admits repeat units up to ~75 chars, so a
// chanted multi-sentence block (~300 chars in the report) spins forever.
// Instead, require a run of occurrences at exactly equal spacing and then
// verify the spanned region is genuinely periodic with that stride.
const PERIODIC_OCCURRENCES_REQUIRED = 5;
// A run whose earlier occurrences may have been truncated away (see
// isPeriodicChunkRepetition) must still span at least this many equally
// spaced occurrences before the whole retained region is verified periodic
// to compensate for the weaker occurrence evidence.
const PERIODIC_MIN_TRUNCATED_OCCURRENCES = 3;
// The verified periodic span must be substantial before halting a turn. The
// verified region grows with the occurrence run (see
// isPeriodicChunkRepetition), so mid-length units (~76-237 chars) cross the
// floor after a handful of extra repetitions and long units cross it almost
// immediately. The floor keeps a small number of short-period repetitions
// (e.g. a phrase emitted a handful of times before a markdown reset) out of
// the long-period path while still firing early for long repeated units
// (~5th repetition for the ~300-char block in the report).
const MIN_PERIODIC_REGION_LENGTH = 1000;

// Tools whose identical arguments do NOT imply an identical result: they
// read shared state that other agents can mutate between calls (issue
// #9450 — a teammate polling `task_list` while peers keep completing tasks
// was halted by the argument-only guards). For these tools the guards below
// become result-aware: repetition only counts as a loop when the observed
// results are unchanged too. Intentionally narrow — deterministic tools keep
// the argument-only behavior, and other team tools (`send_message`,
// `task_update`) have different mutation/delivery semantics and stay out.
const STATEFUL_READ_TOOLS: ReadonlySet<string> = new Set(['task_list']);

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

// Producer shapes of the oversized-result stubs (see tools/truncation.ts).
// Recognition is anchored on these LEADING prefixes: results like task_list
// embed peer-authored text verbatim, and that text can quote stub markers —
// honoring a marker found mid-string would let quoted content collapse or
// vary the fingerprint, so only shapes that START with a producer prefix are
// treated as stubs (issue #9450).
const STUB_PRODUCER_PREFIXES: readonly string[] = [
  '<persisted-output>',
  'Output too large (',
  TOOL_OUTPUT_TRUNCATED_PREFIX,
];

const STUB_PREVIEW_MARKER = `Preview (up to ${PREVIEW_SIZE_CHARS} chars):`;
const STUB_TRUNCATED_PART_MARKER = 'Truncated part of the output:\n';

/**
 * Reads the sha256 digest a stub producer embedded for the FULL
 * pre-truncation output: the label must START its line and be followed by
 * exactly 64 hex chars ending the line. A mid-line mention of the label
 * (quoted content) never matches (issue #9450).
 */
function extractAnchoredStubDigest(value: string): string | null {
  let searchFrom = 0;
  for (;;) {
    const index = value.indexOf(FULL_OUTPUT_DIGEST_LABEL, searchFrom);
    if (index === -1) return null;
    if (index === 0 || value[index - 1] === '\n') {
      const digestStart = index + FULL_OUTPUT_DIGEST_LABEL.length;
      const digest = value.slice(digestStart, digestStart + 64);
      const terminator = value[digestStart + 64];
      if (
        /^[0-9a-f]{64}$/.test(digest) &&
        (terminator === undefined || terminator === '\n' || terminator === '\r')
      ) {
        return digest;
      }
    }
    searchFrom = index + FULL_OUTPUT_DIGEST_LABEL.length;
  }
}

/**
 * Reduces an oversized-result stub to a stable fingerprint payload.
 * Oversized tool results are rewritten into truncation stubs whose envelope
 * embeds a per-call unique artifact path (`<toolResultsDir>/<callId>.txt`,
 * a random temp file); hashing the envelope verbatim would fingerprint
 * uniquely every poll — silently disabling every result-aware guard for
 * exactly the largest results (a frozen board would read as "changed every
 * time", issue #9450).
 *
 * Prefer the producers' sha256 of the full pre-truncation output
 * (FULL_OUTPUT_DIGEST_LABEL): stable across calls for identical content and
 * sensitive to mutations anywhere, including beyond the preview window.
 * Stubs without a digest line fall back to their path-free visible payload
 * (preview, or head+tail after the truncation marker). Non-stub text passes
 * through unchanged.
 */
function stripPersistenceEnvelope(value: string): string {
  if (!STUB_PRODUCER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return value;
  }
  const digest = extractAnchoredStubDigest(value);
  if (digest !== null) {
    return `<persisted-stub>sha256:${digest}`;
  }
  for (const marker of [STUB_PREVIEW_MARKER, STUB_TRUNCATED_PART_MARKER]) {
    const payloadStart = value.indexOf(marker);
    if (payloadStart !== -1) {
      const payload = value.slice(payloadStart + marker.length);
      const closeTag = payload.indexOf('</persisted-output>');
      return `<persisted-stub>payload:${closeTag === -1 ? payload : payload.slice(0, closeTag)}`;
    }
  }
  return `<persisted-stub>raw:${value}`;
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
  // Stateful read tools feed their consecutive identical-result count instead
  // (recordToolResult), so changed-state polling never builds the signal.
  private capKeyCounts = new Map<string, number>();
  private capMaxKeyRepeat = 0;

  // Result-aware tracking for stateful read tools (see STATEFUL_READ_TOOLS).
  // Keyed by the (tool, args) repeat key. `resultsObserved` /
  // `unchangedStreak` count results within the CURRENT consecutive-identical
  // streak (restarted when the streak breaks); `lastFingerprint` survives
  // streak breaks so a state change is still visible across interleaved
  // calls (used by the action-stagnation reset).
  private statefulRepeatState = new Map<
    string,
    {
      resultsObserved: number;
      unchangedStreak: number;
      lastFingerprint: string | undefined;
    }
  >();

  // Consecutive identical-result counts per repeat key for stateful read
  // tools, recorded post-execution. Replaces the request-time
  // global-duplicate counting and the cap's stuck-repetition counting for
  // these tools: the same call returning changed state is productive and
  // must not accumulate toward either halt. The count restarts at 1
  // whenever the result differs from the key's predecessor, so a board
  // oscillating between two byte-identical states is changed-state progress
  // on every poll and never accumulates — even though the same
  // (call, result) pair recurs across the turn — while a frozen board keeps
  // accumulating even when other calls are interleaved.
  private statefulConsecutiveResults = new Map<
    string,
    { fingerprint: string; count: number }
  >();

  // Consecutive identical tool-error signatures (issue #10887): fingerprint
  // of the most recent error payload and how many consecutive error results
  // carried it. Successful results neither advance nor reset the streak (an
  // interleaved read must not mask a dead end); a different error signature
  // restarts it at one.
  private toolErrorStreakSignature: string | null = null;
  private toolErrorStreakCount = 0;

  // callId → request pairing so results can be matched to their calls when
  // the runtime only has the response (populated on ToolCallRequest events,
  // consumed by recordToolResultByCallId).
  private requestByCallId = new Map<string, { name: string; args: object }>();

  // Loop type of the most recent firing. Bubbled up through the
  // LoopDetected event so callers (non-interactive CLI, telemetry) can tell
  // the user which detector actually fired.
  private lastLoopType: LoopType | null = null;

  // Short excerpt of the repeated region captured when the chanting
  // detector fires, for debug logging only. Deliberately NOT part of the
  // LoopDetected event payload: the event contract stays loop_type-only and
  // the excerpt rides the debug log instead, so a headless reasoning-channel
  // halt (empty stdout, label-only stderr) leaves an artifact that tells a
  // true repetition from a misfire.
  private lastChantExcerpt = '';

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
    // Repeated tool-error detection (issue #10887): applies to every tool,
    // ahead of the stateful-read carve-out — the dead-end signal is the
    // repeated error payload, not which call produced it.
    if (this.checkRepeatedToolError(responseParts)) {
      return true;
    }
    if (!this.isStatefulReadTool(toolCall.name)) return false;

    const resultText = LoopDetectionService.extractResultText(responseParts);
    if (resultText === null) return false;
    const fingerprint = createHash('sha256').update(resultText).digest('hex');
    const key = this.getToolCallKey(toolCall);

    // Consecutive-streak evidence for the always-on guard. The state entry
    // can predate the streak (lastFingerprint survives streak breaks), so
    // create it lazily but only count results while a streak exists.
    let state = this.statefulRepeatState.get(key);
    if (!state) {
      state = {
        resultsObserved: 0,
        unchangedStreak: 0,
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

    // Consecutive identical-result counting: replaces the request-time
    // global-duplicate and cap stuck-repetition counting for stateful
    // tools. The count restarts at 1 whenever the result differs from the
    // key's predecessor, so an oscillating board (changed state on every
    // poll) never accumulates toward either halt while a frozen board —
    // same result on every poll, even interleaved with other calls — does.
    const prior = this.statefulConsecutiveResults.get(key);
    const consecutiveCount =
      prior && prior.fingerprint === fingerprint ? prior.count + 1 : 1;
    this.statefulConsecutiveResults.set(key, {
      fingerprint,
      count: consecutiveCount,
    });
    if (consecutiveCount > this.capMaxKeyRepeat) {
      this.capMaxKeyRepeat = consecutiveCount;
    }

    // The global-duplicate detector is gated (skipLoopDetection) exactly as
    // its request-time counterpart in addAndCheckHeuristicLoops.
    if (
      !this.config.getSkipLoopDetection() &&
      consecutiveCount >= GLOBAL_DUPLICATE_THRESHOLD
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
   * that never streamed through this service) skip the request-dependent
   * guards but still feed the error-repetition guard, which works from the
   * result alone (issue #10887).
   */
  recordToolResultByCallId(
    callId: string,
    responseParts: readonly Part[],
  ): boolean {
    const request = this.requestByCallId.get(callId);
    if (!request) {
      if (this.loopDetected) return true;
      if (this.disabledForSession) return false;
      return this.checkRepeatedToolError(responseParts);
    }
    this.requestByCallId.delete(callId);
    return this.recordToolResult(
      { name: request.name, args: request.args },
      responseParts,
    );
  }

  private isStatefulReadTool(toolName: string): boolean {
    return STATEFUL_READ_TOOLS.has(toolName);
  }

  /**
   * Reconstructs the model-visible result text from tool response parts.
   * Only the fingerprint of this text is retained, never the text itself.
   * Oversized results arrive as persistence stubs whose envelope embeds a
   * per-call unique file path; each string value is reduced to its stable
   * payload first (see stripPersistenceEnvelope) so identical underlying
   * results fingerprint identically no matter where they were persisted.
   * Returns null when the parts carry no functionResponse content.
   */
  private static extractResultText(
    responseParts: readonly Part[],
  ): string | null {
    const chunks: string[] = [];
    for (const part of responseParts) {
      const functionResponse = part.functionResponse;
      if (!functionResponse) continue;
      chunks.push(
        JSON.stringify(functionResponse.response ?? {}, (_key, value) =>
          typeof value === 'string' ? stripPersistenceEnvelope(value) : value,
        ),
      );
    }
    return chunks.length > 0 ? chunks.join('\n') : null;
  }

  /**
   * Extracts the error payload of a failed tool result, or null when the
   * parts carry none. Failed calls surface their failure as a
   * `functionResponse.response.error` string across every runtime (scheduler
   * error responses, cancellations, timeouts). Oversized error messages
   * arrive as persistence stubs whose envelope embeds a per-call unique
   * path, so each value is reduced to its stable payload first
   * (stripPersistenceEnvelope) — identical underlying errors fingerprint
   * identically no matter where they were persisted.
   */
  private static extractToolErrorText(
    responseParts: readonly Part[],
  ): string | null {
    const errors: string[] = [];
    for (const part of responseParts) {
      const response = part.functionResponse?.response;
      if (!response) continue;
      const error = response['error'];
      if (typeof error === 'string' && error.trim().length > 0) {
        errors.push(stripPersistenceEnvelope(error));
      }
    }
    return errors.length > 0 ? errors.join('\n') : null;
  }

  /**
   * Repeated tool-error detection (issue #10887): halts the turn when the
   * same error signature returns on REPEATED_TOOL_ERROR_THRESHOLD consecutive
   * error results. Result-aware and tool-agnostic: dead-end loops vary their
   * (tool, args) on every retry, so argument-based repetition never
   * accumulates — the repeated error payload is the evidence. Always-on like
   * the consecutive-identical-call guard (a byte-identical error repeating
   * across calls is never productive, and the gated heuristics ship disabled
   * by default in the CLI).
   *
   * @returns true when the streak trips the threshold (loopDetected is set);
   * callers halt the turn exactly as for an event-detected loop.
   */
  private checkRepeatedToolError(responseParts: readonly Part[]): boolean {
    const errorText = LoopDetectionService.extractToolErrorText(responseParts);
    if (errorText === null) {
      // A successful result is neither evidence of the dead end nor a reset:
      // interleaved reads between failing calls must not mask the streak.
      return false;
    }
    const signature = createHash('sha256').update(errorText).digest('hex');
    if (this.toolErrorStreakSignature === signature) {
      this.toolErrorStreakCount++;
    } else {
      this.toolErrorStreakSignature = signature;
      this.toolErrorStreakCount = 1;
    }
    if (this.toolErrorStreakCount < REPEATED_TOOL_ERROR_THRESHOLD) {
      return false;
    }
    this.lastLoopType = LoopType.REPEATED_TOOL_ERROR;
    logLoopDetected(
      this.config,
      new LoopDetectedEvent(LoopType.REPEATED_TOOL_ERROR, this.promptId),
    );
    this.loopDetected = true;
    return true;
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
  addAndCheck(event: ServerLlmStreamEvent): boolean {
    if (this.checkAlwaysOnSafeties(event)) {
      return true;
    }

    return this.addAndCheckHeuristicLoops(event);
  }

  addAndCheckHeuristicLoops(event: ServerLlmStreamEvent): boolean {
    if (this.loopDetected || this.disabledForSession) {
      return this.loopDetected;
    }

    switch (event.type) {
      case LlmEventType.ToolCallRequest: {
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
        // recordToolResult, on consecutive identical results instead of
        // args alone (issue #9450).
        const globalDup = this.isStatefulReadTool(event.value.name)
          ? false
          : this.checkGlobalDuplicate(toolCallKey);
        const alternating = this.checkAlternatingPattern(toolCallKey);
        const readFileLoop = this.checkReadFileLoop();
        const actionStagnation = this.checkActionStagnation();

        this.loopDetected =
          globalDup || alternating || readFileLoop || actionStagnation;
        break;
      }
      case LlmEventType.Retry: {
        // A retry replays the failed attempt's tool calls (Turn clears
        // pendingToolCalls on retry), so drop the heuristic duplicate counters
        // to avoid firing on a duplicated replay — e.g. 3 identical calls +
        // Retry + 3 more would otherwise hit the global-duplicate threshold of
        // 6. The always-on guards reset their own counters in
        // checkAlwaysOnSafeties' Retry branch (cap rollback + always-on
        // streak reset).
        this.globalToolCallCounts.clear();
        this.recentToolCallKeys = [];
        // A replay (non-continuation) retry also re-streams the failed
        // attempt's content and reasoning through the chunk detectors: the
        // transport-replay gate admits thought-only cuts (#7832), and with
        // deterministic decoding the re-stream is verbatim, so the
        // accumulated identical copies would fire
        // CHANTING_IDENTICAL_SENTENCES mid-way through an otherwise healthy
        // attempt. Reset the stream state the replay duplicates. A
        // continuation retry (isContinuation) keeps the delivered text and
        // appends genuinely new output — nothing is re-streamed, so its
        // state must stay. A genuine chant simply re-accumulates after the
        // restart.
        if (!event.isContinuation) {
          this.resetContentTracking();
          this.thoughtHistory = [];
        }
        break;
      }
      case LlmEventType.ModelFallback: {
        // The fallback model restarts the attempt from scratch: Turn clears
        // pending tool calls and stream consumers discard the failed model's
        // buffer, so the failed model's streamed content/thought text and
        // tool-call keys would otherwise mix with the new model's stream and
        // manufacture repetition runs across the boundary. Mirror the
        // replay-retry resets.
        this.globalToolCallCounts.clear();
        this.recentToolCallKeys = [];
        this.resetContentTracking();
        this.thoughtHistory = [];
        break;
      }
      case LlmEventType.Content: {
        this.loopDetected = this.checkContentLoop(event.value);
        break;
      }
      case LlmEventType.Thought: {
        this.trackThought(event.value);
        this.loopDetected = this.checkRepetitiveThoughts();
        if (!this.loopDetected) {
          // Also route the thought text into the content-repetition
          // detector. OpenAI-compatible providers stream reasoning as
          // thought parts, which getResponseText filters out of Content
          // events, so a verbatim chant in the thinking stage never reaches
          // the chunk-hash detectors otherwise. The Thought-only check above
          // compares whole stream deltas adjacently, which misaligned
          // chunking defeats — the chunk-hash detectors accumulate the text
          // across deltas and catch the repetition regardless of chunk
          // boundaries (issues #9656, #1775). Reasoning text enters through
          // checkReasoningContentLoop so it can never drive the
          // markdown/code-block machinery that guards the visible channel.
          const thoughtText = this.getThoughtText(event.value);
          if (thoughtText) {
            this.loopDetected = this.checkReasoningContentLoop(thoughtText);
          }
        }
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
  checkAlwaysOnSafeties(event: ServerLlmStreamEvent): boolean {
    if (this.loopDetected) {
      return true;
    }

    // A model response (round-trip) finished cleanly: commit its tool-call
    // count as the rollback floor. The per-turn total accumulates across
    // ToolResult continuations, so the floor must track the last committed
    // round-trip rather than resetting to zero.
    if (event.type === LlmEventType.Finished) {
      this.turnToolCallTotalCommitted = this.turnToolCallTotal;
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
    if (event.type === LlmEventType.Retry) {
      this.turnToolCallTotal = this.turnToolCallTotalCommitted;
      this.resetToolCallCount();
      this.capKeyCounts.clear();
      this.capMaxKeyRepeat = 0;
      // A retry replays the failed attempt's tool calls; drop the stateful
      // result evidence too so the replayed attempt is judged on its own
      // results (consecutive counts re-accumulate as results land, consistent
      // with the capKeyCounts/globalToolCallCounts clears).
      this.statefulConsecutiveResults.clear();
      for (const state of this.statefulRepeatState.values()) {
        state.resultsObserved = 0;
        state.unchangedStreak = 0;
      }
      return false;
    }

    if (event.type !== LlmEventType.ToolCallRequest) {
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

    return this.appendToContentHistoryAndAnalyze(content);
  }

  /**
   * Entry point for reasoning-stream deltas into the content-repetition
   * detector. Reasoning text is raw chain-of-thought, never rendered
   * markdown, so it must skip checkContentLoop's structure heuristics: an
   * odd number of code fences in a thought would flip the shared
   * `inCodeBlock` parity — which nothing clears mid-turn — and silently
   * disable visible-content detection for the rest of the turn, and a
   * list-item or heading-shaped thought delta would reset the shared
   * history, erasing already-accumulated content evidence whenever a
   * provider interleaves thought and content parts. Reasoning deltas are
   * appended to the shared history and analyzed only.
   */
  private checkReasoningContentLoop(content: string): boolean {
    return this.appendToContentHistoryAndAnalyze(content);
  }

  /**
   * Shared append/truncate/analyze tail behind checkContentLoop and
   * checkReasoningContentLoop, so the history contract lives in one copy:
   * a future change to the sequence (normalising before append, an extra
   * reset, different truncation handling) applies to both channels instead
   * of silently leaving the reasoning path on the old behaviour.
   */
  private appendToContentHistoryAndAnalyze(content: string): boolean {
    this.streamContentHistory += content;

    this.truncateAndUpdate();
    return this.analyzeContentChunksForLoop();
  }

  /**
   * Start of the logical detection window inside streamContentHistory: the
   * detection rules may only see the last MAX_HISTORY_LENGTH chars, even
   * while the physical trim's hysteresis (see truncateAndUpdate) lets the
   * buffer temporarily hold up to MAX_HISTORY_LENGTH + TRUNCATION_SLACK.
   * Everything before this offset is treated as already truncated away.
   */
  private windowStart(): number {
    return Math.max(0, this.streamContentHistory.length - MAX_HISTORY_LENGTH);
  }

  /**
   * Truncates the content history to prevent unbounded memory growth.
   * When truncating, adjusts all stored indices to maintain their relative positions.
   *
   * Runs with hysteresis: once saturated, trims only when the length
   * exceeds the window by TRUNCATION_SLACK, then slices back to exactly
   * MAX_HISTORY_LENGTH. The index-rebase walk below is Θ(map size), and at
   * saturation the stride-1 sliding window keeps one entry per position, so
   * running it per streamed event cost Θ(window) synchronous CPU on the
   * token-streaming path; the slack amortizes it over appended chars.
   * Detection semantics are unaffected: the rules only ever see the logical
   * window (windowStart), which is identical with or without the slack.
   */
  private truncateAndUpdate(): void {
    if (
      this.streamContentHistory.length <=
      MAX_HISTORY_LENGTH + TRUNCATION_SLACK
    ) {
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
        // The LoopDetected event carries only loop_type + prompt_id, and a
        // reasoning-channel halt prints nothing to stdout — without an
        // artifact there is no way to tell a true repetition from a
        // detector misfire. Log one period of the matched region instead of
        // widening the event contract.
        if (this.lastChantExcerpt) {
          this.config
            .getDebugLogger()
            .debug(
              `Loop detection halted on ${LoopType.CHANTING_IDENTICAL_SENTENCES}; ` +
                `repeated region excerpt (${this.lastChantExcerpt.length} chars): ` +
                JSON.stringify(this.lastChantExcerpt),
            );
        }
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
    let existingIndices = this.contentStats.get(hash);

    if (existingIndices) {
      // The physical truncation runs with hysteresis, so occurrences the
      // logical window has already passed can linger in the map between
      // trims. Drop them here — exactly the set a per-event truncation
      // would have removed — so detection decisions never depend on how
      // rarely the physical trim runs.
      const start = this.windowStart();
      if (existingIndices[0] < start) {
        let firstKept = 1;
        while (
          firstKept < existingIndices.length &&
          existingIndices[firstKept] < start
        ) {
          firstKept++;
        }
        existingIndices = existingIndices.slice(firstKept);
        this.contentStats.set(hash, existingIndices);
      }
    }

    if (!existingIndices || existingIndices.length === 0) {
      this.contentStats.set(hash, [this.lastContentIndex]);
      return false;
    }

    if (!this.isActualContentMatch(chunk, existingIndices[0])) {
      return false;
    }

    existingIndices.push(this.lastContentIndex);

    if (
      this.isClusteredChunkRepetition(existingIndices) ||
      this.isPeriodicChunkRepetition(existingIndices)
    ) {
      this.lastChantExcerpt = this.captureChantExcerpt(existingIndices);
      return true;
    }
    return false;
  }

  /**
   * One period of the matched repetition for debug logging: the span
   * between the last two occurrences (exactly one stride for a verified
   * periodic run), capped so the log line stays short.
   */
  private captureChantExcerpt(occurrences: number[]): string {
    const start = occurrences[occurrences.length - 2];
    const stride = occurrences[occurrences.length - 1] - start;
    if (stride <= 0) {
      return '';
    }
    return this.streamContentHistory.slice(
      start,
      start + Math.min(stride, CHANT_EXCERPT_MAX_LENGTH),
    );
  }

  /**
   * The original chunk rule: the most recent CONTENT_LOOP_THRESHOLD
   * occurrences of an identical chunk cluster within 1.5 chunk lengths.
   * Only admits repeat units up to ~75 chars (see isPeriodicChunkRepetition
   * for longer ones).
   */
  private isClusteredChunkRepetition(indices: number[]): boolean {
    if (indices.length < CONTENT_LOOP_THRESHOLD) {
      return false;
    }

    // Analyze the most recent occurrences to see if they're clustered closely together
    const recentIndices = indices.slice(-CONTENT_LOOP_THRESHOLD);
    const totalDistance =
      recentIndices[recentIndices.length - 1] - recentIndices[0];
    const averageDistance = totalDistance / (CONTENT_LOOP_THRESHOLD - 1);
    const maxAllowedDistance = CONTENT_CHUNK_SIZE * 1.5;

    return averageDistance <= maxAllowedDistance;
  }

  /**
   * Detects verbatim repetition of a long unit (issue #1775): a chant whose
   * repeated block exceeds the clustered rule's 75-char window, such as the
   * ~300-char analysis block looped in the report. A unit repeated verbatim
   * re-emits each of its CONTENT_CHUNK_SIZE-grams at exactly one unit-length
   * of spacing, so a run of equally-spaced occurrences marks a candidate
   * period. Equal spacing alone could still interleave varying text between
   * occurrences, so the spanned region is additionally verified to be
   * exactly periodic with that stride before firing.
   *
   * The candidate run is the longest equally-spaced suffix of the recorded
   * occurrences, not just the last PERIODIC_OCCURRENCES_REQUIRED: the
   * verified region grows with the repetition count, which admits units
   * between the clustered rule's ~75-char bound and the span a fixed
   * 5-occurrence window can verify (e.g. a 150-char unit crosses
   * MIN_PERIODIC_REGION_LENGTH at its 8th occurrence).
   *
   * Once the history saturates, earlier occurrences can be truncated away,
   * so a shorter run (>= PERIODIC_MIN_TRUNCATED_OCCURRENCES) is accepted
   * when the whole retained region — back to the start of the logical
   * window (windowStart), i.e. exactly the content a fully-trimmed history
   * retains — is verified periodic with the candidate stride. Without that
   * escape valve, units of ~1 KB or more could never accumulate
   * PERIODIC_OCCURRENCES_REQUIRED occurrences inside the window and a
   * full-paragraph chant would spin the turn forever.
   */
  private isPeriodicChunkRepetition(indices: number[]): boolean {
    if (indices.length < PERIODIC_MIN_TRUNCATED_OCCURRENCES) {
      return false;
    }

    const last = indices.length - 1;
    const stride = indices[last] - indices[last - 1];

    // Extend the run backwards over the longest equally-spaced suffix so
    // the verified region grows with the repetition count.
    let first = last;
    while (first > 0 && indices[first] - indices[first - 1] === stride) {
      first--;
    }
    const runLength = last - first + 1;

    if (runLength >= PERIODIC_OCCURRENCES_REQUIRED) {
      return this.isRegionPeriodicWithStride(
        indices[first],
        indices[last] + CONTENT_CHUNK_SIZE,
        stride,
      );
    }

    // The run may have been truncated by the history window. Accept it only
    // when the history actually saturated and the entire retained region is
    // periodic with the candidate stride, so a short run of occurrences in
    // fresh (untruncated) history still needs the full occurrence count.
    if (
      runLength >= PERIODIC_MIN_TRUNCATED_OCCURRENCES &&
      this.streamContentHistory.length >= MAX_HISTORY_LENGTH
    ) {
      return this.isRegionPeriodicWithStride(
        this.windowStart(),
        indices[last] + CONTENT_CHUNK_SIZE,
        stride,
      );
    }

    return false;
  }

  /**
   * Verifies that streamContentHistory[start, end) is exactly periodic with
   * the given stride and spans at least MIN_PERIODIC_REGION_LENGTH chars.
   */
  private isRegionPeriodicWithStride(
    start: number,
    end: number,
    stride: number,
  ): boolean {
    const regionLength = end - start;
    if (regionLength < MIN_PERIODIC_REGION_LENGTH) {
      return false;
    }
    // Compare in place instead of slicing the region out: near-periodic
    // chants (the target input class) fail verification repeatedly while
    // their equally-spaced occurrence runs persist, so once a run reaches
    // length 5 this check can fire on up to every streamed character, and
    // a slice would copy up to ~4 KB of history per call.
    for (let i = 0; i + stride < regionLength; i++) {
      if (
        this.streamContentHistory[start + i] !==
        this.streamContentHistory[start + i + stride]
      ) {
        return false;
      }
    }
    return true;
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
   * Joins a thought summary back into raw text for the content-repetition
   * detector. For reasoning streamed from OpenAI-compatible providers the
   * subject is empty and the description is the reasoning delta, so this
   * yields the reasoning text verbatim.
   */
  private getThoughtText(summary: ThoughtSummary): string {
    return [summary.subject, summary.description]
      .filter((part) => part.length > 0)
      .join(' ');
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
        this.capMaxKeyRepeat,
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
   * turn is halted.
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
    this.lastChantExcerpt = '';

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
    this.statefulRepeatState.clear();
    this.statefulConsecutiveResults.clear();
    this.toolErrorStreakSignature = null;
    this.toolErrorStreakCount = 0;
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
