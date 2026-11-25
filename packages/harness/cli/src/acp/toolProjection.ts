/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as acp from '@agentclientprotocol/sdk';
import {
  BRAND_PROTOCOL_NAMESPACE,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  Kind,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  getToolUseDisplayMetadata,
  isCompactFileToolResult,
} from '@qwen-code/core';

export type RuntimeToolResult = {
  display: unknown;
  isError: boolean;
  filePath?: string;
};

export type ProjectToolCallInput = {
  toolCallId: string;
  name: string;
  input: unknown;
  status?: acp.ToolCallStatus;
  kind?: Kind;
  result?: RuntimeToolResult;
  supportsTerminalOutput?: boolean;
};

export type ProjectToolCallUpdateInput = {
  toolCallId: string;
  name?: string;
  content?: unknown;
  isError?: boolean;
  supportsTerminalOutput?: boolean;
};

function usesTerminalBlock(
  name: string | undefined,
  supportsTerminalOutput: boolean | undefined,
): boolean {
  return !!supportsTerminalOutput && isShellTool(name);
}

export function projectToolCall(input: ProjectToolCallInput): acp.ToolCall {
  const projected = projectToolShape(
    input.name,
    input.input,
    input.kind,
    input.supportsTerminalOutput,
  );
  const resultContent = input.result
    ? toAcpToolCallContent(
        input.result.display,
        input.name,
        input.supportsTerminalOutput,
        input.result.isError,
      )
    : [];
  const resultLocations = input.result?.filePath
    ? [{ path: input.result.filePath }]
    : [];
  const locations =
    resultLocations.length > 0
      ? resultLocations
      : projected.locations.length > 0
        ? projected.locations
        : undefined;

  const isTerminalCall = usesTerminalBlock(
    input.name,
    input.supportsTerminalOutput,
  );
  const meta: NonNullable<acp.ToolCall['_meta']> = {
    [BRAND_PROTOCOL_NAMESPACE]: {
      toolName: input.name,
    },
  };
  if (isTerminalCall && !input.result) {
    meta['terminal_info'] = { terminal_id: input.toolCallId };
  }

  return {
    toolCallId: input.toolCallId,
    status:
      input.status ??
      (input.result
        ? input.result.isError
          ? 'failed'
          : 'completed'
        : 'pending'),
    title: projected.title,
    content: input.result
      ? resultContent
      : isTerminalCall
        ? [{ type: 'terminal', terminalId: input.toolCallId }]
        : projected.content,
    kind: projected.kind,
    rawInput: input.input,
    rawOutput: input.result?.display,
    locations,
    _meta: meta,
  };
}

export function projectToolCallUpdate(
  input: ProjectToolCallUpdateInput,
): acp.ToolCallUpdate {
  if (
    input.toolCallId &&
    usesTerminalBlock(input.name, input.supportsTerminalOutput) &&
    !input.isError
  ) {
    return {
      toolCallId: input.toolCallId,
      status: 'completed',
      content: [{ type: 'terminal', terminalId: input.toolCallId }],
      rawOutput: input.content ?? undefined,
      _meta: {
        terminal_exit: {
          terminal_id: input.toolCallId,
          exit_code: 0,
          signal: null,
        },
      },
    };
  }

  const resultContent = toAcpToolCallContent(
    input.content,
    input.name,
    input.supportsTerminalOutput,
    input.isError,
  );
  return {
    toolCallId: input.toolCallId,
    status: input.isError ? 'failed' : 'completed',
    content: resultContent,
    rawOutput: input.content ?? undefined,
  };
}

export function projectTerminalOutputUpdate(
  input: ProjectToolCallUpdateInput,
): acp.ToolCallUpdate | null {
  if (
    !input.toolCallId ||
    !usesTerminalBlock(input.name, input.supportsTerminalOutput) ||
    input.isError
  ) {
    return null;
  }

  const text = toToolResultText(input.content);
  if (!text) {
    return null;
  }

  return {
    toolCallId: input.toolCallId,
    _meta: {
      terminal_output: {
        terminal_id: input.toolCallId,
        data: text,
      },
    },
  };
}

export function toAcpToolKind(kind: Kind): acp.ToolKind {
  switch (kind) {
    case Kind.Read:
    case Kind.Edit:
    case Kind.Execute:
    case Kind.Search:
    case Kind.Delete:
    case Kind.Move:
    case Kind.Think:
    case Kind.Fetch:
    case Kind.SwitchMode:
    case Kind.Other:
      return kind as acp.ToolKind;
    case Kind.Agent:
    case Kind.Workflow:
      return 'think';
    case Kind.Plan:
    case Kind.Communicate:
    default:
      return 'other';
  }
}

export function extractLocationsFromInput(
  input: unknown,
): acp.ToolCallLocation[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const record = input as Record<string, unknown>;
  const locations: acp.ToolCallLocation[] = [];
  const pathFields = [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'old_path',
    'new_path',
  ];
  for (const field of pathFields) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      locations.push({ path: value });
    }
  }

  const line = record['line'] ?? record['start_line'] ?? record['offset'];
  if (
    locations.length > 0 &&
    typeof line === 'number' &&
    Number.isFinite(line)
  ) {
    locations[0] = { ...locations[0], line };
  }

  return dedupeLocations(locations);
}

export function toAcpToolCallContent(
  display: unknown,
  toolName?: string,
  supportsTerminalOutput = false,
  isError = false,
): acp.ToolCallContent[] {
  if (display === undefined || display === null) {
    return [];
  }

  const compactDiff = compactDiffContentFromDisplay(display);
  if (compactDiff) {
    return [compactDiff];
  }

  const diff = diffContentFromDisplay(display);
  if (diff) {
    return [diff];
  }

  const text = toToolResultText(display);
  const formattedText = formatToolResultText(
    text,
    toolName,
    supportsTerminalOutput,
    isError,
  );
  const content: acp.ToolCallContent = {
    type: 'content',
    content: { type: 'text', text: formattedText },
  };
  return [content];
}

type ProjectedToolShape = {
  title: string;
  kind: acp.ToolKind;
  locations: acp.ToolCallLocation[];
  content: acp.ToolCallContent[];
};

function projectToolShape(
  name: string,
  input: unknown,
  kind?: Kind,
  supportsTerminalOutput = false,
): ProjectedToolShape {
  const record =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const fallback = getToolUseDisplayMetadata(name, record);
  const locations = extractLocationsFromInput(input);

  if (name === WRITE_FILE_TOOL_NAME) {
    const path = stringField(record, 'file_path', 'path') ?? 'file';
    const content = stringField(record, 'content') ?? '';
    return {
      title: `Write ${path}`,
      kind: 'edit',
      locations: locations.length > 0 ? locations : [{ path }],
      content: [
        {
          type: 'diff',
          path,
          oldText: null,
          newText: content,
        },
      ],
    };
  }

  if (name === EDIT_TOOL_NAME || kind === Kind.Edit) {
    const path = stringField(record, 'file_path', 'path') ?? 'file';
    return {
      title: `Edit ${path}`,
      kind: 'edit',
      locations: locations.length > 0 ? locations : [{ path }],
      content: [
        {
          type: 'diff',
          path,
          oldText: stringField(record, 'old_string', 'oldText') ?? '',
          newText: stringField(record, 'new_string', 'newText') ?? '',
        },
      ],
    };
  }

  if (name === READ_FILE_TOOL_NAME || kind === Kind.Read) {
    const path = stringField(record, 'file_path', 'path');
    return {
      title: path ? `Read ${path}` : fallback.displayName,
      kind: 'read',
      locations,
      content: textContent(formatObject(input)),
    };
  }

  if (isShellTool(name) || kind === Kind.Execute) {
    const command = stringField(record, 'command') ?? fallback.displayName;
    return {
      title: command,
      kind: 'execute',
      locations,
      content: supportsTerminalOutput ? [] : textContent(command),
    };
  }

  if (
    name === GLOB_TOOL_NAME ||
    name === GREP_TOOL_NAME ||
    kind === Kind.Search
  ) {
    const query = stringField(record, 'pattern', 'query') ?? fallback.displayName;
    return {
      title: `Search ${query}`,
      kind: 'search',
      locations,
      content: textContent(formatObject(input)),
    };
  }

  if (kind === Kind.Fetch || hasUrl(record)) {
    const target = stringField(record, 'url', 'query') ?? fallback.displayName;
    return {
      title: `Fetch ${target}`,
      kind: 'fetch',
      locations,
      content: textContent(formatObject(input)),
    };
  }

  if (name === EXIT_PLAN_MODE_TOOL_NAME) {
    return {
      title: 'Exit plan mode',
      kind: 'switch_mode',
      locations,
      content: textContent(
        stringField(record, 'plan', 'planContent') ?? formatObject(input),
      ),
    };
  }

  if (name === ASK_USER_TOOL_NAME) {
    return {
      title: 'Ask user',
      kind: 'other',
      locations,
      content: textContent(formatObject(input)),
    };
  }

  return {
    title: fallback.displayName,
    kind: kind ? toAcpToolKind(kind) : 'other',
    locations,
    content: textContent(formatObject(input)),
  };
}

function diffContentFromDisplay(display: unknown): acp.ToolCallContent | null {
  if (
    typeof display === 'object' &&
    display &&
    !('contentOmitted' in display && display.contentOmitted === true) &&
    'fileName' in display &&
    'originalContent' in display &&
    'newContent' in display &&
    typeof display.fileName === 'string' &&
    typeof display.newContent === 'string'
  ) {
    return {
      type: 'diff',
      path: display.fileName,
      oldText:
        typeof display.originalContent === 'string'
          ? display.originalContent
          : '',
      newText: display.newContent,
    };
  }

  return null;
}

function compactDiffContentFromDisplay(
  display: unknown,
): acp.ToolCallContent | null {
  let patch: string | undefined;
  if (isCompactFileToolResult(display)) {
    patch = display.diff;
  } else if (
    typeof display === 'object' &&
    display !== null &&
    'contentOmitted' in display &&
    display.contentOmitted === true &&
    'fileDiff' in display &&
    typeof display.fileDiff === 'string'
  ) {
    patch = display.fileDiff;
  }

  return patch
    ? {
        type: 'content',
        content: { type: 'text', text: markdownFence(patch, 'diff') },
      }
    : null;
}

function textContent(text: string): acp.ToolCallContent[] {
  if (!text) {
    return [];
  }
  return [{ type: 'content', content: { type: 'text', text } }];
}

function toToolResultText(display: unknown): string {
  if (typeof display === 'string') {
    return display;
  }
  if (Array.isArray(display) && display.length > 0) {
    const textBlocks: string[] = [];
    for (const item of display) {
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        textBlocks.push(item.text);
      } else {
        return JSON.stringify(display, null, 2);
      }
    }
    return textBlocks.join('\n');
  }
  return JSON.stringify(display, null, 2);
}

function formatToolResultText(
  text: string,
  toolName: string | undefined,
  supportsTerminalOutput: boolean,
  isError: boolean,
): string {
  if (isError) {
    return markdownFence(text);
  }
  if (isShellTool(toolName) && !supportsTerminalOutput) {
    return markdownFence(text.trimEnd(), 'console');
  }
  if (toolName === READ_FILE_TOOL_NAME) {
    return markdownFence(text);
  }
  return text;
}

function markdownFence(text: string, language?: string): string {
  let fence = '```';
  for (const [match] of text.matchAll(/^```+/gm)) {
    while (match.length >= fence.length) {
      fence += '`';
    }
  }
  return `${fence}${language ?? ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function formatObject(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function stringField(
  record: Record<string, unknown>,
  ...fields: string[]
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function hasUrl(record: Record<string, unknown>): boolean {
  const url = stringField(record, 'url', 'uri');
  return !!url && /^https?:\/\//.test(url);
}

function isShellTool(name?: string): boolean {
  return (
    name === SHELL_TOOL_NAME ||
    name === POWERSHELL_TOOL_NAME ||
    name === 'Bash' ||
    name === 'run_shell_command'
  );
}

function dedupeLocations(
  locations: acp.ToolCallLocation[],
): acp.ToolCallLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
