/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  matchesToolPattern,
  splitCompoundCommandSegments,
} from './rule-parser.js';
import type { CompoundCommandSegment } from './rule-parser.js';

// A lone CR right after a clobber operator is the whole redirect target: bash
// writes a file named `\r`, so the CR stays in the segment instead of being
// dropped as a line ending. `1>|` and `2>|` name it exactly as `>|` does.
describe('splitCompoundCommandSegments', () => {
  it.each<[title: string, command: string, expected: CompoundCommandSegment[]]>(
    [
      [
        '1>|',
        'cat 1>|\r\necho hi',
        [
          { command: 'cat 1>|\r', terminator: '\n' },
          { command: 'echo hi', terminator: '' },
        ],
      ],
      [
        '2>|',
        'cat 2>|\r\necho hi',
        [
          { command: 'cat 2>|\r', terminator: '\n' },
          { command: 'echo hi', terminator: '' },
        ],
      ],
    ],
  )('keeps the CR target behind %s', (_title, command, expected) => {
    expect(splitCompoundCommandSegments(command)).toEqual(expected);
  });
});

// The predicate a subagent's declaration filter applies to each deny entry,
// and that callers predicting the filter share.
describe('matchesToolPattern', () => {
  it.each([
    ['an exact built-in name', 'run_shell_command', 'run_shell_command', true],
    ['another built-in name', 'write_file', 'run_shell_command', false],
    [
      'an exact MCP tool name',
      'mcp__github__create_issue',
      'mcp__github__create_issue',
      true,
    ],
    [
      'a server-level MCP pattern',
      'mcp__github',
      'mcp__github__create_issue',
      true,
    ],
    [
      'an MCP server wildcard',
      'mcp__github__*',
      'mcp__github__create_issue',
      true,
    ],
    ['another MCP server', 'mcp__slack', 'mcp__github__create_issue', false],
  ])('%s', (_label, pattern, toolName, expected) => {
    expect(matchesToolPattern(pattern, toolName)).toBe(expected);
  });

  // Patterns are an MCP-only form: a built-in tool is matched by exact name.
  it('does not treat a pattern-shaped entry as a pattern for a built-in tool', () => {
    expect(matchesToolPattern('run_*', 'run_shell_command')).toBe(false);
  });
});
