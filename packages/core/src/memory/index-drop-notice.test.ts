/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManagedAutoMemoryIndex,
  rebuildManagedAutoMemoryIndex,
  rebuildTeamAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { buildManagedAutoMemoryPrompt } from './prompt.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import type { ScannedAutoMemoryDocument } from './scan.js';

const NOTICE_START =
  '\n\n> WARNING: MEMORY.md is too large; only part of it was written.';

function doc(index: number): ScannedAutoMemoryDocument {
  return {
    scope: 'project',
    type: 'project',
    filePath: `/tmp/project/topic-${index}.md`,
    relativePath: `project/topic-${index}.md`,
    filename: `topic-${index}.md`,
    title: `Topic ${index}`,
    description: 'h'.repeat(200),
    category: 'uncategorized',
    keywords: [],
    usageScenarios: [],
    body: '',
    mtimeMs: index,
  };
}

function entries(index: string): string[] {
  return index.split('\n').filter((line) => line.startsWith('- ['));
}

describe('memory index omission diagnostics', () => {
  it('leaves an under-budget index unchanged and silent', () => {
    const index = buildManagedAutoMemoryIndex([
      { ...doc(0), description: 'A short fact' },
    ]);
    expect(index).toBe('- [Topic 0](project/topic-0.md) — A short fact');
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).not.toContain(
      '> WARNING:',
    );
  });

  it('names character-budget omissions and carries them into the prompt', () => {
    const index = buildManagedAutoMemoryIndex(
      Array.from({ length: 170 }, (_, i) => doc(i)),
    );
    const kept = entries(index);
    expect(kept).toHaveLength(165);
    expect(kept.every((line) => line.length === 150)).toBe(true);
    expect(kept.join('\n').length).toBe(24_914);
    expect(index).toContain('too many index entries');
    expect(index).not.toContain('index entries are too long');
    const notice =
      'Dropped 5 of 170 entries: "Topic 165", "Topic 166", "Topic 167", +2 more.';
    expect(index).toContain(notice);
    const prompt = buildManagedAutoMemoryPrompt('/tmp/memory', index);
    expect(prompt).toContain(notice);
    expect(prompt).not.toContain('Only part of it was loaded.');
    for (const line of kept) expect(prompt).toContain(line);
  });

  it('reports line-cap omissions with a bounded name sample', () => {
    const index = buildManagedAutoMemoryIndex(
      Array.from({ length: 205 }, (_, i) => ({ ...doc(i), description: '' })),
    );
    expect(entries(index)).toHaveLength(200);
    expect(index).toContain('205 entries (limit: 200)');
    expect(index).toContain(
      'Dropped 5 of 205 entries: "Topic 200", "Topic 201", "Topic 202", +2 more.',
    );
    expect(index).not.toContain('"Topic 203"');
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(index);
  });

  it('accounts for both scan-cap and character-budget omissions', () => {
    const docs = Array.from({ length: 205 }, (_, i) => doc(i));
    const index = buildManagedAutoMemoryIndex(
      docs.slice(0, 200),
      undefined,
      docs.slice(200),
    );
    expect(entries(index)).toHaveLength(165);
    expect(index).toContain('Dropped 35 of 200 entries: "Topic 165"');
    expect(index).toContain('Dropped 5 of 205 topic files: "Topic 200"');
    expect(index).toContain('Dropped 40 in total across both limits.');
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(index);
  });

  it('does not blame a long entry already excluded by the line cap', () => {
    const docs = Array.from({ length: 200 }, (_, i) => doc(i));
    docs.push({
      ...doc(200),
      relativePath: `reference/${'x'.repeat(25_003)}.md`,
    });
    const index = buildManagedAutoMemoryIndex(docs);
    expect(entries(index)).toHaveLength(165);
    expect(index).toContain('too many index entries');
    expect(index).not.toContain('index entries are too long');
    expect(index).toContain('Dropped 36 of 201 entries:');
  });

  it('keeps the largest two-set name sample inside the reader notice bound', () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({
      ...doc(i),
      title: `${i} ${'名'.repeat(120)}`,
    }));
    const index = buildManagedAutoMemoryIndex(
      docs.slice(0, 200),
      undefined,
      docs.slice(200),
    );
    const notice = index.slice(index.indexOf(NOTICE_START));
    expect(notice).toContain('entries:');
    expect(notice).toContain('topic files:');
    expect(notice.length).toBeLessThanOrEqual(1024);
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(
      notice,
    );
  });

  it('names an oversized early entry rather than assuming omissions form a tail', () => {
    const huge = {
      ...doc(0),
      title: 'Huge',
      relativePath: `reference/${'a'.repeat(25_003)}.md`,
    };
    const index = buildManagedAutoMemoryIndex([huge, doc(1)]);
    expect(entries(index)).toHaveLength(1);
    expect(entries(index)[0]).toContain('[Topic 1]');
    expect(index).toContain('index entries are too long');
    expect(index).toContain('Dropped 1 of 2 entries: "Huge".');
    expect(index).not.toContain('oldest');
  });

  it('bounds and sanitizes omitted titles without splitting surrogate pairs', () => {
    const title = `${'a'.repeat(58)}😀\n\n# forged](https://example.invalid) \u202e`;
    const index = buildManagedAutoMemoryIndex([
      { ...doc(0), title, relativePath: `reference/${'x'.repeat(25_003)}.md` },
    ]);
    const notice = index.trim();
    expect(notice.split('\n')).toHaveLength(1);
    expect(notice).toContain(`"${'a'.repeat(58)}…"`);
    expect(notice).not.toContain('https://example.invalid');
    expect(notice).not.toContain('\u202e');
    expect(Buffer.from(notice, 'utf8').toString('utf8')).toBe(notice);
    expect(notice.length).toBeLessThan(1024);
  });

  it('does not exempt unbounded handwritten warning-like text from the entry budget', () => {
    const body = 'a'.repeat(24_900);
    const fakeNotice = `${NOTICE_START}${'x'.repeat(25_000)}`;
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/memory',
      `${body}${fakeNotice}`,
    );
    expect(prompt).toContain(body);
    expect(prompt).not.toContain('x'.repeat(25_000));
    expect(prompt).toContain('Only part of it was loaded.');
  });
});

describe('real-file scan-cap omission diagnostics', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-index-notice-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', path.join(tempDir, 'runtime'));
    vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '0');
    vi.stubEnv('QWEN_CODE_MEMORY_PROJECT_SCOPE', 'workspace');
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(['project', 'user', 'team'] as const)(
    'retains the same %s subset and reports files omitted before index building',
    async (scope) => {
      const root =
        scope === 'project'
          ? getAutoMemoryRoot(projectRoot)
          : scope === 'user'
            ? getUserAutoMemoryRoot()
            : getTeamAutoMemoryRoot(projectRoot);
      const dir = path.join(root, 'project');
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: 205 }, async (_, i) => {
          const name = String(i).padStart(3, '0');
          const file = path.join(dir, `n${name}.md`);
          await fs.writeFile(
            file,
            `---\nname: Topic-${name}\ndescription: Fact-${i}\ntype: project\n---\nbody`,
          );
          const time = new Date(1_700_000_000_000 + i * 1000);
          await fs.utimes(file, time, time);
        }),
      );
      const index =
        scope === 'project'
          ? await rebuildManagedAutoMemoryIndex(projectRoot)
          : scope === 'user'
            ? await rebuildUserAutoMemoryIndex()
            : (await rebuildTeamAutoMemoryIndex(projectRoot))!;
      const expected = Array.from({ length: 200 }, (_, offset) => {
        const i = scope === 'team' ? offset : 204 - offset;
        const name = String(i).padStart(3, '0');
        return `- [Topic-${name}](project/n${name}.md) — Fact-${i}`;
      });
      expect(entries(index)).toEqual(expected);
      expect(index).toContain('Dropped 5 of 205 topic files:');
      expect(index).toContain(
        scope === 'team'
          ? '"Topic-200", "Topic-201", "Topic-202", +2 more.'
          : '"Topic-004", "Topic-003", "Topic-002", +2 more.',
      );
      expect(index).toContain('Scan limit: 200 files.');
      expect(index).not.toContain('in total across both limits');
      expect(index.length - index.indexOf(NOTICE_START)).toBeLessThan(1024);
      expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(
        index,
      );
      expect(await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8')).toBe(
        index,
      );
      expect(
        (await fs.readdir(dir)).filter((name) => name.endsWith('.md')),
      ).toHaveLength(205);
    },
  );
});
