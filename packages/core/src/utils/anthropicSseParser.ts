/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Robust SSE parser utilities for Anthropic-compatible APIs.
 *
 * Some Anthropic-compatible providers return malformed SSE data with
 * trailing whitespace inside JSON objects, e.g.:
 *   data: {"type":"message_stop"               }
 *
 * This module provides utilities to handle such cases.
 */

// Define types locally to avoid SDK import issues with verbatimModuleSyntax
// These match the types from @anthropic-ai/sdk

export interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: unknown[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens?: number;
    };
  };
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent;

/**
 * Safely parse SSE data string into an AnthropicStreamEvent.
 * Handles malformed JSON with extra whitespace inside objects/arrays.
 *
 * @param data - The raw SSE data string
 * @returns Parsed event or null if parsing fails
 */
export function parseAnthropicSseData(
  data: string,
): AnthropicStreamEvent | null {
  if (!data || typeof data !== 'string') {
    return null;
  }

  // Trim leading/trailing whitespace first
  let normalizedData = data.trim();

  try {
    // Standard JSON.parse handles most cases
    return JSON.parse(normalizedData) as AnthropicStreamEvent;
  } catch {
    // Some providers return malformed JSON with trailing whitespace
    // inside the JSON object before the closing brace, e.g.:
    // {"type":"message_stop"               }
    //
    // Try to fix by removing whitespace before } and ]

    // Remove trailing whitespace before closing braces/brackets, but only
    // when preceded by a JSON value terminator (" or digit or ] or })
    // to avoid corrupting whitespace inside string values like "hello   }".
    normalizedData = normalizedData.replace(/(["\d\]}])\s+([\]}])/g, '$1$2');

    try {
      return JSON.parse(normalizedData) as AnthropicStreamEvent;
    } catch {
      // Failed to parse, return null
      return null;
    }
  }
}

/**
 * Decode SSE text chunk into individual events.
 * Handles both HTTP/1.1 and HTTP/2 streaming formats.
 *
 * @param chunk - Raw SSE text chunk
 * @returns Array of parsed events
 */
export function decodeSseChunk(chunk: string): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const lines = chunk.split('\n');

  let currentEvent: string | null = null;
  let dataLines: string[] = [];

  for (const line of lines) {
    // Handle carriage return
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (!normalizedLine) {
      // Empty line signals end of event
      if (currentEvent && dataLines.length > 0) {
        const data = dataLines.join('\n');
        const parsed = parseAnthropicSseData(data);
        if (parsed) {
          events.push(parsed);
        }
      }
      // Reset for next event
      currentEvent = null;
      dataLines = [];
      continue;
    }

    // Skip comment lines
    if (normalizedLine.startsWith(':')) {
      continue;
    }

    // Parse field
    const colonIndex = normalizedLine.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const fieldName = normalizedLine.substring(0, colonIndex);
    let fieldValue = normalizedLine.substring(colonIndex + 1);

    // Remove leading space from value (SSE spec)
    if (fieldValue.startsWith(' ')) {
      fieldValue = fieldValue.substring(1);
    }

    if (fieldName === 'event') {
      currentEvent = fieldValue;
    } else if (fieldName === 'data') {
      dataLines.push(fieldValue);
    }
  }

  // Handle case where stream doesn't end with empty line
  if (currentEvent && dataLines.length > 0) {
    const data = dataLines.join('\n');
    const parsed = parseAnthropicSseData(data);
    if (parsed) {
      events.push(parsed);
    }
  }

  return events;
}

/**
 * Async generator that parses an SSE response stream.
 * Yields parsed Anthropic events as they become available.
 *
 * @param body - The response body as a ReadableStream
 * @returns AsyncGenerator yielding parsed events
 */
export async function* parseAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining buffered data
        if (buffer.trim()) {
          const events = decodeSseChunk(buffer);
          for (const event of events) {
            yield event;
          }
        }
        break;
      }

      // Decode chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Find complete events (separated by double newlines)
      // Support \n\n, \r\r, and \r\n\r\n patterns
      const eventEndPattern = /(\n\n|\r\r|\r\n\r\n)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = eventEndPattern.exec(buffer)) !== null) {
        const eventText = buffer.substring(
          lastIndex,
          match.index + match[0].length,
        );
        lastIndex = match.index + match[0].length;

        const events = decodeSseChunk(eventText);
        for (const event of events) {
          yield event;
        }
      }

      // Remove processed data from buffer
      if (lastIndex > 0) {
        buffer = buffer.substring(lastIndex);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
