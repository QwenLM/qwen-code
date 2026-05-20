/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonToolPreview,
  DaemonTranscriptQuestion,
  DaemonTranscriptQuestionOption,
} from './types.js';
import {
  getFirstString,
  isRecord,
  isSensitiveKey,
  stringifyRedactedJson,
} from './utils.js';

const MAX_TOOL_PREVIEW_DEPTH = 8;

export function createDaemonToolPreview(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string } = {},
  depth = 0,
): DaemonToolPreview {
  if (depth > MAX_TOOL_PREVIEW_DEPTH) {
    const summary = opts.title ?? opts.toolName ?? opts.toolKind;
    return { kind: 'generic', ...(summary ? { summary } : {}) };
  }

  if (isRecord(input)) {
    const nestedInput = input['rawInput'] ?? input['input'] ?? input['args'];
    if (nestedInput !== undefined && nestedInput !== input) {
      const nested = createDaemonToolPreview(
        nestedInput,
        {
          title: opts.title ?? getFirstString(input, ['title']),
          toolName:
            opts.toolName ?? getFirstString(input, ['toolName', 'name']),
          toolKind: opts.toolKind ?? getFirstString(input, ['kind']),
        },
        depth + 1,
      );
      if (nested.kind !== 'generic' || !nested.summary) return nested;
    }
  }

  const askUserQuestions = extractAskUserQuestions(input);
  if (askUserQuestions.length > 0) {
    return { kind: 'ask_user_question', questions: askUserQuestions };
  }

  // PR-C: try specific tool-shape detectors before falling back to
  // generic command / key_value detection. Detector order matters —
  // most specific wins.
  const mcpPreview = detectMcpInvocation(input, opts);
  if (mcpPreview) return mcpPreview;

  const fileDiff = detectFileDiff(input);
  if (fileDiff) return fileDiff;

  const fileRead = detectFileRead(input, opts);
  if (fileRead) return fileRead;

  const webFetch = detectWebFetch(input);
  if (webFetch) return webFetch;

  if (isRecord(input)) {
    const command = getFirstString(input, ['command', 'cmd']);
    if (command) {
      const cwd = getFirstString(input, [
        'cwd',
        'directory',
        'workingDirectory',
      ]);
      return { kind: 'command', command, ...(cwd ? { cwd } : {}) };
    }

    const rows = collectPreviewRows(input);
    if (rows.length > 0) {
      return { kind: 'key_value', rows };
    }
  }

  const summary = opts.title ?? opts.toolName ?? opts.toolKind;
  return { kind: 'generic', ...(summary ? { summary } : {}) };
}

/**
 * Detect file-edit tool calls by signature. Matches:
 *
 * - Anthropic-style: `oldText` + `newText` (or `old_str` + `new_str`)
 * - Aider-style: `patch` text
 * - All variants require a `path` / `filePath` field.
 */
function detectFileDiff(input: unknown): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const path = getFirstString(input, [
    'path',
    'filePath',
    'file_path',
    'absolutePath',
  ]);
  if (!path) return undefined;
  const oldText = getFirstString(input, [
    'oldText',
    'old_text',
    'old_str',
    'oldString',
  ]);
  const newText = getFirstString(input, [
    'newText',
    'new_text',
    'new_str',
    'newString',
    'content',
  ]);
  const patch = getFirstString(input, ['patch', 'diff', 'unified_diff']);
  // Require at least one of: oldText+newText pair (edit), patch (apply),
  // newText (write). Pure path with no diff content → not a diff preview.
  if (!oldText && !newText && !patch) return undefined;
  return {
    kind: 'file_diff',
    path,
    ...(oldText ? { oldText } : {}),
    ...(newText ? { newText } : {}),
    ...(patch ? { patch } : {}),
  };
}

/**
 * Detect file-read tool calls. Requires a path-like field and either an
 * explicit read intent (toolName matches /read/i) OR optional range
 * fields (lineRange / offset+limit).
 */
function detectFileRead(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const path = getFirstString(input, [
    'path',
    'filePath',
    'file_path',
    'absolutePath',
  ]);
  if (!path) return undefined;
  const toolName = opts.toolName ?? getFirstString(input, ['toolName', 'name']);
  const looksLikeRead =
    toolName !== undefined && /read|view|cat/i.test(toolName);
  // Range extraction: prefer explicit lineRange tuple, fall back to
  // offset+limit pair.
  const rangeArr = input['lineRange'] ?? input['line_range'] ?? input['range'];
  let range: readonly [number, number] | undefined;
  if (
    Array.isArray(rangeArr) &&
    rangeArr.length === 2 &&
    typeof rangeArr[0] === 'number' &&
    typeof rangeArr[1] === 'number'
  ) {
    range = [rangeArr[0], rangeArr[1]] as const;
  } else {
    const offset = input['offset'];
    const limit = input['limit'];
    if (typeof offset === 'number' && typeof limit === 'number' && limit > 0) {
      range = [offset, offset + limit - 1] as const;
    }
  }
  if (!looksLikeRead && !range) return undefined;
  return {
    kind: 'file_read',
    path,
    ...(range ? { range } : {}),
  };
}

/**
 * Detect web_fetch tool calls. Matches a URL field plus optional method.
 */
function detectWebFetch(input: unknown): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const url = getFirstString(input, ['url', 'uri', 'href']);
  if (!url) return undefined;
  // Require a `url` scheme to avoid false positives on relative paths.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return undefined;
  const method = getFirstString(input, ['method', 'httpMethod']);
  return {
    kind: 'web_fetch',
    url,
    ...(method ? { method } : {}),
  };
}

/**
 * Detect MCP-invocation tool calls. Uses the `mcp__<server>__<tool>`
 * naming convention from the provenance heuristic — same one introduced
 * for `DaemonUiToolUpdateEvent.provenance` in PR-A. Lets the preview
 * carry server + tool name structurally instead of as a generic title.
 */
function detectMcpInvocation(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  const toolName =
    opts.toolName ??
    (isRecord(input) ? getFirstString(input, ['toolName', 'name']) : undefined);
  if (!toolName || !toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return undefined;
  const serverId = rest.slice(0, sep);
  const toolPart = rest.slice(sep + 2);
  // Summarize args for inline display — first key=value when possible.
  let argsSummary: string | undefined;
  if (isRecord(input)) {
    const args = input['arguments'] ?? input['args'] ?? input;
    if (isRecord(args)) {
      const firstEntry = Object.entries(args)
        .filter(([key]) => key !== 'name' && key !== 'toolName')
        .slice(0, 1)
        .map(([key, value]) => {
          const v = typeof value === 'string' ? value : JSON.stringify(value);
          const trimmed = v.length > 60 ? `${v.slice(0, 60)}…` : v;
          return `${key}=${trimmed}`;
        })[0];
      if (firstEntry) argsSummary = firstEntry;
    }
  }
  return {
    kind: 'mcp_invocation',
    serverId,
    toolName: toolPart,
    ...(argsSummary ? { argsSummary } : {}),
  };
}

function extractAskUserQuestions(input: unknown): DaemonTranscriptQuestion[] {
  if (!isRecord(input) || !Array.isArray(input['questions'])) return [];
  return input['questions'].filter(isRecord).map((question) => {
    const header = getFirstString(question, ['header', 'title', 'label']);
    const prompt =
      getFirstString(question, ['question', 'prompt', 'text']) ?? 'Question';
    const options = Array.isArray(question['options'])
      ? question['options'].filter(isRecord).map(normalizeQuestionOption)
      : [];
    return {
      ...(header ? { header } : {}),
      question: prompt,
      options,
      raw: question,
    };
  });
}

function normalizeQuestionOption(
  option: Record<string, unknown>,
): DaemonTranscriptQuestionOption {
  const label = getFirstString(option, ['label', 'title', 'value']) ?? 'Option';
  const description = getFirstString(option, ['description', 'detail', 'text']);
  return {
    label,
    ...(description ? { description } : {}),
    raw: option,
  };
}

function collectPreviewRows(
  input: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const candidates: Array<[string, readonly string[]]> = [
    ['Path', ['path', 'filePath', 'file_path', 'absolutePath']],
    ['Cwd', ['cwd', 'directory', 'workingDirectory']],
    ['Query', ['query', 'pattern', 'search']],
    ['Note', ['description', 'reason']],
  ];

  for (const [label, keys] of candidates) {
    const value = getFirstString(input, keys);
    if (value) rows.push({ label, value });
  }

  if (rows.length > 0) return rows;

  for (const [key, value] of Object.entries(input).slice(0, 4)) {
    if (value === undefined || value === null || Array.isArray(value)) continue;
    if (isRecord(value)) continue;
    rows.push({
      label: key,
      value: isSensitiveKey(key) ? '[redacted]' : stringifyRedactedJson(value),
    });
  }
  return rows;
}
