/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import TurndownService from 'turndown';
import { saveWebFetchSource } from './web-fetch-source.js';

describe('saved WebFetch source', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'webfetch-source-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = () => ({
    content: '# 标题\n😀 body\n',
    url: 'https://example.com',
    fetchedAt: '2026-10-23T00:00:00.000Z',
    projectTempDir: root,
    sessionId: 'session-one',
    signal: new AbortController().signal,
  });

  it('saves exact readable content in a private session file and reports its location', async () => {
    const saved = await saveWebFetchSource(input());
    expect(await fs.readFile(saved.path, 'utf8')).toBe('# 标题\n😀 body\n');
    expect(path.dirname(saved.path)).toBe(
      path.join(root, 'tool-outputs', 'session-session-one'),
    );
    expect(saved.note).toContain(saved.path);
    expect(saved.note).toContain('2026-10-23T00:00:00.000Z');
    expect(saved.note).toContain('13 UTF-16 code units; 3 lines');
    if (process.platform !== 'win32') {
      expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(saved.path))).mode & 0o777).toBe(
        0o700,
      );
    }
  });

  it
    .skipIf(process.platform === 'win32')
    .each(['tool-outputs', 'session-session-one'])(
    'rejects a linked %s directory without touching its target',
    async (linked) => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'webfetch-outside-'),
      );
      try {
        await fs.chmod(outside, 0o755);
        await fs.mkdir(path.join(root, 'tool-outputs'), { recursive: true });
        const link =
          linked === 'tool-outputs'
            ? path.join(root, linked)
            : path.join(root, 'tool-outputs', linked);
        if (linked === 'tool-outputs') await fs.rmdir(link);
        await fs.symlink(outside, link);
        await expect(saveWebFetchSource(input())).rejects.toThrow(/directory/i);
        expect(await fs.readdir(outside)).toEqual([]);
        expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a symlink config root with real output subdirectories',
    async () => {
      const alias = `${root}-alias`;
      await fs.symlink(root, alias);
      try {
        const saved = await saveWebFetchSource({
          ...input(),
          projectTempDir: path.join(alias, 'tmp', 'project'),
        });
        expect(await fs.readFile(saved.path, 'utf8')).toBe(input().content);
      } finally {
        await fs.unlink(alias);
      }
    },
  );

  it('never overwrites a prior source and separates sessions', async () => {
    const first = await saveWebFetchSource(input());
    const second = await saveWebFetchSource({
      ...input(),
      content: 'new body',
    });
    const third = await saveWebFetchSource({
      ...input(),
      sessionId: 'another-session',
    });
    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).not.toBe(path.dirname(third.path));
    expect(await fs.readFile(first.path, 'utf8')).toBe(input().content);
  });

  it('indexes nested headings against the actual file and ignores fenced headings', async () => {
    const content =
      '# Parent\nintro\n## Child\n```md\n# Fake\n```\nchild\n# Next\nend';
    const { note } = await saveWebFetchSource({ ...input(), content });
    expect(note).toContain('"Parent": lines 1-7');
    expect(note).toContain('"Child": lines 3-7');
    expect(note).toContain('"Next": lines 8-9');
    expect(note).not.toContain('Fake');
  });

  it('indexes Setext headings from real HTML conversion with correct section boundaries', async () => {
    const content = new TurndownService().turndown(
      '<h1>First</h1><h3>Child</h3><p>one</p><h1>Next</h1><p>two</p>',
    );
    const { note } = await saveWebFetchSource({ ...input(), content });
    expect(note).toContain('"First": lines 1-7');
    expect(note).toContain('"Child": lines 4-7');
    expect(note).toContain('"Next": lines 8-11');
  });

  it('indexes native Setext headings and preserves literal hashes in ATX titles', async () => {
    const content =
      'Title\n=====\n\nSection\n-----\n\n# C#\n\n# Closed ###\nbody';
    const { note } = await saveWebFetchSource({ ...input(), content });
    expect(note).toContain('"Title": lines 1-6');
    expect(note).toContain('"Section": lines 4-6');
    expect(note).toContain('"C#": lines 7-8');
    expect(note).toContain('"Closed": lines 9-10');
  });

  it('keeps the directory bounded without truncating the source', async () => {
    const content =
      '# ' +
      'x'.repeat(6500) +
      '\n' +
      Array.from({ length: 40 }, (_, i) => '# section ' + i).join('\n');
    const saved = await saveWebFetchSource({ ...input(), content });
    const entries = saved.note
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(entries.length).toBeLessThanOrEqual(30);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.join('\n').length).toBeLessThanOrEqual(6000);
    expect(await fs.readFile(saved.path, 'utf8')).toBe(content);
  });

  it('offers Grep when no headings exist', async () => {
    const saved = await saveWebFetchSource({
      ...input(),
      content: 'plain content',
    });
    expect(saved.note).toContain('Grep');
    expect(saved.note).toContain('No Markdown headings');
  });

  it('does not create a file for an already cancelled call', async () => {
    await expect(
      saveWebFetchSource({ ...input(), signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('removes a partial file when writing fails', async () => {
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file) => {
      await write(file, 'partial');
      throw new Error('disk full');
    });
    await expect(saveWebFetchSource(input())).rejects.toThrow('disk full');
    expect(
      await fs.readdir(path.join(root, 'tool-outputs', 'session-session-one')),
    ).toEqual([]);
  });

  it('removes the source when cancelled during the write', async () => {
    const controller = new AbortController();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args);
      controller.abort();
    });
    await expect(
      saveWebFetchSource({ ...input(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      await fs.readdir(path.join(root, 'tool-outputs', 'session-session-one')),
    ).toEqual([]);
  });
});
