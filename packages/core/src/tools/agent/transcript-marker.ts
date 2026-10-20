/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tool-names.js';

const EARLIER_OUTPUT_OMITTED = '[earlier output omitted]';
const MARKER_PREFIX = 'The full output is in ';
const MARKER_SUFFIX = `. Read it with the ${ToolNames.READ_FILE} tool.`;

/**
 * The marker `composeIncompleteResult` places above a trimmed subagent result.
 * The transcript path it names is the only handle to the omitted head, so a
 * consumer that shortens the text must keep the line whole.
 *
 * Built here rather than at the call site so `transcriptMarkerRange` below and
 * the rendered line cannot drift.
 */
export function buildTranscriptMarker(transcriptPath: string): string {
  return `${EARLIER_OUTPUT_OMITTED}\n${MARKER_PREFIX}${transcriptPath}${MARKER_SUFFIX}\n`;
}

/** The character range of that marker line, for text that must not be sliced. */
export function transcriptMarkerRange(
  text: string,
): { start: number; end: number } | undefined {
  const omitted = text.indexOf(`${EARLIER_OUTPUT_OMITTED}\n`);
  if (omitted === -1) return undefined;
  const start = omitted + EARLIER_OUTPUT_OMITTED.length + 1;
  const end = text.indexOf('\n', start);
  if (end === -1) return undefined;
  const line = text.slice(start, end);
  if (
    !line.startsWith(MARKER_PREFIX) ||
    !line.endsWith(MARKER_SUFFIX) ||
    line.length === MARKER_PREFIX.length + MARKER_SUFFIX.length
  ) {
    return undefined;
  }
  return { start, end };
}
