/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LSTool } from './ls.js';
import type { LSToolParams } from './ls.js';
import type { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { ToolErrorType } from './tool-error.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { shortenPath } from '../utils/paths.js';

describe('LSTool', () => {
  let lsTool: LSTool;
  let tempRootDir: string;
  let tempSecondaryDir: string;
  let mockConfig: Config;
  const abortSignal = new AbortController().signal;

  const run = (params: LSToolParams, tool = lsTool) =>
    tool.build(params).execute(abortSignal);
  const toolWith = (overrides: object) =>
    new LSTool({ ...mockConfig, ...overrides } as unknown as Config);
  async function writeFiles(dir: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content);
    }
  }

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-tool-root-'));
    tempSecondaryDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ls-tool-secondary-'),
    );

    const mockWorkspaceContext = createMockWorkspaceContext(tempRootDir, [
      tempSecondaryDir,
    ]);

    const userSkillsBase = path.join(os.homedir(), '.qwen', 'skills');

    mockConfig = {
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () => mockWorkspaceContext,
      getFileService: () => new FileDiscoveryService(tempRootDir),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      getTruncateToolOutputLines: () => 1000,
      storage: {
        getUserSkillsDirs: () => [userSkillsBase],
      },
    } as unknown as Config;

    lsTool = new LSTool(mockConfig);
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
    await fs.rm(tempSecondaryDir, { recursive: true, force: true });
  });

  describe('parameter validation', () => {
    it('should accept valid absolute paths within workspace', async () => {
      const testPath = path.join(tempRootDir, 'src');
      await fs.mkdir(testPath);
      expect(lsTool.build({ path: testPath })).toBeDefined();
    });

    it('should reject relative paths', () => {
      expect(() => lsTool.build({ path: './src' })).toThrow(
        'Path must be absolute: ./src',
      );
    });

    it('should allow paths outside workspace (external path support)', () => {
      expect(lsTool.build({ path: '/etc' })).toBeDefined();
    });

    it('should accept paths in secondary workspace directory', async () => {
      const testPath = path.join(tempSecondaryDir, 'lib');
      await fs.mkdir(testPath);
      expect(lsTool.build({ path: testPath })).toBeDefined();
    });
  });

  describe('getDefaultPermission', () => {
    it('should return allow for paths within workspace', async () => {
      const invocation = lsTool.build({ path: tempRootDir });
      expect(await invocation.getDefaultPermission()).toBe('allow');
    });

    it('should return ask for paths outside workspace', async () => {
      const invocation = lsTool.build({ path: '/tmp' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    });
  });

  describe('execute', () => {
    it('should list files in a directory', async () => {
      await writeFiles(tempRootDir, { 'file1.txt': 'content1' });
      await fs.mkdir(path.join(tempRootDir, 'subdir'));
      await writeFiles(tempSecondaryDir, { 'secondary-file.txt': 'secondary' });

      const result = await run({ path: tempRootDir });

      expect(result.llmContent).toContain('[DIR] subdir');
      expect(result.llmContent).toContain('file1.txt');
      expect(result.returnDisplay).toBe('Listed 2 item(s)');
    });

    it('should list files from secondary workspace directory', async () => {
      await writeFiles(tempRootDir, { 'file1.txt': 'content1' });
      await fs.mkdir(path.join(tempRootDir, 'subdir'));
      await writeFiles(tempSecondaryDir, { 'secondary-file.txt': 'secondary' });

      const result = await run({ path: tempSecondaryDir });

      expect(result.llmContent).toContain('secondary-file.txt');
      expect(result.returnDisplay).toBe('Listed 1 item(s)');
    });

    it('should handle empty directories', async () => {
      const emptyDir = path.join(tempRootDir, 'empty');
      await fs.mkdir(emptyDir);
      const result = await run({ path: emptyDir });

      expect(result.llmContent).toBe(`Directory ${emptyDir} is empty.`);
      expect(result.returnDisplay).toBe('Directory is empty.');
    });

    it('should respect ignore patterns', async () => {
      await writeFiles(tempRootDir, {
        'file1.txt': 'content1',
        'file2.log': 'content1',
      });

      const result = await run({ path: tempRootDir, ignore: ['*.log'] });

      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).not.toContain('file2.log');
      expect(result.returnDisplay).toBe('Listed 1 item(s)');
    });

    it('should respect gitignore patterns', async () => {
      await writeFiles(tempRootDir, {
        'file1.txt': 'content1',
        'file2.log': 'content1',
        '.git': '',
        '.gitignore': '*.log',
      });
      const result = await run({ path: tempRootDir });

      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).not.toContain('file2.log');
      // .git is always ignored by default.
      expect(result.returnDisplay).toBe('Listed 2 item(s) (2 git-ignored)');
    });

    it('should respect qwenignore patterns', async () => {
      await writeFiles(tempRootDir, {
        'file1.txt': 'content1',
        'file2.log': 'content1',
        '.qwenignore': '*.log',
      });
      const result = await run({ path: tempRootDir });

      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).not.toContain('file2.log');
      expect(result.returnDisplay).toBe('Listed 2 item(s) (1 qwen-ignored)');
    });

    it('should respect agent and ai ignore patterns', async () => {
      await writeFiles(tempRootDir, {
        'file1.txt': 'content1',
        'agent-secret.log': 'content',
        'ai-secret.log': 'content',
        '.agentignore': 'agent-secret.log',
        '.aiignore': 'ai-secret.log',
      });
      const result = await run({ path: tempRootDir });

      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).not.toContain('agent-secret.log');
      expect(result.llmContent).not.toContain('ai-secret.log');
      expect(result.returnDisplay).toBe('Listed 3 item(s) (2 qwen-ignored)');
    });

    it('should respect configured custom qwen ignore files', async () => {
      await writeFiles(tempRootDir, {
        'file1.txt': 'content1',
        'cursor-secret.log': 'content',
        'agent-secret.log': 'content',
        '.cursorignore': 'cursor-secret.log',
        '.agentignore': 'agent-secret.log',
      });
      const customLsTool = toolWith({
        getFileService: () =>
          new FileDiscoveryService(tempRootDir, ['.cursorignore']),
        getFileFilteringOptions: () => ({
          respectGitIgnore: true,
          respectQwenIgnore: true,
          customIgnoreFiles: ['.cursorignore'],
        }),
      });

      const result = await run({ path: tempRootDir }, customLsTool);

      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).toContain('agent-secret.log');
      expect(result.llmContent).not.toContain('cursor-secret.log');
      expect(result.returnDisplay).toBe('Listed 4 item(s) (1 qwen-ignored)');
    });

    it('should handle non-directory paths', async () => {
      const testPath = path.join(tempRootDir, 'file1.txt');
      await fs.writeFile(testPath, 'content1');

      const result = await run({ path: testPath });

      expect(result.llmContent).toContain('Path is not a directory');
      expect(result.returnDisplay).toBe('Error: Path is not a directory.');
      expect(result.error?.type).toBe(ToolErrorType.PATH_IS_NOT_A_DIRECTORY);
    });

    it('should handle non-existent paths', async () => {
      const result = await run({
        path: path.join(tempRootDir, 'does-not-exist'),
      });

      expect(result.llmContent).toContain('Error listing directory');
      expect(result.returnDisplay).toBe('Error: Failed to list directory.');
      expect(result.error?.type).toBe(ToolErrorType.LS_EXECUTION_ERROR);
    });

    it('should sort directories first, then files alphabetically', async () => {
      await writeFiles(tempRootDir, {
        'a-file.txt': 'content1',
        'b-file.txt': 'content1',
      });
      await fs.mkdir(path.join(tempRootDir, 'x-dir'));
      await fs.mkdir(path.join(tempRootDir, 'y-dir'));

      const result = await run({ path: tempRootDir });

      const lines = (
        typeof result.llmContent === 'string' ? result.llmContent : ''
      )
        .split('\n')
        .filter((l) => l.trim() && l.trim() !== '---');
      const entries = lines.slice(1); // Skip header

      expect(entries[0]).toBe('[DIR] x-dir');
      expect(entries[1]).toBe('[DIR] y-dir');
      expect(entries[2]).toBe('a-file.txt');
      expect(entries[3]).toBe('b-file.txt');
    });

    it('should handle permission errors gracefully', async () => {
      const restrictedDir = path.join(tempRootDir, 'restricted');
      await fs.mkdir(restrictedDir);

      // Cross-platform permission error: mock fs.readdir to throw.
      const error = new Error('EACCES: permission denied');
      vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error);

      const result = await run({ path: restrictedDir });

      expect(result.llmContent).toContain('Error listing directory');
      expect(result.llmContent).toContain('permission denied');
      expect(result.returnDisplay).toBe('Error: Failed to list directory.');
      expect(result.error?.type).toBe(ToolErrorType.LS_EXECUTION_ERROR);
    });

    it('should throw for invalid params at build time', () => {
      expect(() => lsTool.build({ path: '../outside' })).toThrow(
        'Path must be absolute: ../outside',
      );
    });

    it('should handle errors accessing individual files during listing', async () => {
      await fs.writeFile(path.join(tempRootDir, 'file1.txt'), 'content1');
      const problematicFile = path.join(tempRootDir, 'problematic.txt');
      await fs.writeFile(problematicFile, 'content2');

      // Fail fs.stat for one file: cross-platform, and avoids
      // platform-specific behavior with things like dangling symlinks.
      const originalStat = fs.stat;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
        if (p.toString() === problematicFile) {
          throw new Error('Simulated stat error');
        }
        return originalStat(p);
      });

      const result = await run({ path: tempRootDir });

      // Should still list the other files
      expect(result.llmContent).toContain('file1.txt');
      expect(result.llmContent).not.toContain('problematic.txt');
      expect(result.returnDisplay).toBe('Listed 1 item(s)');

      statSpy.mockRestore();
    });
  });

  describe('truncation', () => {
    it('should truncate when entries exceed config line limit', async () => {
      const lowLimitTool = toolWith({ getTruncateToolOutputLines: () => 5 });

      await writeNumbered(10, (i) => `file${String(i).padStart(2, '0')}.txt`);

      const result = await run({ path: tempRootDir }, lowLimitTool);

      expect(result.llmContent).toContain('[5 items truncated]');
      expect(result.returnDisplay).toBe('Listed 10 item(s) (truncated)');
    });

    it('should not truncate when entries are within limit', async () => {
      await writeNumbered(3, (i) => `file${i}.txt`);

      const result = await run({ path: tempRootDir });

      expect(result.llmContent).not.toContain('truncated');
      expect(result.returnDisplay).toBe('Listed 3 item(s)');
    });

    it('should use singular "entry" when exactly one entry is truncated', async () => {
      const lowLimitTool = toolWith({ getTruncateToolOutputLines: () => 2 });
      await writeNumbered(3, (i) => `file${i}.txt`);

      const result = await run({ path: tempRootDir }, lowLimitTool);

      expect(result.llmContent).toContain('[1 item truncated]');
    });

    async function writeNumbered(count: number, name: (i: number) => string) {
      for (let i = 0; i < count; i++) {
        await fs.writeFile(path.join(tempRootDir, name(i)), `content${i}`);
      }
    }
  });

  describe('getDescription', () => {
    it('should return shortened relative path', () => {
      const deeplyNestedDir = path.join(tempRootDir, 'deeply', 'nested');
      const invocation = lsTool.build({
        path: path.join(deeplyNestedDir, 'directory'),
      });
      expect(invocation.getDescription()).toBe(
        path.join('deeply', 'nested', 'directory'),
      );
    });

    it('should handle paths in secondary workspace', () => {
      const params = { path: path.join(tempSecondaryDir, 'lib') };
      const description = lsTool.build(params).getDescription();
      expect(description).toBe(shortenPath(path.resolve(params.path)));
    });
  });

  describe('workspace boundary validation', () => {
    // Accepting primary/secondary/external paths is covered by the identical
    // cases under 'parameter validation'.
    it('should list files from secondary workspace directory', async () => {
      await writeFiles(tempSecondaryDir, { 'secondary-file.txt': 'secondary' });

      const result = await run({ path: tempSecondaryDir });

      expect(result.llmContent).toContain('secondary-file.txt');
      expect(result.returnDisplay).toBe('Listed 1 item(s)');
    });
  });

  describe('validateToolParams', () => {
    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped path',
      async () => {
        // Create a directory with a space so the unescaped path exists
        const dirWithSpace = path.join(tempRootDir, 'sub dir');
        await fs.mkdir(dirWithSpace);
        const params: LSToolParams = {
          path: path.join(tempRootDir, 'sub\\ dir'),
        };
        const result = lsTool.validateToolParams(params);
        expect(result).toBeNull();
        expect(params.path).toBe(dirWithSpace);
      },
    );
  });
});
