/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { WorkflowKeywordRequestAttachment } from '../models/workflow-attachments.js';
import type {
  Attachment,
  AttachmentExternalContext,
} from '../types.js';
import { WORKFLOW_TOOL_NAME } from '../../tools/tool-names.js';

const ULTRACODE_KEYWORD_PATTERN = /\bultracode\b/gi;

const IGNORED_REGION_CLOSE = {
  '`': '`',
  '"': '"',
  "'": "'",
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
} as const;

type IgnoredRegionOpen = keyof typeof IGNORED_REGION_CLOSE;

type IgnoredRegion = {
  start: number;
  end: number;
};

export function getWorkflowKeywordReminderAttachments(
  input: string | null,
  externalContext?: AttachmentExternalContext,
): Attachment[] {
  if (input === null || !containsStandaloneUltracode(input)) {
    return [];
  }
  if (!externalContext?.toolRegistry?.hasToolEnabled(WORKFLOW_TOOL_NAME)) {
    return [];
  }
  return [
    new WorkflowKeywordRequestAttachment({
      type: 'workflow_keyword_request',
    }),
  ];
}

/**
 * Match the local-TUI UltraCode keyword without treating code, paths, quoted
 * data, or property-like identifiers as an opt-in request.
 */
export function containsStandaloneUltracode(input: string): boolean {
  return findStandaloneUltracodeRanges(input).length > 0;
}

export interface UltracodeKeywordRange {
  start: number;
  end: number;
}

/** Returns every opt-in keyword range using Unicode code-point offsets. */
export function findStandaloneUltracodeRanges(
  input: string,
): UltracodeKeywordRange[] {
  if (input.startsWith('/')) return [];

  const ignored = collectIgnoredRegions(input);
  const matches: UltracodeKeywordRange[] = [];
  for (const match of input.matchAll(ULTRACODE_KEYWORD_PATTERN)) {
    const index = match.index;
    const end = index + match[0].length;

    if (ignored.some((region) => index >= region.start && index < region.end)) {
      continue;
    }

    const previous = input[index - 1];
    const next = input[end];
    if (previous === '/' || previous === '\\' || previous === '-') continue;
    if (next === '/' || next === '\\' || next === '-' || next === '?') {
      continue;
    }
    if (next === '.' && isWordCharacter(input[end + 1])) continue;
    matches.push({
      start: Array.from(input.slice(0, index)).length,
      end: Array.from(input.slice(0, end)).length,
    });
  }
  return matches;
}

function collectIgnoredRegions(input: string): IgnoredRegion[] {
  const ignored: IgnoredRegion[] = [];
  let active: IgnoredRegionOpen | undefined;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (active) {
      if (active === '[' && char === '[') {
        start = i;
        continue;
      }
      if (char !== IGNORED_REGION_CLOSE[active]) continue;
      if (active === "'" && isWordCharacter(input[i + 1])) continue;
      ignored.push({ start, end: i + 1 });
      active = undefined;
      continue;
    }

    if (isIgnoredRegionStart(char, input[i - 1], input[i + 1])) {
      active = char;
      start = i;
    }
  }
  return ignored;
}

function isIgnoredRegionStart(
  char: string,
  previous: string | undefined,
  next: string | undefined,
): char is IgnoredRegionOpen {
  if (char === '<') {
    return /[a-zA-Z/]/.test(next ?? '');
  }
  if (char === "'") {
    return !isWordCharacter(previous);
  }
  return (
    char !== '<' &&
    char !== "'" &&
    Object.prototype.hasOwnProperty.call(IGNORED_REGION_CLOSE, char)
  );
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}
