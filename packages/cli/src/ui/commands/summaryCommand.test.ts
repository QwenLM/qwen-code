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
    vi.mocked(runSideQuery).mockClear();
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

  it('overwrites a hand-written file at the default path', async () => {
    const qwenDir = path.join(projectRoot, '.qwen');
    await fs.mkdir(qwenDir, { recursive: true });
    await fs.writeFile(
      path.join(qwenDir, 'PROJECT_SUMMARY.md'),
      'hand-written notes',
      'utf8',
    );
    const result = await run('');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(
      path.join(qwenDir, 'PROJECT_SUMMARY.md'),
      'utf8',
    );
    expect(written).toContain('SUMMARY BODY');
    expect(written).not.toContain('hand-written notes');
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
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('rejects an absolute path outside the project root', async () => {
    const result = await run('/tmp/summary-escape/leak.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('within the project root');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'allows a symlink that resolves inside the project root',
    async () => {
      await fs.mkdir(path.join(projectRoot, 'real-dir'));
      await fs.symlink(
        path.join(projectRoot, 'real-dir'),
        path.join(projectRoot, 'internal-link'),
      );
      const result = await run('internal-link/summary.md');
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      expect(
        await fileExists(path.join(projectRoot, 'real-dir', 'summary.md')),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a path that escapes the project root via a symlink',
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'summary-outside-'),
      );
      try {
        await fs.symlink(outside, path.join(projectRoot, 'link'));
        const result = await run('link/leak.md');
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
        expect(result.content).toContain('within the project root');
        expect(await fileExists(path.join(outside, 'leak.md'))).toBe(false);
        expect(runSideQuery).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a broken symlink whose target is outside the project root',
    async () => {
      const outsideTarget = path.join(
        os.tmpdir(),
        `summary-broken-${Date.now()}`,
        'leak.md',
      );
      await fs.symlink(outsideTarget, path.join(projectRoot, 'broken-link'));
      const result = await run('broken-link');
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect(result.content).toContain('within the project root');
      expect(await fileExists(outsideTarget)).toBe(false);
      expect(runSideQuery).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a multi-link symlink chain that escapes the project root',
    async () => {
      const outsideTarget = path.join(
        os.tmpdir(),
        `summary-chain-${Date.now()}`,
        'evil.md',
      );
      // link1 -> link2 (relative, inside root), link2 -> outside (absolute,
      // broken). The old single-readlink check saw only the inside-root link2
      // and passed containment; the full-chain walk reaches the outside target.
      await fs.symlink('link2', path.join(projectRoot, 'link1'));
      await fs.symlink(outsideTarget, path.join(projectRoot, 'link2'));
      const result = await run('link1');
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect(result.content).toContain('within the project root');
      expect(await fileExists(outsideTarget)).toBe(false);
      expect(runSideQuery).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink with a relative target escaping the project root',
    async () => {
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'summary-outside-'),
      );
      try {
        // Git stores symlink targets verbatim, so a committed
        // `ln -s ../outside/leak.md` recreates a relative target on checkout.
        await fs.symlink(
          path.join('..', path.basename(outsideDir), 'leak.md'),
          path.join(projectRoot, 'rel-link'),
        );
        const result = await run('rel-link');
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
        expect(result.content).toContain('within the project root');
        expect(runSideQuery).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a directory whose appended default filename is a symlink escaping the project root',
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'summary-outside-'),
      );
      try {
        const docsDir = path.join(projectRoot, 'docs');
        await fs.mkdir(docsDir);
        await fs.symlink(
          path.join(outside, 'evil-target.md'),
          path.join(docsDir, 'PROJECT_SUMMARY.md'),
        );
        const result = await run('docs');
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
        expect(result.content).toContain('within the project root');
        expect(await fileExists(path.join(outside, 'evil-target.md'))).toBe(
          false,
        );
        expect(runSideQuery).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink cycle',
    async () => {
      await fs.symlink('link-b', path.join(projectRoot, 'link-a'));
      await fs.symlink('link-a', path.join(projectRoot, 'link-b'));
      const result = await run('link-a');
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect(result.content).toContain('within the project root');
      expect(runSideQuery).not.toHaveBeenCalled();
    },
  );

  it('does not create the target directory when generation fails', async () => {
    vi.mocked(runSideQuery).mockRejectedValueOnce(new Error('rate limit'));
    const result = await run('reports/2026/summary.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(await dirExists(path.join(projectRoot, 'reports'))).toBe(false);
  });

  it('expands a leading ~ and rejects it when outside the project root', async () => {
    const result = await run('~/summary-tilde-leak.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('within the project root');
    expect(runSideQuery).not.toHaveBeenCalled();
    // The unexpanded argument must not create a literal "~" directory.
    expect(await dirExists(path.join(projectRoot, '~'))).toBe(false);
  });

  it('refuses to overwrite an existing file that is not a generated summary', async () => {
    const target = path.join(projectRoot, 'IMPORTANT.md');
    await fs.writeFile(target, 'precious content', 'utf8');
    const result = await run('IMPORTANT.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('already exists');
    expect(await fs.readFile(target, 'utf8')).toBe('precious content');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a file that merely mentions Summary Metadata in prose', async () => {
    const target = path.join(projectRoot, 'DESIGN.md');
    await fs.writeFile(
      target,
      'The summary file ends with a `## Summary Metadata` footer.\n',
      'utf8',
    );
    const result = await run('DESIGN.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('already exists');
    expect(await fs.readFile(target, 'utf8')).toContain(
      '`## Summary Metadata`',
    );
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a file with a Summary Metadata heading but no Update time', async () => {
    const target = path.join(projectRoot, 'DESIGN.md');
    await fs.writeFile(
      target,
      'Some content\n\n---\n\n## Summary Metadata\n\nThis is a design doc.\n',
      'utf8',
    );
    const result = await run('DESIGN.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('already exists');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('overwrites a previously generated summary', async () => {
    const target = path.join(projectRoot, 'summary.md');
    await fs.writeFile(
      target,
      'old body\n\n---\n\n## Summary Metadata\n**Update time**: old\n',
      'utf8',
    );
    const result = await run('summary.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(target, 'utf8');
    expect(written).toContain('SUMMARY BODY');
    expect(written).not.toContain('old body');
  });

  it.skipIf(process.platform === 'win32')(
    'creates a custom-path summary with mode 0o600',
    async () => {
      await run('private-notes.md');
      const stat = await fs.stat(path.join(projectRoot, 'private-notes.md'));
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it('overwrites a previously generated summary with CRLF line endings', async () => {
    const target = path.join(projectRoot, 'crlf-summary.md');
    await fs.writeFile(
      target,
      'old body\r\n\r\n---\r\n\r\n## Summary Metadata\r\n**Update time**: old\r\n',
      'utf8',
    );
    const result = await run('crlf-summary.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(target, 'utf8');
    expect(written).toContain('SUMMARY BODY');
    expect(written).not.toContain('old body');
  });

  it('overwrites an empty pre-created file', async () => {
    const target = path.join(projectRoot, 'empty.md');
    await fs.writeFile(target, '', 'utf8');
    const result = await run('empty.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(target, 'utf8');
    expect(written).toContain('SUMMARY BODY');
  });

  it('rejects a trailing separator on an existing file', async () => {
    await fs.writeFile(path.join(projectRoot, 'notes.md'), 'content', 'utf8');
    const result = await run('notes.md/');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('ends with a separator');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'allows the default target when .qwen is a symlink',
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'summary-shared-'),
      );
      try {
        await fs.symlink(outside, path.join(projectRoot, '.qwen'));
        const result = await run('');
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'info',
        });
        expect(await fileExists(path.join(outside, 'PROJECT_SUMMARY.md'))).toBe(
          true,
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('rejects a non-summary file created during generation', async () => {
    vi.mocked(runSideQuery).mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(projectRoot, 'race.md'),
        'precious content',
        'utf8',
      );
      return { text: 'SUMMARY BODY' };
    });
    const result = await run('race.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('already exists');
    expect(await fs.readFile(path.join(projectRoot, 'race.md'), 'utf8')).toBe(
      'precious content',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink planted at the target during generation',
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'summary-toctou-'),
      );
      try {
        vi.mocked(runSideQuery).mockImplementationOnce(async () => {
          await fs.symlink(outside, path.join(projectRoot, 'race-link.md'));
          return { text: 'SUMMARY BODY' };
        });
        const result = await run('race-link.md');
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
        expect(result.content).toContain('within the project root');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'applies 0o700 to .qwen/ when spelled explicitly',
    async () => {
      const result = await run('.qwen/');
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      const stat = await fs.stat(path.join(projectRoot, '.qwen'));
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves existing file permissions on regeneration',
    async () => {
      const target = path.join(projectRoot, 'summary.md');
      await fs.writeFile(
        target,
        'old body\n\n---\n\n## Summary Metadata\n**Update time**: old\n',
        'utf8',
      );
      await fs.chmod(target, 0o644);
      await run('summary.md');
      const stat = await fs.stat(target);
      expect(stat.mode & 0o777).toBe(0o644);
    },
  );

  it('overwrites a hand-written file when the default path is spelled explicitly', async () => {
    const qwenDir = path.join(projectRoot, '.qwen');
    await fs.mkdir(qwenDir, { recursive: true });
    await fs.writeFile(
      path.join(qwenDir, 'PROJECT_SUMMARY.md'),
      'hand-written notes',
      'utf8',
    );
    const result = await run('.qwen/PROJECT_SUMMARY.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(
      path.join(qwenDir, 'PROJECT_SUMMARY.md'),
      'utf8',
    );
    expect(written).toContain('SUMMARY BODY');
    expect(written).not.toContain('hand-written notes');
  });

  it('rejects an existing directory at the leaf before generating', async () => {
    await fs.mkdir(path.join(projectRoot, 'docs', 'PROJECT_SUMMARY.md'), {
      recursive: true,
    });
    const result = await run('docs');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('existing directory');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a file that embeds a full footer mid-document', async () => {
    const target = path.join(projectRoot, 'ARCHIVE.md');
    await fs.writeFile(
      target,
      'intro\n\n---\n\n## Summary Metadata\n**Update time**: old\n\ntrailing prose\n',
      'utf8',
    );
    const result = await run('ARCHIVE.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toContain('already exists');
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('detects the footer in a file larger than the tail window', async () => {
    const target = path.join(projectRoot, 'big-summary.md');
    const padding = 'x'.repeat(8192);
    await fs.writeFile(
      target,
      `${padding}\n\n---\n\n## Summary Metadata\n**Update time**: old\n`,
      'utf8',
    );
    const result = await run('big-summary.md');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const written = await fs.readFile(target, 'utf8');
    expect(written).toContain('SUMMARY BODY');
    expect(written).not.toContain(padding);
  });

  it('returns empty content in interactive mode errors to avoid double rendering', async () => {
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
    const context = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
      },
    });
    const result = (await summaryCommand.action?.(
      context,
      '../outside/leak.md',
    )) as MessageResult;
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(result.content).toBe('');
    expect(vi.mocked(context.ui.addItem)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
      expect.any(Number),
    );
  });
});
