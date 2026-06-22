/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import {
  buildSlashCommandItems,
  isExpandableSlashCommand,
  shouldAllowCompletionQuery,
} from './slashCommandUtils.js';

const availableCommands: AvailableCommand[] = [
  {
    name: 'export',
    description:
      'Export current session to a file. Available formats: html, md, json, jsonl.',
    input: null,
  },
  {
    name: 'help',
    description: 'Show help',
    input: null,
  },
];

describe('slashCommandUtils', () => {
  describe('shouldAllowCompletionQuery', () => {
    it('keeps slash completion open when the query contains spaces', () => {
      expect(shouldAllowCompletionQuery('/', 'export ')).toBe(true);
      expect(shouldAllowCompletionQuery('/', 'export md')).toBe(true);
    });

    it('still blocks @ completion when the query contains spaces', () => {
      expect(shouldAllowCompletionQuery('@', 'foo bar')).toBe(false);
    });
  });

  describe('buildSlashCommandItems', () => {
    it('returns top-level slash commands for prefix queries', () => {
      const items = buildSlashCommandItems('exp', availableCommands);

      expect(items.map((item) => item.id)).toContain('export');
    });

    it('returns export subcommands for an exact /export parent query', () => {
      const items = buildSlashCommandItems('export ', availableCommands);

      expect(items.map((item) => item.value)).toEqual([
        'export html',
        'export md',
        'export json',
        'export jsonl',
      ]);
    });

    it('filters export subcommands by the typed child query', () => {
      const items = buildSlashCommandItems('export j', availableCommands);

      expect(items.map((item) => item.value)).toEqual([
        'export json',
        'export jsonl',
      ]);
    });
  });

  describe('isExpandableSlashCommand', () => {
    it('marks /export as an expandable command', () => {
      expect(isExpandableSlashCommand('export')).toBe(true);
      expect(isExpandableSlashCommand('help')).toBe(false);
    });
  });
});
