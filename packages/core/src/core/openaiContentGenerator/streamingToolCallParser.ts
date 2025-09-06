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
 * Streaming Tool Call Parser Implementation
 *
 * This class implements a sophisticated streaming parser specifically designed for
 * handling tool call arguments that arrive as partial JSON data in chunks during
 * OpenAI streaming responses. It extends the principles from the streaming JSON parser
 * to handle the specific requirements of tool call processing.
 *
 * Key Features:
 * - Real-time depth tracking for nested JSON structures in tool arguments
 * - Proper handling of string literals and escape sequences
 * - Automatic repair of common JSON formatting issues
 * - Support for multiple consecutive tool calls with same or different function names
 * - Memory-efficient processing without storing complete JSON in memory
 * - State management for individual tool call indices
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

  /**
   * Processes a new chunk of tool call data and attempts to parse complete JSON objects
   *
   * This method implements a state machine that tracks:
   * 1. JSON structure depth (brackets and braces) per tool call index
   * 2. String literal boundaries per tool call index
   * 3. Escape sequences within strings per tool call index
   * 4. Tool call metadata (id, function name) per tool call index
   *
   * The parser only attempts to parse when the depth returns to 0, indicating
   * a complete JSON structure has been received for that specific tool call index.
   *
   * @param index - The tool call index from OpenAI streaming response
   * @param chunk - A string chunk containing partial JSON data for arguments
   * @param id - Optional tool call ID
   * @param name - Optional function name
   * @returns ToolCallParseResult indicating whether parsing is complete and any parsed value
   */
  addChunk(
    index: number,
    chunk: string,
    id?: string,
    name?: string,
  ): ToolCallParseResult {
    // Initialize state for this index if not exists
    if (!this.buffers.has(index)) {
      this.buffers.set(index, '');
      this.depths.set(index, 0);
      this.inStrings.set(index, false);
      this.escapes.set(index, false);
      this.toolCallMeta.set(index, {});
    }

    // Update metadata
    const meta = this.toolCallMeta.get(index)!;
    if (id) meta.id = id;
    if (name) {
      // If this is a new function name and we have existing arguments,
      // it might be a new tool call with the same index - reset the buffer
      if (meta.name && meta.name !== name && this.buffers.get(index)) {
        const currentBuffer = this.buffers.get(index)!;
        // Check if current buffer contains complete JSON
        if (currentBuffer.trim()) {
          try {
            JSON.parse(currentBuffer);
            // If we can parse it, this is likely a new tool call - reset state
            this.resetIndex(index);
            // Update metadata after reset
            const resetMeta = this.toolCallMeta.get(index)!;
            if (id) resetMeta.id = id;
            resetMeta.name = name;
          } catch {
            // Current buffer is incomplete, continue accumulating
            meta.name = name;
          }
        } else {
          meta.name = name;
        }
      } else {
        meta.name = name;
      }
    }

    // Get current state for this index
    const currentBuffer = this.buffers.get(index)!;
    const currentDepth = this.depths.get(index)!;
    const currentInString = this.inStrings.get(index)!;
    const currentEscape = this.escapes.get(index)!;

    // Add chunk to buffer
    const newBuffer = currentBuffer + chunk;
    this.buffers.set(index, newBuffer);

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
    this.depths.set(index, depth);
    this.inStrings.set(index, inString);
    this.escapes.set(index, escape);

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
   * This method should be called when the streaming is complete (finish_reason is present)
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
   * This method clears all internal state variables, allowing the parser
   * to be reused for multiple streams without interference.
   */
  reset(): void {
    this.buffers.clear();
    this.depths.clear();
    this.inStrings.clear();
    this.escapes.clear();
    this.toolCallMeta.clear();
  }

  /**
   * Gets the current accumulated buffer content for a specific index
   *
   * Useful for debugging or when you need to inspect the raw data
   * that has been accumulated so far.
   *
   * @param index - The tool call index
   * @returns The current buffer content for the specified index
   */
  getBuffer(index: number): string {
    return this.buffers.get(index) || '';
  }

  /**
   * Gets the current parsing state information for a specific index
   *
   * @param index - The tool call index
   * @returns Object containing current depth, string state, and escape state
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
