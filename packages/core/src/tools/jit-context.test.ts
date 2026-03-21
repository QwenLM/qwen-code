/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverJitContext,
  appendJitContext,
  appendJitContextToParts,
  resetJitContextState,
  JIT_CONTEXT_PREFIX,
  JIT_CONTEXT_SUFFIX,
} from './jit-context.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('jit-context', () => {
  let tempDir: string;

  beforeEach(() => {
    resetJitContextState();
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'jit-ctx-')),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('discoverJitContext', () => {
    it('should return empty string when no context files exist', async () => {
      fs.writeFileSync(path.join(tempDir, 'file.ts'), 'const x = 1;');
      const result = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'file.ts'),
      );
      expect(result).toBe('');
    });

    it('should discover AGENTS.md in the same directory as the accessed file', async () => {
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENTS.md'),
        'Use strict mode always.',
      );
      fs.writeFileSync(path.join(subDir, 'file.ts'), 'const x = 1;');

      const result = await discoverJitContext(
        [tempDir],
        path.join(subDir, 'file.ts'),
      );
      expect(result).toContain('Use strict mode always.');
    });

    it('should discover context files in parent directories up to workspace root', async () => {
      const subDir = path.join(tempDir, 'src', 'deep');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'Root-level context.');
      fs.writeFileSync(path.join(subDir, 'file.ts'), '');

      const result = await discoverJitContext(
        [tempDir],
        path.join(subDir, 'file.ts'),
      );
      expect(result).toContain('Root-level context.');
    });

    it('should NOT traverse above the workspace root', async () => {
      const parentContext = path.join(path.dirname(tempDir), 'AGENTS.md');
      let createdParent = false;
      try {
        fs.writeFileSync(parentContext, 'Should NOT be found.');
        createdParent = true;
      } catch {
        // May not have permission, skip
      }

      const result = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'file.ts'),
      );
      expect(result).not.toContain('Should NOT be found.');

      if (createdParent) {
        fs.unlinkSync(parentContext);
      }
    });

    it('should deduplicate — same file not injected twice across calls', async () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'Only once.');
      fs.writeFileSync(path.join(tempDir, 'a.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'b.ts'), '');

      const first = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'a.ts'),
      );
      expect(first).toContain('Only once.');

      const second = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'b.ts'),
      );
      expect(second).toBe('');
    });

    it('should reset dedup state when resetJitContextState is called', async () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'Context.');
      fs.writeFileSync(path.join(tempDir, 'file.ts'), '');

      const first = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'file.ts'),
      );
      expect(first).toContain('Context.');

      resetJitContextState();

      const afterReset = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'file.ts'),
      );
      expect(afterReset).toContain('Context.');
    });

    it('should silently return empty string on errors (never break the tool)', async () => {
      const result = await discoverJitContext(
        ['/nonexistent/root'],
        '/nonexistent/path/file.ts',
      );
      expect(result).toBe('');
    });

    it('should ignore empty/whitespace-only context files', async () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '   \n  \n  ');
      fs.writeFileSync(path.join(tempDir, 'file.ts'), '');

      const result = await discoverJitContext(
        [tempDir],
        path.join(tempDir, 'file.ts'),
      );
      expect(result).toBe('');
    });

    it('should work with directory paths (not just file paths)', async () => {
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'AGENTS.md'), 'Dir context.');

      const result = await discoverJitContext([tempDir], subDir);
      expect(result).toContain('Dir context.');
    });

    it('should concatenate multiple context files from different levels', async () => {
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'AGENTS.md'), 'Leaf context.');
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'Root context.');
      fs.writeFileSync(path.join(subDir, 'file.ts'), '');

      const result = await discoverJitContext(
        [tempDir],
        path.join(subDir, 'file.ts'),
      );
      expect(result).toContain('Leaf context.');
      expect(result).toContain('Root context.');
    });

    it('should accept Config object and extract workspace dirs', async () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), 'Config test.');
      fs.writeFileSync(path.join(tempDir, 'file.ts'), '');

      const mockConfig = {
        getWorkspaceContext: () => ({
          getDirectories: () => [tempDir],
        }),
      } as unknown as import('../config/config.js').Config;

      const result = await discoverJitContext(
        mockConfig,
        path.join(tempDir, 'file.ts'),
      );
      expect(result).toContain('Config test.');
    });
  });

  describe('appendJitContext', () => {
    it('should return original content when jitContext is empty', () => {
      expect(appendJitContext('file contents', '')).toBe('file contents');
    });

    it('should append delimited context when non-empty', () => {
      const result = appendJitContext('original', 'new context');
      expect(result).toContain('original');
      expect(result).toContain(JIT_CONTEXT_PREFIX);
      expect(result).toContain('new context');
      expect(result).toContain(JIT_CONTEXT_SUFFIX);
    });

    it('should place context after original content', () => {
      const result = appendJitContext('AAA', 'BBB');
      expect(result.indexOf('AAA')).toBeLessThan(result.indexOf('BBB'));
    });
  });

  describe('appendJitContextToParts', () => {
    it('should add a text part with delimited context', () => {
      const parts = appendJitContextToParts(['existing text'], 'ctx');
      expect(parts).toHaveLength(2);
      const textPart = parts[1] as { text: string };
      expect(textPart.text).toContain('ctx');
      expect(textPart.text).toContain('Newly Discovered Project Context');
    });

    it('should wrap non-array content into array', () => {
      const parts = appendJitContextToParts('single string', 'ctx');
      expect(parts).toHaveLength(2);
    });
  });
});
