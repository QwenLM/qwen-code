/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { safeJsonParse } from '../../utils/safeJsonParse.js';

/**
 * Type definition for the result of parsing a JSON chunk in tool calls
 */
export interface ToolCallParseResult {
  /** Whether the JSON parsing is complete */
  complete: boolean;
  /** The parsed JSON value (only present when complete is true) */
  value?: Record<string, unknown>;
  /** Error information if parsing failed */
  error?: Error;
  /** Whether the JSON was repaired (e.g., auto-closed unclosed strings) */
  repaired?: boolean;
}

/**
 * StreamingToolCallParser - Handles streaming tool call objects with inconsistent chunk formats
 *
 * Problems this parser addresses:
 * - Tool calls arrive with varying chunk shapes (empty strings, partial JSON, complete objects)
 * - Tool calls may lack IDs, names, or have inconsistent indices
 * - Multiple tool calls can be processed simultaneously with interleaved chunks
 * - Index collisions occur when the same index is reused for different tool calls
 * - JSON arguments are fragmented across multiple chunks and need reconstruction
 */
export class StreamingToolCallParser {
  /** Accumulated buffer containing all received chunks for each tool call index */
  private buffers: Map<number, string> = new Map();
  /** Current nesting depth in JSON structure for each tool call index */
  private depths: Map<number, number> = new Map();
  /** Whether we're currently inside a string literal for each tool call index */
  private inStrings: Map<number, boolean> = new Map();
  /** Whether the next character should be treated as escaped for each tool call index */
  private escapes: Map<number, boolean> = new Map();
  /** Metadata for each tool call index */
  private toolCallMeta: Map<number, { id?: string; name?: string }> = new Map();
  /** Map from tool call ID to actual index used for storage */
  private idToIndexMap: Map<string, number> = new Map();
  /** Counter for generating new indices when collisions occur */
  private nextAvailableIndex: number = 0;

  /**
   * Processes a new chunk of tool call data and attempts to parse complete JSON objects
   *
   * Handles the core problems of streaming tool call parsing:
   * - Resolves index collisions when the same index is reused for different tool calls
   * - Routes chunks without IDs to the correct incomplete tool call
   * - Tracks JSON parsing state (depth, string boundaries, escapes) per tool call
   * - Attempts parsing only when JSON structure is complete (depth = 0)
   * - Repairs common issues like unclosed strings
   *
   * @param index - Tool call index from streaming response (may collide with existing calls)
   * @param chunk - String chunk that may be empty, partial JSON, or complete data
   * @param id - Optional tool call ID for collision detection and chunk routing
   * @param name - Optional function name stored as metadata
   * @returns ToolCallParseResult with completion status, parsed value, and repair info
   */
  addChunk(
    index: number,
    chunk: string,
    id?: string,
    name?: string,
  ): ToolCallParseResult {
    let actualIndex = index;

    // Handle tool call ID mapping for collision detection
    if (id) {
      // This is the start of a new tool call with an ID
      if (this.idToIndexMap.has(id)) {
        // We've seen this ID before, use the existing mapped index
        actualIndex = this.idToIndexMap.get(id)!;
      } else {
        // New tool call ID
        // Check if the requested index is already occupied by a different complete tool call
        if (this.buffers.has(index)) {
          const existingBuffer = this.buffers.get(index)!;
          const existingDepth = this.depths.get(index)!;
          const existingMeta = this.toolCallMeta.get(index);

          // Check if we have a complete tool call at this index
          if (
            existingBuffer.trim() &&
            existingDepth === 0 &&
            existingMeta?.id &&
            existingMeta.id !== id
          ) {
            try {
              JSON.parse(existingBuffer);
              // We have a complete tool call with a different ID at this index
              // Find a new index for this tool call
              actualIndex = this.findNextAvailableIndex();
            } catch {
              // Existing buffer is not complete JSON, we can reuse this index
            }
          }
        }

        // Map this ID to the actual index we're using
        this.idToIndexMap.set(id, actualIndex);
      }
    } else {
      // No ID provided - this is a continuation chunk
      // Try to find which tool call this belongs to based on the index
      // Look for an existing tool call at this index that's not complete
      if (this.buffers.has(index)) {
        const existingBuffer = this.buffers.get(index)!;
        const existingDepth = this.depths.get(index)!;

        // If there's an incomplete tool call at this index, continue with it
        if (existingDepth > 0 || !existingBuffer.trim()) {
          actualIndex = index;
        } else {
          // Check if the buffer at this index is complete
          try {
            JSON.parse(existingBuffer);
            // Buffer is complete, this chunk might belong to a different tool call
            // Find the most recent incomplete tool call
            actualIndex = this.findMostRecentIncompleteIndex();
          } catch {
            // Buffer is incomplete, continue with this index
            actualIndex = index;
          }
        }
      }
    }

    // Initialize state for the actual index if not exists
    if (!this.buffers.has(actualIndex)) {
      this.buffers.set(actualIndex, '');
      this.depths.set(actualIndex, 0);
      this.inStrings.set(actualIndex, false);
      this.escapes.set(actualIndex, false);
      this.toolCallMeta.set(actualIndex, {});
    }

    // Update metadata
    const meta = this.toolCallMeta.get(actualIndex)!;
    if (id) meta.id = id;
    if (name) meta.name = name;

    // Get current state for the actual index
    const currentBuffer = this.buffers.get(actualIndex)!;
    const currentDepth = this.depths.get(actualIndex)!;
    const currentInString = this.inStrings.get(actualIndex)!;
    const currentEscape = this.escapes.get(actualIndex)!;

    // Add chunk to buffer
    const newBuffer = currentBuffer + chunk;
    this.buffers.set(actualIndex, newBuffer);

    // Track JSON structure depth - only count brackets/braces outside of strings
    let depth = currentDepth;
    let inString = currentInString;
    let escape = currentEscape;

    for (const char of chunk) {
      if (!inString) {
        if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') depth--;
      }

      // Track string boundaries - toggle inString state on unescaped quotes
      if (char === '"' && !escape) {
        inString = !inString;
      }
      // Track escape sequences - backslash followed by any character is escaped
      escape = char === '\\' && !escape;
    }

    // Update state
    this.depths.set(actualIndex, depth);
    this.inStrings.set(actualIndex, inString);
    this.escapes.set(actualIndex, escape);

    // Attempt parse when we're back at root level (depth 0) and have data
    if (depth === 0 && newBuffer.trim().length > 0) {
      try {
        // Standard JSON parsing attempt
        const parsed = JSON.parse(newBuffer);
        return { complete: true, value: parsed };
      } catch (e) {
        // Intelligent repair: try auto-closing unclosed strings
        if (inString) {
          try {
            const repaired = JSON.parse(newBuffer + '"');
            return {
              complete: true,
              value: repaired,
              repaired: true,
            };
          } catch {
            // If repair fails, fall through to error case
          }
        }
        return {
          complete: false,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      }
    }

    // JSON structure is incomplete, continue accumulating chunks
    return { complete: false };
  }

  /**
   * Gets the current tool call metadata for a specific index
   *
   * @param index - The tool call index
   * @returns Object containing id and name if available
   */
  getToolCallMeta(index: number): { id?: string; name?: string } {
    return this.toolCallMeta.get(index) || {};
  }

  /**
   * Gets all completed tool calls that are ready to be emitted
   *
   * Attempts to parse accumulated buffers using multiple strategies:
   * 1. Standard JSON.parse()
   * 2. Auto-close unclosed strings and retry
   * 3. Fallback to safeJsonParse for malformed data
   *
   * Only returns tool calls with both name metadata and non-empty buffers.
   * Should be called when streaming is complete (finish_reason is present).
   *
   * @returns Array of completed tool calls with their metadata and parsed arguments
   */
  getCompletedToolCalls(): Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
    index: number;
  }> {
    const completed: Array<{
      id?: string;
      name?: string;
      args: Record<string, unknown>;
      index: number;
    }> = [];

    for (const [index, buffer] of this.buffers.entries()) {
      const meta = this.toolCallMeta.get(index);
      if (meta?.name && buffer.trim()) {
        let args: Record<string, unknown> = {};

        // Try to parse the final buffer
        try {
          args = JSON.parse(buffer);
        } catch {
          // Try with repair (auto-close strings)
          const inString = this.inStrings.get(index);
          if (inString) {
            try {
              args = JSON.parse(buffer + '"');
            } catch {
              // If all parsing fails, use safeJsonParse as fallback
              args = safeJsonParse(buffer, {});
            }
          } else {
            args = safeJsonParse(buffer, {});
          }
        }

        completed.push({
          id: meta.id,
          name: meta.name,
          args,
          index,
        });
      }
    }

    return completed;
  }

  /**
   * Finds the next available index for a new tool call
   *
   * Scans indices starting from nextAvailableIndex to find one that's safe to use.
   * Reuses indices with empty buffers or incomplete parsing states.
   * Skips indices with complete, parseable tool call data to prevent overwriting.
   *
   * @returns The next available index safe for storing a new tool call
   */
  private findNextAvailableIndex(): number {
    while (this.buffers.has(this.nextAvailableIndex)) {
      // Check if this index has a complete tool call
      const buffer = this.buffers.get(this.nextAvailableIndex)!;
      const depth = this.depths.get(this.nextAvailableIndex)!;
      const meta = this.toolCallMeta.get(this.nextAvailableIndex);

      // If buffer is empty or incomplete (depth > 0), this index is available
      if (!buffer.trim() || depth > 0 || !meta?.id) {
        return this.nextAvailableIndex;
      }

      // Try to parse the buffer to see if it's complete
      try {
        JSON.parse(buffer);
        // If parsing succeeds and depth is 0, this index has a complete tool call
        if (depth === 0) {
          this.nextAvailableIndex++;
          continue;
        }
      } catch {
        // If parsing fails, this index is available for reuse
        return this.nextAvailableIndex;
      }

      this.nextAvailableIndex++;
    }
    return this.nextAvailableIndex++;
  }

  /**
   * Finds the most recent incomplete tool call index
   *
   * Used when continuation chunks arrive without IDs. Scans existing tool calls
   * to find the highest index with incomplete parsing state (depth > 0, empty buffer,
   * or unparseable JSON). Falls back to creating a new index if none found.
   *
   * @returns The index of the most recent incomplete tool call, or a new available index
   */
  private findMostRecentIncompleteIndex(): number {
    // Look for the highest index that has an incomplete tool call
    let maxIndex = -1;
    for (const [index, buffer] of this.buffers.entries()) {
      const depth = this.depths.get(index)!;
      const meta = this.toolCallMeta.get(index);

      // Check if this tool call is incomplete
      if (meta?.id && (depth > 0 || !buffer.trim())) {
        maxIndex = Math.max(maxIndex, index);
      } else if (buffer.trim()) {
        // Check if buffer is parseable (complete)
        try {
          JSON.parse(buffer);
          // Buffer is complete, skip this index
        } catch {
          // Buffer is incomplete, this could be our target
          maxIndex = Math.max(maxIndex, index);
        }
      }
    }

    return maxIndex >= 0 ? maxIndex : this.findNextAvailableIndex();
  }

  /**
   * Resets the parser state for a specific tool call index
   *
   * @param index - The tool call index to reset
   */
  resetIndex(index: number): void {
    this.buffers.set(index, '');
    this.depths.set(index, 0);
    this.inStrings.set(index, false);
    this.escapes.set(index, false);
    this.toolCallMeta.set(index, {});
  }

  /**
   * Resets the entire parser state for processing a new stream
   *
   * Clears all accumulated buffers, parsing states, metadata, and counters.
   * Allows the parser to be reused for multiple independent streams without
   * data leakage between sessions.
   */
  reset(): void {
    this.buffers.clear();
    this.depths.clear();
    this.inStrings.clear();
    this.escapes.clear();
    this.toolCallMeta.clear();
    this.idToIndexMap.clear();
    this.nextAvailableIndex = 0;
  }

  /**
   * Gets the current accumulated buffer content for a specific index
   *
   * @param index - The tool call index to retrieve buffer for
   * @returns The current buffer content for the specified index (empty string if not found)
   */
  getBuffer(index: number): string {
    return this.buffers.get(index) || '';
  }

  /**
   * Gets the current parsing state information for a specific index
   *
   * @param index - The tool call index to get state information for
   * @returns Object containing current parsing state (depth, inString, escape)
   */
  getState(index: number): {
    depth: number;
    inString: boolean;
    escape: boolean;
  } {
    return {
      depth: this.depths.get(index) || 0,
      inString: this.inStrings.get(index) || false,
      escape: this.escapes.get(index) || false,
    };
  }
}
