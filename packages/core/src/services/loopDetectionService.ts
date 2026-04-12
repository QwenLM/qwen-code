/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ServerGeminiStreamEvent } from '../core/turn.js';
import { GeminiEventType } from '../core/turn.js';
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

// Thought loop detection: detect when the same thought subject repeats
const THOUGHT_LOOP_THRESHOLD = 3;
const THOUGHT_SIMILARITY_THRESHOLD = 0.85; // 85% similarity

// Action stagnation detection: detect when agent reads files without taking action
const READ_FILE_LOOP_THRESHOLD = 4;
const TURNS_WITHOUT_ACTION_THRESHOLD = 20; // Increased threshold to avoid false positives

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

  // Thought loop tracking
  private recentThoughts: Array<{ subject: string; description: string }> = [];

  // Action stagnation tracking
  private consecutiveReadsWithoutAction = 0;
  private turnsWithoutMeaningfulAction = 0;
  private totalTurns = 0;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Calculates similarity between two strings using Levenshtein distance ratio.
   * Returns a value between 0 and 1, where 1 means identical.
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    // Use a simple character-level similarity for performance
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    const longerLen = longer.length;

    if (longerLen === 0) return 1;

    // Count matching characters in order
    let matchCount = 0;
    const shortArray = shorter.split('');
    const longArray = longer.split('');

    for (const char of shortArray) {
      const idx = longArray.indexOf(char);
      if (idx !== -1) {
        matchCount++;
        longArray.splice(idx, 1);
      }
    }

    return matchCount / longerLen;
  }

  /**
   * Checks if a thought is similar to recent thoughts, indicating a loop.
   */
  private checkThoughtLoop(thought: {
    subject: string;
    description: string;
  }): boolean {
    this.recentThoughts.push(thought);

    // Keep only recent thoughts (last 10)
    if (this.recentThoughts.length > 10) {
      this.recentThoughts.shift();
    }

    if (this.recentThoughts.length < THOUGHT_LOOP_THRESHOLD) {
      return false;
    }

    // Check if the current thought is similar to recent ones
    const recentSimilarThoughts = this.recentThoughts.slice(
      -THOUGHT_LOOP_THRESHOLD,
    );

    let similarCount = 0;
    for (let i = 0; i < recentSimilarThoughts.length - 1; i++) {
      const prevThought = recentSimilarThoughts[i];
      const currentThought =
        recentSimilarThoughts[recentSimilarThoughts.length - 1];

      // Compare subjects first (higher weight)
      const subjectSimilarity = this.calculateSimilarity(
        prevThought.subject,
        currentThought.subject,
      );

      // Compare descriptions if subjects aren't similar enough
      const descriptionSimilarity = this.calculateSimilarity(
        prevThought.description,
        currentThought.description,
      );

      // Weighted average: subject is more important
      const similarity = subjectSimilarity * 0.7 + descriptionSimilarity * 0.3;

      if (similarity >= THOUGHT_SIMILARITY_THRESHOLD) {
        similarCount++;
      }
    }

    if (similarCount >= THOUGHT_LOOP_THRESHOLD - 1) {
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.REPETITIVE_THOUGHTS, this.promptId),
      );
      return true;
    }

    return false;
  }

  /**
   * Checks if the agent is stuck in a read-file loop without taking action.
   * Detects when the agent repeatedly reads files without making progress.
   */
  private checkReadFileLoop(toolCall: { name: string; args: object }): boolean {
    const isReadOperation =
      toolCall.name === 'ReadFile' ||
      toolCall.name === 'Glob' ||
      toolCall.name === 'Grep';

    const isActionOperation =
      toolCall.name === 'Edit' ||
      toolCall.name === 'WriteFile' ||
      toolCall.name === 'Shell' ||
      toolCall.name === 'WebFetch' ||
      toolCall.name === 'Tool';

    if (isReadOperation) {
      this.consecutiveReadsWithoutAction++;

      if (this.consecutiveReadsWithoutAction >= READ_FILE_LOOP_THRESHOLD) {
        logLoopDetected(
          this.config,
          new LoopDetectedEvent(LoopType.READ_FILE_LOOP, this.promptId),
        );
        return true;
      }
    } else if (isActionOperation) {
      // Reset counter on meaningful action
      this.trackMeaningfulAction();
    }

    return false;
  }

  /**
   * Checks if the agent is stuck without making meaningful progress.
   * Detects when too many turns pass without action operations.
   */
  private checkActionStagnation(): boolean {
    this.turnsWithoutMeaningfulAction++;

    if (
      this.turnsWithoutMeaningfulAction >= TURNS_WITHOUT_ACTION_THRESHOLD &&
      this.consecutiveReadsWithoutAction === 0
    ) {
      logLoopDetected(
        this.config,
        new LoopDetectedEvent(LoopType.ACTION_STAGNATION, this.promptId),
      );
      return true;
    }

    return false;
  }

  /**
   * Tracks meaningful action operations that reset the stagnation counter.
   */
  private trackMeaningfulAction(): void {
    this.turnsWithoutMeaningfulAction = 0;
    this.consecutiveReadsWithoutAction = 0;
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
      case GeminiEventType.ToolCallRequest:
        // Content chanting only happens in one single stream, reset if there
        // is a tool call in between
        this.resetContentTracking();
        this.loopDetected = this.checkToolCallLoop(event.value);
        if (!this.loopDetected) {
          this.loopDetected = this.checkReadFileLoop(event.value);
        }
        // Reset stagnation counter on any tool call - agent is actively doing something
        this.turnsWithoutMeaningfulAction = 0;
        this.totalTurns++;
        break;
      case GeminiEventType.Content:
        this.loopDetected = this.checkContentLoop(event.value);
        if (!this.loopDetected) {
          this.loopDetected = this.checkActionStagnation();
        }
        break;
      case GeminiEventType.Thought:
        this.loopDetected = this.checkThoughtLoop(event.value);
        break;
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
   * Resets all loop detection state.
   */
  reset(promptId: string): void {
    this.promptId = promptId;
    this.resetToolCallCount();
    this.resetContentTracking();
    this.loopDetected = false;
    this.recentThoughts = [];
    this.consecutiveReadsWithoutAction = 0;
    this.turnsWithoutMeaningfulAction = 0;
    this.totalTurns = 0;
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
