/**
 * Microcompact: a lightweight, zero-LLM-call compression strategy.
 *
 * Shrinks chat history by truncating large tool result contents that are
 * unlikely to still be relevant (older results further from the current
 * conversation focus). Runs before the expensive LLM-based compression
 * to avoid unnecessary API calls.
 */

import type { Content, Part } from '@google/genai';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tools whose results can be safely truncated during microcompact. */
const COMPACTABLE_TOOLS = new Set<string>([
  'read_file',
  'run_shell_command',
  'grep_search',
  'glob',
  'list_directory',
  'web_fetch',
  'web_search',
  'edit',
  'write_file',
  'notebook_edit',
]);

/** Results smaller than this are left alone (bytes of JSON-serialized text). */
const MIN_RESULT_SIZE_TO_COMPACT = 500;

/** Number of most-recent tool results to keep intact. */
const DEFAULT_KEEP_RECENT = 5;

/** Replacement text for cleared results. */
const CLEARED_MESSAGE = '[Old tool result cleared to save context space]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResultRef {
  /** Index into the contents array */
  contentIndex: number;
  /** Index into the parts array within that content */
  partIndex: number;
  /** Original size in characters */
  size: number;
  /** Tool name */
  toolName: string;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Collect references to all compactable tool results in the history,
 * ordered from oldest to newest.
 */
function collectToolResults(contents: Content[]): ToolResultRef[] {
  const refs: ToolResultRef[] = [];

  for (let ci = 0; ci < contents.length; ci++) {
    const content = contents[ci];
    if (content.role !== 'user' || !content.parts) continue;

    for (let pi = 0; pi < content.parts.length; pi++) {
      const part = content.parts[pi];
      if (!part.functionResponse) continue;

      const name = part.functionResponse.name ?? '';
      if (!COMPACTABLE_TOOLS.has(name)) continue;

      const response = part.functionResponse.response;
      const output =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)['output']
          : undefined;

      if (typeof output !== 'string') continue;
      if (output === CLEARED_MESSAGE) continue; // Already cleared
      if (output.length < MIN_RESULT_SIZE_TO_COMPACT) continue;

      refs.push({
        contentIndex: ci,
        partIndex: pi,
        size: output.length,
        toolName: name,
      });
    }
  }

  return refs;
}

/**
 * Apply microcompact to a chat history **in place**.
 *
 * Clears old, large tool results while keeping the `keepRecent` most recent
 * ones intact. Returns the number of characters freed.
 *
 * @param contents  The mutable chat history array.
 * @param keepRecent Number of recent tool results to preserve (default 5).
 * @returns Total characters freed by clearing old results.
 */
export function microcompact(
  contents: Content[],
  keepRecent: number = DEFAULT_KEEP_RECENT,
): number {
  const refs = collectToolResults(contents);

  // Nothing to compact, or not enough results to be worth it
  if (refs.length <= keepRecent) {
    return 0;
  }

  const toClear = refs.slice(0, refs.length - keepRecent);
  let freedChars = 0;

  for (const ref of toClear) {
    const part = contents[ref.contentIndex].parts![ref.partIndex] as Part & {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
      };
    };
    const oldOutput = part.functionResponse.response['output'] as string;
    part.functionResponse.response = { output: CLEARED_MESSAGE };
    freedChars += oldOutput.length - CLEARED_MESSAGE.length;
  }

  return freedChars;
}

/**
 * Estimate the character reduction as a rough token count saving.
 * Uses a ~4 chars per token heuristic.
 */
export function estimateTokensSaved(charsSaved: number): number {
  return Math.floor(charsSaved / 4);
}
