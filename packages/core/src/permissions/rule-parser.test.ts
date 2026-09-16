/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesToolPattern } from './rule-parser.js';

describe('matchesToolPattern for deny lists', () => {
  it.each([
    ['read_file', 'read_file', true],
    ['read_file', 'write_file', false],
    ['read_*', 'read_file', false],
    ['*', 'read_file', false],
    ['mcp__warehouse', 'mcp__warehouse__query', true],
    ['mcp__warehouse__*', 'mcp__warehouse__query', true],
    ['mcp__warehouse__query', 'mcp__warehouse__query', true],
    ['mcp__warehouse__query', 'mcp__warehouse__schema', false],
    ['mcp__warehouse', 'mcp__other__query', false],
    // Denies preserve conservative legacy MCP matching, unlike allowlists.
    ['mcp__ext', 'mcp__ext__github__query', true],
  ])('matches %s against %s as %s', (pattern, name, expected) => {
    expect(matchesToolPattern(pattern, name)).toBe(expected);
  });
});
