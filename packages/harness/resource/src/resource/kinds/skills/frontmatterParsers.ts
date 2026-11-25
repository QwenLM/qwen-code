/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EffortLevel, EffortValue } from './types.js';

const EFFORT_LEVELS: readonly EffortLevel[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const EFFORT_ALIASES: Record<string, EffortLevel> = {
  off: 'none',
  disabled: 'none',
};

export function parseToolListFromCLI(tools: string[]): string[] {
  const result: string[] = [];

  for (const tool of tools) {
    let current = '';
    let depth = 0;

    for (const ch of tool) {
      if (ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if ((ch === ',' || ch === ' ') && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) result.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }

    const trimmed = current.trim();
    if (trimmed) result.push(trimmed);
  }

  return result;
}

export function parseToolListString(toolsValue: unknown): string[] | null {
  if (toolsValue === undefined || toolsValue === null) {
    return null;
  }

  if (typeof toolsValue === 'string') {
    if (toolsValue.trim() === '*') return ['*'];
    return parseToolListFromCLI([toolsValue]);
  }

  if (Array.isArray(toolsValue)) {
    const stringItems = toolsValue.filter(
      (item): item is string => typeof item === 'string',
    );
    if (stringItems.length === 0) return null;
    return parseToolListFromCLI(stringItems);
  }

  return null;
}

export function parseSlashCommandToolsFromFrontmatter(
  toolsValue: unknown,
): string[] {
  return parseToolListString(toolsValue) ?? [];
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    const aliased = EFFORT_ALIASES[normalized];
    if (aliased) return aliased;
    if ((EFFORT_LEVELS as readonly string[]).includes(normalized)) {
      return normalized as EffortLevel;
    }
    const num = Number(normalized);
    if (Number.isInteger(num) && num > 0) return num;
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  return undefined;
}

export function parseBooleanFrontmatter(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.toLowerCase().trim() === 'true') {
    return true;
  }
  return false;
}
