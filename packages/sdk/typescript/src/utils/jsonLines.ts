/**
 * JSON Lines protocol utilities
 *
 * JSON Lines format: one JSON object per line, newline-delimited
 * Example:
 *   {"type":"user","message":{...}}
 *   {"type":"assistant","message":{...}}
 *
 * Used for SDK-CLI communication over stdin/stdout streams.
 */

/**
 * Serialize a message to JSON Lines format
 *
 * Converts object to JSON and appends newline.
 *
 * @param message - Object to serialize
 * @returns JSON string with trailing newline
 * @throws Error if JSON serialization fails
 */
export function serializeJsonLine(message: unknown): string {
  try {
    return JSON.stringify(message) + '\n';
  } catch (error) {
    throw new Error(
      `Failed to serialize message to JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse a JSON Lines message
 *
 * Parses single line of JSON (without newline).
 *
 * @param line - JSON string (without trailing newline)
 * @returns Parsed object
 * @throws Error if JSON parsing fails
 */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON line: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse JSON Lines with error handling
 *
 * Attempts to parse JSON line, logs warning and returns null on failure.
 * Useful for robust parsing where malformed messages should be skipped.
 *
 * @param line - JSON string (without trailing newline)
 * @param context - Context string for error logging (e.g., 'Transport')
 * @returns Parsed object or null if parsing fails
 */
export function parseJsonLineSafe(
  line: string,
  context = 'JsonLines',
): unknown | null {
  try {
    return JSON.parse(line);
  } catch (error) {
    console.warn(
      `[${context}] Failed to parse JSON line, skipping:`,
      line.substring(0, 100),
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Validate message has required type field
 *
 * Ensures message conforms to basic message protocol.
 *
 * @param message - Parsed message object
 * @returns true if valid, false otherwise
 */
export function isValidMessage(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === 'object' &&
    'type' in message &&
    typeof (message as { type: unknown }).type === 'string'
  );
}

/**
 * Async generator that yields parsed JSON Lines from async iterable of strings
 *
 * Usage:
 * ```typescript
 * const lines = readline.createInterface({ input: stream });
 * for await (const message of parseJsonLinesStream(lines)) {
 *   console.log(message);
 * }
 * ```
 *
 * @param lines - AsyncIterable of line strings
 * @param context - Context string for error logging
 * @yields Parsed message objects (skips malformed lines)
 */
export async function* parseJsonLinesStream(
  lines: AsyncIterable<string>,
  context = 'JsonLines',
): AsyncGenerator<unknown, void, unknown> {
  for await (const line of lines) {
    // Skip empty lines
    if (line.trim().length === 0) {
      continue;
    }

    // Parse with error handling
    const message = parseJsonLineSafe(line, context);

    // Skip malformed messages
    if (message === null) {
      continue;
    }

    // Validate message structure
    if (!isValidMessage(message)) {
      console.warn(
        `[${context}] Invalid message structure (missing 'type' field), skipping:`,
        line.substring(0, 100),
      );
      continue;
    }

    yield message;
  }
}
