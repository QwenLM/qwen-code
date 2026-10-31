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
  isShellToolName,
  sanitizeControlChars,
  truncateText,
} from '../messages/toolFormatting';
import { extractDiff, fencedCodeBlock } from '../messages/ToolGroup';
import { Markdown } from '../messages/Markdown';
import { parseShellLiveOutput } from '../messages/tools/shellLiveOutput';
import styles from './tool-call-content.module.css';

/** The longest stretch of one argument or result put in the DOM by default. */
export const MAX_DETAIL_LENGTH = 4000;

const EDIT_TOOL = /^(edit|editfile|write|write_file|writefile)$/;

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : safeJson(value);
  return text.trim();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** Valid JSON renders as a code block; anything else stays plain text. */
export function ToolCallDetail({
  text,
  limit = MAX_DETAIL_LENGTH,
}: {
  text: string;
  limit?: number;
}) {
  const json = useMemo(() => {
    try {
      JSON.parse(text);
      return text;
    } catch {
      return undefined;
    }
  }, [text]);
  const displayed = truncateText(json ?? text, limit);
  return json !== undefined ? (
    <div className={styles.json}>
      <Markdown content={fencedCodeBlock('json', displayed)} />
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
 * and output, an edit or write as its diff, anything else as recorded.
 */
export function toolCallContent(
  tool: ACPToolCall,
  block: Pick<DaemonToolTranscriptBlock, 'rawInput' | 'rawOutput' | 'content'>,
) {
  const diff = EDIT_TOOL.test(tool.toolName.toLowerCase())
    ? extractDiff(tool)
    : '';
  const shell = isShellToolName(tool.toolName) ? shellDetails(tool) : undefined;
  return {
    diff,
    shell,
    argumentsText: shell ? shell.command : stringifyValue(block.rawInput),
    resultText: diff
      ? ''
      : shell
        ? shell.output
        : stringifyValue(block.rawOutput ?? block.content),
  };
}
