/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseToolListFromCLI,
  parseToolListString,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
  parseEffortValue,
  parsePositiveIntFromFrontmatter,
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  effortToThinkingBudget,
  resolveAgentReasoning,
} from './frontmatterParsers.js';

describe('parseToolListFromCLI', () => {
  it('splits by comma', () => {
    expect(parseToolListFromCLI(['Read,Write,Edit'])).toEqual([
      'Read',
      'Write',
      'Edit',
    ]);
  });

  it('splits by space', () => {
    expect(parseToolListFromCLI(['Read Write Edit'])).toEqual([
      'Read',
      'Write',
      'Edit',
    ]);
  });

  it('splits by comma and space mixed', () => {
    expect(parseToolListFromCLI(['Read, Write Edit'])).toEqual([
      'Read',
      'Write',
      'Edit',
    ]);
  });

  it('preserves parenthesized expressions', () => {
    expect(parseToolListFromCLI(['Agent(worker, researcher), Read'])).toEqual([
      'Agent(worker, researcher)',
      'Read',
    ]);
  });

  it('handles nested parentheses', () => {
    expect(parseToolListFromCLI(['Agent(a(b, c)), Read'])).toEqual([
      'Agent(a(b, c))',
      'Read',
    ]);
  });

  it('handles multiple input strings', () => {
    expect(parseToolListFromCLI(['Read', 'Write'])).toEqual(['Read', 'Write']);
  });

  it('trims whitespace', () => {
    expect(parseToolListFromCLI(['  Read , Write  '])).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('filters empty items', () => {
    expect(parseToolListFromCLI(['Read,,Write'])).toEqual(['Read', 'Write']);
  });

  it('returns empty for empty input', () => {
    expect(parseToolListFromCLI([])).toEqual([]);
    expect(parseToolListFromCLI([''])).toEqual([]);
  });

  it('handles wildcard', () => {
    expect(parseToolListFromCLI(['*'])).toEqual(['*']);
  });

  it('handles MCP tool names with underscores', () => {
    expect(parseToolListFromCLI(['mcp__server__tool, Read'])).toEqual([
      'mcp__server__tool',
      'Read',
    ]);
  });
});

describe('parseToolListString', () => {
  it('returns null for undefined', () => {
    expect(parseToolListString(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseToolListString(null)).toBeNull();
  });

  it('handles string input', () => {
    expect(parseToolListString('Read, Write')).toEqual(['Read', 'Write']);
  });

  it('handles string array input', () => {
    expect(parseToolListString(['Read', 'Write'])).toEqual(['Read', 'Write']);
  });

  it('handles wildcard string', () => {
    expect(parseToolListString('*')).toEqual(['*']);
  });

  it('handles wildcard with whitespace', () => {
    expect(parseToolListString('  *  ')).toEqual(['*']);
  });

  it('filters non-string array items', () => {
    expect(parseToolListString([123, 'Read', null, 'Write'])).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('returns null for empty array', () => {
    expect(parseToolListString([])).toBeNull();
  });

  it('returns null for non-string/non-array types', () => {
    expect(parseToolListString(123)).toBeNull();
    expect(parseToolListString(true)).toBeNull();
    expect(parseToolListString({})).toBeNull();
  });

  it('handles YAML array with comma-separated items', () => {
    expect(parseToolListString(['Read, Write', 'Edit'])).toEqual([
      'Read',
      'Write',
      'Edit',
    ]);
  });
});

describe('parseAgentToolsFromFrontmatter', () => {
  it('returns undefined for undefined (inherit all tools)', () => {
    expect(parseAgentToolsFromFrontmatter(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(parseAgentToolsFromFrontmatter(null)).toBeUndefined();
  });

  it('parses string tools', () => {
    expect(parseAgentToolsFromFrontmatter('Read, Write')).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('parses array tools', () => {
    expect(parseAgentToolsFromFrontmatter(['Read', 'Write'])).toEqual([
      'Read',
      'Write',
    ]);
  });
});

describe('parseSlashCommandToolsFromFrontmatter', () => {
  it('returns empty array for undefined (no tools)', () => {
    expect(parseSlashCommandToolsFromFrontmatter(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(parseSlashCommandToolsFromFrontmatter(null)).toEqual([]);
  });

  it('parses string tools', () => {
    expect(parseSlashCommandToolsFromFrontmatter('Read, Write')).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('parses array tools', () => {
    expect(parseSlashCommandToolsFromFrontmatter(['Read', 'Write'])).toEqual([
      'Read',
      'Write',
    ]);
  });
});

describe('parseEffortValue', () => {
  it('returns undefined for undefined', () => {
    expect(parseEffortValue(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(parseEffortValue(null)).toBeUndefined();
  });

  it('parses named levels', () => {
    expect(parseEffortValue('low')).toBe('low');
    expect(parseEffortValue('medium')).toBe('medium');
    expect(parseEffortValue('high')).toBe('high');
    expect(parseEffortValue('max')).toBe('max');
  });

  it('parses named levels case-insensitively', () => {
    expect(parseEffortValue('Low')).toBe('low');
    expect(parseEffortValue('HIGH')).toBe('high');
    expect(parseEffortValue('  Max  ')).toBe('max');
  });

  it('parses the none level and aliases', () => {
    expect(parseEffortValue('none')).toBe('none');
    expect(parseEffortValue('NONE')).toBe('none');
    expect(parseEffortValue('off')).toBe('none');
    expect(parseEffortValue('disabled')).toBe('none');
    expect(parseEffortValue('  Off  ')).toBe('none');
  });

  it('parses numeric values', () => {
    expect(parseEffortValue(3)).toBe(3);
    expect(parseEffortValue(1024)).toBe(1024);
  });

  it('parses numeric strings', () => {
    expect(parseEffortValue('3')).toBe(3);
    expect(parseEffortValue('1024')).toBe(1024);
  });

  it('rejects non-positive or non-integer numbers', () => {
    expect(parseEffortValue(0)).toBeUndefined();
    expect(parseEffortValue(-1)).toBeUndefined();
    expect(parseEffortValue(1.5)).toBeUndefined();
  });

  it('rejects invalid strings', () => {
    expect(parseEffortValue('invalid')).toBeUndefined();
    expect(parseEffortValue('')).toBeUndefined();
    expect(parseEffortValue('1.5')).toBeUndefined();
  });

  it('rejects other types', () => {
    expect(parseEffortValue(true)).toBeUndefined();
    expect(parseEffortValue([])).toBeUndefined();
    expect(parseEffortValue({})).toBeUndefined();
  });
});

describe('parsePositiveIntFromFrontmatter', () => {
  it('returns undefined for undefined/null', () => {
    expect(parsePositiveIntFromFrontmatter(undefined)).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter(null)).toBeUndefined();
  });

  it('parses positive integers', () => {
    expect(parsePositiveIntFromFrontmatter(1)).toBe(1);
    expect(parsePositiveIntFromFrontmatter(100)).toBe(100);
  });

  it('parses string numbers', () => {
    expect(parsePositiveIntFromFrontmatter('5')).toBe(5);
    expect(parsePositiveIntFromFrontmatter(' 10 ')).toBe(10);
  });

  it('rejects non-positive or non-integer values', () => {
    expect(parsePositiveIntFromFrontmatter(0)).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter(-1)).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter(1.5)).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter('0')).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter('-3')).toBeUndefined();
  });

  it('rejects other types', () => {
    expect(parsePositiveIntFromFrontmatter(true)).toBeUndefined();
    expect(parsePositiveIntFromFrontmatter([])).toBeUndefined();
  });
});

describe('coerceDescriptionToString', () => {
  it('returns null for undefined/null', () => {
    expect(coerceDescriptionToString(undefined)).toBeNull();
    expect(coerceDescriptionToString(null)).toBeNull();
  });

  it('returns string as-is (trimmed)', () => {
    expect(coerceDescriptionToString('hello')).toBe('hello');
    expect(coerceDescriptionToString('  hello  ')).toBe('hello');
  });

  it('returns null for empty string', () => {
    expect(coerceDescriptionToString('')).toBeNull();
    expect(coerceDescriptionToString('   ')).toBeNull();
  });

  it('coerces numbers', () => {
    expect(coerceDescriptionToString(42)).toBe('42');
    expect(coerceDescriptionToString(0)).toBe('0');
  });

  it('coerces booleans', () => {
    expect(coerceDescriptionToString(true)).toBe('true');
    expect(coerceDescriptionToString(false)).toBe('false');
  });

  it('returns null for objects/arrays', () => {
    expect(coerceDescriptionToString({})).toBeNull();
    expect(coerceDescriptionToString([])).toBeNull();
  });
});

describe('parseBooleanFrontmatter', () => {
  it('returns true for true', () => {
    expect(parseBooleanFrontmatter(true)).toBe(true);
  });

  it('returns true for "true" string', () => {
    expect(parseBooleanFrontmatter('true')).toBe(true);
    expect(parseBooleanFrontmatter('True')).toBe(true);
    expect(parseBooleanFrontmatter('TRUE')).toBe(true);
    expect(parseBooleanFrontmatter('  true  ')).toBe(true);
  });

  it('returns false for everything else', () => {
    expect(parseBooleanFrontmatter(false)).toBe(false);
    expect(parseBooleanFrontmatter('false')).toBe(false);
    expect(parseBooleanFrontmatter('yes')).toBe(false);
    expect(parseBooleanFrontmatter(1)).toBe(false);
    expect(parseBooleanFrontmatter(null)).toBe(false);
    expect(parseBooleanFrontmatter(undefined)).toBe(false);
  });
});

describe('effortToThinkingBudget', () => {
  it('returns undefined for undefined', () => {
    expect(effortToThinkingBudget(undefined)).toBeUndefined();
  });

  it('maps named levels', () => {
    expect(effortToThinkingBudget('none')).toBe(0);
    expect(effortToThinkingBudget('low')).toBe(1024);
    expect(effortToThinkingBudget('medium')).toBe(8192);
    expect(effortToThinkingBudget('high')).toBe(24576);
    expect(effortToThinkingBudget('xhigh')).toBe(49152);
    expect(effortToThinkingBudget('max')).toBe(65536);
  });

  it('passes through numeric values', () => {
    expect(effortToThinkingBudget(3)).toBe(3);
    expect(effortToThinkingBudget(4096)).toBe(4096);
  });
});

describe('resolveAgentReasoning', () => {
  it('preserves a named frontmatter effort', () => {
    expect(resolveAgentReasoning('low', undefined)).toEqual({
      thinkingBudget: 1024,
      reasoningEffort: 'low',
    });
  });

  it('maps a numeric frontmatter effort to the server effort level', () => {
    expect(resolveAgentReasoning(2056, undefined)).toEqual({
      thinkingBudget: 2056,
      reasoningEffort: 'medium',
    });
  });

  it('lets configured thinking budget override frontmatter effort atomically', () => {
    expect(resolveAgentReasoning('low', 16384)).toEqual({
      thinkingBudget: 16384,
      reasoningEffort: 'high',
    });
  });

  it('supports settings-only thinking budget', () => {
    expect(resolveAgentReasoning(undefined, 49152)).toEqual({
      thinkingBudget: 49152,
      reasoningEffort: 'xhigh',
    });
  });

  it('returns undefined when neither source is configured', () => {
    expect(resolveAgentReasoning(undefined, undefined)).toBeUndefined();
  });

  it('preserves a negative dynamic-thinking sentinel without labeling it none', () => {
    expect(resolveAgentReasoning('low', -1)).toEqual({ thinkingBudget: -1 });
  });
});
