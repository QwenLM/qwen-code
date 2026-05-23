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
