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
 */
export function buildTranscriptMarker(transcriptPath: string): string {
  return `${EARLIER_OUTPUT_OMITTED}\n${MARKER_PREFIX}${transcriptPath}${MARKER_SUFFIX}\n`;
}
