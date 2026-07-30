/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { summaryCommand } from './summaryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { runSideQuery } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    getProjectSummaryPrompt: () => 'summary prompt',
    runSideQuery: vi.fn(async () => ({ text: 'SUMMARY BODY' })),
  };
});

const makeContext = (projectRoot: string): CommandContext => {
  const chat = {
    getHistoryShallow: () => [
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'model', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] },
    ],
    getGenerationConfig: () => ({ systemInstruction: 'sys' }),
  };
  const config = {
    getProjectRoot: () => projectRoot,
    getGeminiClient: () => ({ getChat: () => chat }),
    getModel: () => 'test-model',
  };
  return createMockCommandContext({
    executionMode: 'non_interactive',
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: config as any,
    },
  });
};

describe('summaryCommand custom export path', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'summary-cmd-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  interface MessageResult {
    type: string;
    messageType: string;
    content: string;
  }

  const run = async (args: string): Promise<MessageResult> =>
    (await summaryCommand.action?.(
      makeContext(projectRoot),
      args,
    )) as MessageResult;

  const fileExists = async (p: string): Promise<boolean> => {
    try {
      return (await fs.stat(p)).isFile();
    } catch {
      return false;
    }
  };

  const dirExists = async (p: string): Promise<boolean> => {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  };

  it('defaults to .qwen/PROJECT_SUMMARY.md with no argument', async () => {
    const result = await run('');
    const fullPath = path.join(projectRoot, '.qwen', 'PROJECT_SUMMARY.md');
    expect(await fileExists(fullPath)).toBe(true);
    const written = await fs.readFile(fullPath, 'utf8');
    expect(written).toContain('SUMMARY BODY');
    expect(written).toContain('## Summary Metadata');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect(result.content).toContain('.qwen/PROJECT_SUMMARY.md');
    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.dirname(fullPath));
      expect(stat.mode & 0o777).toBe(0o700);
    }
  });

  it('writes a relative file path as-is', async () => {
    const result = await run('notes.md');
    expect(await fileExists(path.join(projectRoot, 'notes.md'))).toBe(true);
    expect(result.content).toContain('notes.md');
    expect(result.content).not.toContain(projectRoot);
  });

  it('treats a relative path with a trailing separator as a directory', async () => {
    // Regression: path.resolve strips the trailing separator, so the directory
    // must be detected from the raw argument, not the resolved path.
    const result = await run('docs/');
    expect(
      await fileExists(path.join(projectRoot, 'docs', 'PROJECT_SUMMARY.md')),
    ).toBe(true);
    expect(await fileExists(path.join(projectRoot, 'docs'))).toBe(false);
    expect(result.content).toContain('docs/PROJECT_SUMMARY.md');
    expect(result.content).not.toContain(projectRoot);
  });

  it('appends the default filename for an existing directory', async () => {
    await fs.mkdir(path.join(projectRoot, 'existingdir'));
    const result = await run('existingdir');
    expect(
      await fileExists(
        path.join(projectRoot, 'existingdir', 'PROJECT_SUMMARY.md'),
      ),
    ).toBe(true);
    expect(result.content).toContain('existingdir/PROJECT_SUMMARY.md');
    expect(result.content).not.toContain(projectRoot);
  });

  it('writes an absolute path as-is and reports it absolutely', async () => {
    const target = path.join(projectRoot, 'abs', 'out.md');
    const result = await run(target);
    expect(await fileExists(target)).toBe(true);
    expect(result.content).toContain(target.replaceAll(path.sep, '/'));
  });

  it('rejects a relative path that escapes the project root', async () => {
    const result = await run('../outside/leak.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('within the project root');
  });

  it('rejects an absolute path outside the project root', async () => {
    const result = await run('/tmp/summary-escape/leak.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('within the project root');
  });

  it('does not create the target directory when generation fails', async () => {
    vi.mocked(runSideQuery).mockRejectedValueOnce(new Error('rate limit'));
    const result = await run('reports/2026/summary.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(await dirExists(path.join(projectRoot, 'reports'))).toBe(false);
  });
});
