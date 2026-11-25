/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
  extractSlashCommandToken,
  extractCommandStyleToken,
  extractPotentialCommandStyleToken,
} from './slashCommandToken.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

const mockedExistsSync = vi.mocked(existsSync);

describe('slashCommandToken', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
  });

  describe('extractSlashCommandToken', () => {
    it('returns the command name for a plain slash command', () => {
      expect(extractSlashCommandToken('/model')).toBe('model');
      expect(extractSlashCommandToken('  /model sonnet  ')).toBe('model');
    });

    it('accepts the full command-name character set', () => {
      expect(extractSlashCommandToken('/server:prompt')).toBe('server:prompt');
      expect(extractSlashCommandToken('/my_command-2')).toBe('my_command-2');
    });

    it('returns null for nested paths', () => {
      expect(extractSlashCommandToken('/etc/hosts')).toBeNull();
      expect(extractSlashCommandToken('/home/user/x.txt')).toBeNull();
    });

    it('returns null when the token names an existing absolute path', () => {
      mockedExistsSync.mockReturnValue(true);
      expect(extractSlashCommandToken('/tmp')).toBeNull();
      expect(mockedExistsSync).toHaveBeenCalledWith('/tmp');
    });

    it('returns null for unsupported character sets', () => {
      expect(extractSlashCommandToken('/über')).toBeNull();
      expect(extractSlashCommandToken('/hello world')).toBe('hello');
      expect(extractSlashCommandToken('/')).toBeNull();
    });

    it('returns null for input that is not slash-prefixed', () => {
      expect(extractSlashCommandToken('model')).toBeNull();
      expect(extractSlashCommandToken('?help')).toBeNull();
    });
  });

  describe('extractCommandStyleToken', () => {
    it('accepts both the slash and question-mark prefixes', () => {
      expect(extractCommandStyleToken('/help')).toBe('help');
      expect(extractCommandStyleToken('?help')).toBe('help');
      expect(extractCommandStyleToken('  ?help me  ')).toBe('help');
    });

    it('applies the same rejections as the slash-only variant', () => {
      expect(extractCommandStyleToken('/etc/hosts')).toBeNull();
      expect(extractCommandStyleToken('?über')).toBeNull();
      expect(extractCommandStyleToken('help')).toBeNull();
    });
  });

  describe('extractPotentialCommandStyleToken', () => {
    it('keeps ambiguous root paths and non-ASCII names until catalog resolution', () => {
      expect(extractPotentialCommandStyleToken('/tmp')).toBe('tmp');
      expect(extractPotentialCommandStyleToken('/中文命令')).toBe('中文命令');
    });

    it('rejects unambiguous paths and source-code comments', () => {
      expect(extractPotentialCommandStyleToken('/Users/me/project')).toBeNull();
      expect(extractPotentialCommandStyleToken('// comment')).toBeNull();
      expect(extractPotentialCommandStyleToken('/* comment */')).toBeNull();
    });
  });
});
