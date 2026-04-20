/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
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

const TOOL_CALL_LOOP_THRESHOLD = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;
const MAX_HISTORY_LENGTH = 1000;

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

  // Cold-start gate for READ_FILE_LOOP: the opening exploration of a prompt
  // is almost always read-heavy (list + parallel reads). Until at least one
  // non-read-like tool fires, a window full of reads is treated as legitimate
  // exploration rather than loop evidence. Resets per-prompt in reset().
  private hasSeenNonReadTool = false;

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

  private getToolCallKey(toolCall: { name: string; args: object }): string {
    const argsString = JSON.stringify(toolCall.args);
    const keyString = `${toolCall.name}:${argsString}`;
    return createHash('sha256').update(keyString).digest('hex');
  }

  /**
   * Processes a stream event and checks for loop conditions.
   * @param event - The stream event to process
   * @returns true if a loop is detected, false otherwise
   */
  addAndCheck(event: ServerGeminiStreamEvent): boolean {
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

        const toolCallLoop = this.checkToolCallLoop(event.value);
        this.trackToolCall(event.value);
        const readFileLoop = this.checkReadFileLoop();
        const actionStagnation = this.checkActionStagnation();

        this.loopDetected = toolCallLoop || readFileLoop || actionStagnation;
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

  private checkToolCallLoop(toolCall: { name: string; args: object }): boolean {
    const key = this.getToolCallKey(toolCall);
    if (this.lastToolCallKey === key) {
      this.toolCallRepetitionCount++;
    } else {
      this.lastToolCallKey = key;
      this.toolCallRepetitionCount = 1;
    }
    if (this.toolCallRepetitionCount >= TOOL_CALL_LOOP_THRESHOLD) {
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
    const hasListItem =
      /(^|\n)\s*[*-+]\s/.test(content) || /(^|\n)\s*\d+\.\s/.test(content);
    const hasHeading = /(^|\n)#+\s/.test(content);
    const hasBlockquote = /(^|\n)>\s/.test(content);
    const isDivider = /^[+-_=*\u2500-\u257F]+$/.test(content);

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
  }

  private resetToolCallCount(): void {
    this.lastToolCallKey = null;
    this.toolCallRepetitionCount = 0;
  }

  private resetContentTracking(resetHistory = true): void {
    if (resetHistory) {
      this.streamContentHistory = '';
    }
    this.contentStats.clear();
    this.lastContentIndex = 0;
  }
}
