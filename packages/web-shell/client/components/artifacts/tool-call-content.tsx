/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import type { DaemonToolTranscriptBlock } from '@qwen-code/sdk/daemon';
import { isShellResultDisplay } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../../adapters/types';
import {
  extractText,
  getExecSource,
  isShellToolName,
  MAX_TOOL_PAYLOAD_LENGTH,
  sanitizeControlChars,
  stringifyValue,
  truncateText,
} from '../messages/toolFormatting';
import { extractDiff, fencedCodeBlock } from '../messages/ToolGroup';
import { Markdown } from '../messages/Markdown';
import { parseShellLiveOutput } from '../messages/tools/shellLiveOutput';
import styles from './tool-call-content.module.css';

/** The longest stretch of one argument or result put in the DOM by default. */
export const MAX_DETAIL_LENGTH = MAX_TOOL_PAYLOAD_LENGTH;

export { stringifyValue };

const EDIT_TOOL = /^(edit|editfile|write|write_file|writefile)$/;

/**
 * Valid JSON renders as a code block, an explicit language renders as that
 * code; anything else stays plain text.
 */
export function ToolCallDetail({
  text,
  limit = MAX_DETAIL_LENGTH,
  language,
}: {
  text: string;
  limit?: number;
  language?: string;
}) {
  const json = useMemo(() => {
    if (language !== undefined) return undefined;
    try {
      JSON.parse(text);
      return text;
    } catch {
      return undefined;
    }
  }, [text, language]);
  // Escape before capping, in ToolPayloadBlock's order: escapes can grow the
  // text past the cap, and raw C0/bidi bytes must not reach the DOM.
  const escaped = sanitizeControlChars(truncateText(json ?? text, limit));
  const displayed =
    escaped.length > limit ? truncateText(escaped, limit) : escaped;
  const fenceLanguage = language ?? (json !== undefined ? 'json' : undefined);
  return fenceLanguage !== undefined ? (
    <div className={styles.json}>
      <Markdown content={fencedCodeBlock(fenceLanguage, displayed)} />
    </div>
  ) : (
    <pre className={styles.detailBody}>{displayed}</pre>
  );
}

export function shellDetails(tool: ACPToolCall) {
  const raw = tool.rawOutput;
  const result = isShellResultDisplay(raw) ? raw : undefined;
  const live = parseShellLiveOutput(raw);
  const command =
    typeof tool.args?.command === 'string' ? tool.args.command : '';
  const unknownVersion =
    raw &&
    typeof raw === 'object' &&
    'type' in raw &&
    raw.type === 'shell_result' &&
    !result;
  const output =
    result?.output ??
    (live
      ? (live.segments?.map((segment) => segment.text).join('') ?? '')
      : typeof raw === 'string'
        ? raw
        : unknownVersion
          ? 'text' in raw && typeof raw.text === 'string'
            ? raw.text
            : stringifyValue(raw)
          : (extractText(tool) ?? stringifyValue(raw)));
  const args = Object.fromEntries(
    Object.entries(tool.args ?? {}).filter(([key]) => key !== 'command'),
  );
  const metadata = result
    ? Object.fromEntries(
        Object.entries(result).filter(
          ([key]) => !['type', 'version', 'text', 'output'].includes(key),
        ),
      )
    : live
      ? Object.fromEntries(
          Object.entries(live).filter(
            ([key, value]) => key !== 'segments' && value !== undefined,
          ),
        )
      : undefined;
  const other = {
    ...(Object.keys(args).length ? { arguments: args } : {}),
    ...(metadata && Object.keys(metadata).length ? { result: metadata } : {}),
  };
  return {
    command: sanitizeControlChars(command),
    output: sanitizeControlChars(output),
    other: Object.keys(other).length
      ? truncateText(stringifyValue(other), MAX_DETAIL_LENGTH)
      : '',
  };
}

/**
 * What a tool call's arguments and result read as: a shell call as its command
 * and output, an edit or write as its diff, an exec call as its JavaScript
 * source, anything else as recorded.
 */
export function toolCallContent(
  tool: ACPToolCall,
  block: Pick<DaemonToolTranscriptBlock, 'rawInput' | 'rawOutput' | 'content'>,
) {
  const diff = EDIT_TOOL.test(tool.toolName.toLowerCase())
    ? extractDiff(tool)
    : '';
  const shell = isShellToolName(tool.toolName) ? shellDetails(tool) : undefined;
  const execSource = getExecSource(tool);
  return {
    diff,
    shell,
    argumentsText:
      execSource ?? (shell ? shell.command : stringifyValue(block.rawInput)),
    argumentsLanguage: execSource !== undefined ? 'javascript' : undefined,
    resultText: diff
      ? ''
      : shell
        ? shell.output
        : stringifyValue(block.rawOutput ?? block.content),
  };
}
