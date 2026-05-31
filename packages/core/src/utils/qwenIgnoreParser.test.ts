/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getQwenIgnoreFileNames,
  normalizeQwenCustomIgnoreFileNames,
  QwenIgnoreParser,
} from './qwenIgnoreParser.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('QwenIgnoreParser', () => {
  let projectRoot: string;

  async function createTestFile(filePath: string, content = '') {
    const fullPath = path.join(projectRoot, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenignore-test-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('when .qwenignore exists', () => {
    beforeEach(async () => {
      await createTestFile(
        '.qwenignore',
        'ignored.txt\n# A comment\n/ignored_dir/\n',
      );
      await createTestFile('ignored.txt', 'ignored');
      await createTestFile('not_ignored.txt', 'not ignored');
      await createTestFile(
        path.join('ignored_dir', 'file.txt'),
        'in ignored dir',
      );
      await createTestFile(
        path.join('subdir', 'not_ignored.txt'),
        'not ignored',
      );
    });

    it('should ignore files specified in .qwenignore', () => {
      const parser = new QwenIgnoreParser(projectRoot);
      expect(parser.getPatterns()).toEqual(['ignored.txt', '/ignored_dir/']);
      expect(parser.isIgnored('ignored.txt')).toBe(true);
      expect(parser.isIgnored('not_ignored.txt')).toBe(false);
      expect(parser.isIgnored(path.join('ignored_dir', 'file.txt'))).toBe(true);
      expect(parser.isIgnored(path.join('subdir', 'not_ignored.txt'))).toBe(
        false,
      );
    });
  });

  describe('when compatibility agent ignore files exist', () => {
    beforeEach(async () => {
      await createTestFile('.agentignore', 'agent-secret.txt\n');
      await createTestFile('.aiignore', 'ai-secret.txt\n');
      await createTestFile('agent-secret.txt', 'agent secret');
      await createTestFile('ai-secret.txt', 'ai secret');
      await createTestFile('visible.txt', 'visible');
    });

    it('should ignore files specified in .agentignore and .aiignore', () => {
      const parser = new QwenIgnoreParser(projectRoot);
      expect(parser.getPatterns()).toEqual([
        'agent-secret.txt',
        'ai-secret.txt',
      ]);
      expect(parser.isIgnored('agent-secret.txt')).toBe(true);
      expect(parser.isIgnored('ai-secret.txt')).toBe(true);
      expect(parser.isIgnored('visible.txt')).toBe(false);
    });
  });

  describe('when custom ignore files are configured', () => {
    beforeEach(async () => {
      await createTestFile('.cursorignore', 'cursor-secret.txt\n');
      await createTestFile('.agentignore', 'agent-secret.txt\n');
      await createTestFile('cursor-secret.txt', 'cursor secret');
      await createTestFile('agent-secret.txt', 'agent secret');
      await createTestFile('visible.txt', 'visible');
    });

    it('should use configured custom ignore files instead of defaults', () => {
      const parser = new QwenIgnoreParser(projectRoot, ['.cursorignore']);

      expect(parser.getIgnoreFileNames()).toEqual([
        '.qwenignore',
        '.cursorignore',
      ]);
      expect(parser.getPatterns()).toEqual(['cursor-secret.txt']);
      expect(parser.isIgnored('cursor-secret.txt')).toBe(true);
      expect(parser.isIgnored('agent-secret.txt')).toBe(false);
      expect(parser.isIgnored('visible.txt')).toBe(false);
    });
  });

  describe('custom ignore file name normalization', () => {
    it('should keep safe relative ignore files and skip unsafe paths', () => {
      expect(
        normalizeQwenCustomIgnoreFileNames([
          ' .cursorignore ',
          '.cursorignore',
          'nested\\.ignore',
          '',
          '/absolute',
          '../escape',
          'nested/../escape',
          'bad\0file',
        ]),
      ).toEqual(['.cursorignore', 'nested/.ignore']);
    });

    it('should include .qwenignore plus default custom ignore files by default', () => {
      expect(getQwenIgnoreFileNames()).toEqual([
        '.qwenignore',
        '.agentignore',
        '.aiignore',
      ]);
    });
  });

  describe('when no supported ignore file exists', () => {
    it('should not load any patterns and not ignore any files', () => {
      const parser = new QwenIgnoreParser(projectRoot);
      expect(parser.getPatterns()).toEqual([]);
      expect(parser.isIgnored('any_file.txt')).toBe(false);
    });
  });
});
