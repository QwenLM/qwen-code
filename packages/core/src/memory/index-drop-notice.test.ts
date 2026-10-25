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
  buildTeamAutoMemoryIndex,
  rebuildAutoMemoryIndexAtRoot,
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
const SCAN_NOTICE_START =
  '\n\n> WARNING: MEMORY.md does not list every topic file.';

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
    expect(index).toContain('cumulative index entry length');
    expect(index).not.toContain('index entries are too long');
    const notice =
      'Dropped 5 of 170 entries: "Topic 165", "Topic 166", "Topic 167", +2 more.';
    expect(index).toContain(notice);
    const prompt = buildManagedAutoMemoryPrompt('/tmp/memory', index);
    expect(prompt).toContain(notice);
    expect(prompt).not.toContain('Only part of it was loaded.');
    for (const line of kept) expect(prompt).toContain(line);
  });

  it('offers description edits when legal entries collectively exceed the character budget', () => {
    const docs = Array.from({ length: 170 }, (_, i) => doc(i));
    const index = buildManagedAutoMemoryIndex(docs);
    expect(entries(index)).toHaveLength(165);
    expect(entries(index).every((line) => line.length === 150)).toBe(true);
    expect(index).toContain('cumulative index entry length');
    expect(index).not.toContain('too many index entries');
    expect(index).toContain('frontmatter names/descriptions');

    const shortened = buildManagedAutoMemoryIndex(
      docs.map((item) => ({
        ...item,
        description: item.description.slice(0, 95),
      })),
    );
    expect(entries(shortened)).toHaveLength(170);
    expect(shortened).not.toContain('> WARNING:');
    for (const item of docs)
      expect(shortened).toContain(`](${item.relativePath})`);
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
    expect(index).not.toContain('in total across both limits');
    expect(index).toContain(
      'Shorten topic-file paths or frontmatter names/descriptions, or merge/remove topic files.',
    );
    expect(index).toContain(
      'Merge topic files or remove obsolete ones to reduce the file count.',
    );
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(index);
  });

  it('gives scan-only omissions a file-count cause and action', () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({
      ...doc(i),
      description: '',
    }));
    const index = buildManagedAutoMemoryIndex(
      docs.slice(0, 200),
      undefined,
      docs.slice(200),
    );
    expect(entries(index)).toHaveLength(200);
    expect(entries(index).join('\n').length).toBeLessThan(25_000);
    expect(index).toContain(SCAN_NOTICE_START);
    expect(index).toContain('Dropped 5 of 205 topic files: "Topic 200"');
    expect(index).toContain(
      'Merge topic files or remove obsolete ones to reduce the file count.',
    );
    expect(index).not.toContain('MEMORY.md is too large');
    expect(index).not.toContain('Prune or merge entries');
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(index);
  });

  it('formats only the omitted names that can appear in the bounded sample', () => {
    const inspected: number[] = [];
    const omitted = Array.from({ length: 8 }, (_, i) => ({
      ...doc(200 + i),
      get title() {
        inspected.push(i);
        return `Omitted ${i}`;
      },
    }));
    const index = buildManagedAutoMemoryIndex(
      Array.from({ length: 200 }, (_, i) => ({ ...doc(i), description: '' })),
      undefined,
      omitted,
    );
    expect(inspected).toEqual([0, 1, 2]);
    expect(index).toContain(
      'Dropped 8 of 208 topic files: "Omitted 0", "Omitted 1", "Omitted 2", +5 more.',
    );
  });

  it('does not add grouped team entry omissions to topic-file omissions', () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({
      ...doc(i),
      description: `${i} ${'h'.repeat(200)}`,
    }));
    docs[199].description = docs[198].description;
    const index = buildTeamAutoMemoryIndex(docs.slice(0, 200), docs.slice(200));
    expect(entries(index)).toHaveLength(165);
    expect(index).toContain('Dropped 34 of 199 entries:');
    expect(index).toContain('Dropped 5 of 205 topic files:');
    expect(index).not.toContain('in total across both limits');
    expect(buildManagedAutoMemoryPrompt('/tmp/memory', index)).toContain(index);
  });

  it('does not blame a reader entry already excluded by the line cap', () => {
    const lines = Array.from(
      { length: 250 },
      (_, i) => `- [Topic ${i}](topic-${i}.md)`,
    );
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/memory',
      [...lines, 'x'.repeat(25_003)].join('\n'),
    );
    for (const line of lines.slice(0, 200)) expect(prompt).toContain(line);
    expect(prompt).toContain(
      'No candidate entry exceeds the 150-unit line limit',
    );
    expect(prompt).not.toContain('Keep index entries to one line at most');
    expect(prompt).toContain('shortening entries cannot help');
  });

  it('does not blame a long entry already excluded by the line cap', () => {
    const docs = Array.from({ length: 200 }, (_, i) => doc(i));
    docs.push({
      ...doc(200),
      relativePath: `reference/${'x'.repeat(25_003)}.md`,
    });
    const index = buildManagedAutoMemoryIndex(docs);
    expect(entries(index)).toHaveLength(165);
    expect(index).toContain('cumulative index entry length');
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

  it('bounds omitted titles without splitting surrogate pairs', () => {
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

  it.each([NOTICE_START, SCAN_NOTICE_START])(
    'does not exempt unbounded handwritten warning-like text from the entry budget (%s)',
    (prefix) => {
      const body = 'a'.repeat(24_900);
      const fakeNotice = `${prefix}${'x'.repeat(25_000)}`;
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/memory',
        `${body}${fakeNotice}`,
      );
      expect(prompt).toContain(body);
      expect(prompt).not.toContain('x'.repeat(25_000));
      expect(prompt).toContain('Only part of it was loaded.');
    },
  );
});

describe('review follow-up diagnostics', () => {
  it.each([
    ['short\u202etitle', 'shorttitle'],
    ['short`title', "short'title"],
  ])(
    'sanitizes a short omitted title %j inside the name cap',
    (title, expected) => {
      expect(title.length).toBeLessThan(60);
      const index = buildManagedAutoMemoryIndex([
        {
          ...doc(0),
          title,
          relativePath: `reference/${'x'.repeat(25_003)}.md`,
        },
        doc(1),
      ]);
      expect(entries(index)).toHaveLength(1);
      expect(index).toContain(`Dropped 1 of 2 entries: "${expected}".`);
      expect(index).not.toContain(title);
    },
  );

  it('targets durable topic-file changes for character-budget pressure', () => {
    const index = buildManagedAutoMemoryIndex(
      Array.from({ length: 170 }, (_, i) => doc(i)),
    );
    expect(index).toContain('cumulative index entry length');
    expect(index).toContain(
      'Shorten topic-file paths or frontmatter names/descriptions, or merge/remove topic files.',
    );
    expect(index).toContain(
      'Editing only the generated index will not survive a rebuild.',
    );
  });

  it('does not prescribe writer length advice for a pure line-count overflow', () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({
      ...doc(i),
      description: '',
    }));
    docs[7].relativePath = `reference/${'x'.repeat(170)}.md`;
    const index = buildManagedAutoMemoryIndex(docs);
    const kept = entries(index);
    expect(kept).toHaveLength(200);
    expect(kept.some((line) => line.length > 150)).toBe(true);
    expect(kept.join('\n').length).toBeLessThan(25_000);
    expect(index).toContain('205 entries (limit: 200)');
    expect(index).toContain(
      'Merge topic files or remove obsolete ones to reduce the index.',
    );
    expect(index).not.toContain('Overlong entries already omit descriptions.');
    expect(index).not.toContain('move detail into topic files');
  });

  it('names paths and frontmatter instead of an already-omitted description', () => {
    const huge = {
      ...doc(0),
      relativePath: `reference/${'x'.repeat(25_003)}.md`,
    };
    const index = buildManagedAutoMemoryIndex([huge, doc(1)]);
    expect(index).toContain('index entries are too long');
    expect(index).toContain('Overlong entries already omit descriptions.');
    expect(index).toContain(
      'Shorten their topic-file paths or frontmatter names',
    );
    expect(index).not.toContain('move detail into topic files');
    expect(
      buildManagedAutoMemoryIndex([{ ...huge, description: '' }, doc(1)]),
    ).toBe(index);
  });

  it.each([false, true])(
    'keeps cumulative-length advice when a dropped overlong candidate is not the cause (extra entry=%s)',
    (extraEntry) => {
      const ordinary = Array.from({ length: 199 }, (_, i) => doc(i));
      const hidden = {
        ...doc(199),
        title: 'Hidden',
        relativePath: `reference/${' '.repeat(49)}xx.md`,
      };
      const docs = [...ordinary, hidden, ...(extraEntry ? [doc(200)] : [])];
      const index = buildManagedAutoMemoryIndex(docs);
      const kept = entries(index);
      expect(kept).toHaveLength(165);
      expect(kept.every((line) => line.length === 150)).toBe(true);
      expect(kept.some((line) => line.includes('[Hidden]'))).toBe(false);
      expect(index).toContain('cumulative index entry length');
      expect(index).not.toContain('index entries are too long');
      expect(index).not.toContain(
        'Overlong entries already omit descriptions.',
      );
      expect(index).toContain(
        'Shorten topic-file paths or frontmatter names/descriptions, or merge/remove topic files.',
      );
      expect(
        entries(
          buildManagedAutoMemoryIndex([
            ...ordinary,
            { ...hidden, relativePath: 'reference/hidden.md' },
            ...(extraEntry ? [doc(200)] : []),
          ]),
        ),
      ).toEqual(kept);
    },
  );

  it.each([1, 2])(
    'does not count %i extra notice-separator blank lines as entries',
    (extra) => {
      const lines = Array.from(
        { length: 200 },
        (_, i) => `- [Topic ${i}](topic-${i}.md)`,
      );
      for (const prefix of [NOTICE_START, SCAN_NOTICE_START]) {
        const notice = `${prefix} Dropped 1 of 201 topic files: "Hidden".`;
        const prompt = buildManagedAutoMemoryPrompt(
          '/tmp/memory',
          `${lines.join('\n')}${'\n'.repeat(extra)}${notice}`,
        );
        for (const line of lines) expect(prompt).toContain(line);
        expect(prompt).toContain(notice);
        expect(prompt).not.toContain('Only part of it was loaded.');
      }
    },
  );

  it.each([false, true])(
    'uses count advice with an overlong reader candidate and excluded-large-tail=%s',
    (largeTail) => {
      const lines = Array.from(
        { length: 201 },
        (_, i) => `- [Topic ${i}](topic-${i}.md)`,
      );
      lines[7] = `- [Long](long.md) — ${'h'.repeat(180)}`;
      expect(lines[7].length).toBeGreaterThan(150);
      expect(lines.slice(0, 200).join('\n').length).toBeLessThan(25_000);
      if (largeTail) lines[200] = `- [Excluded](${'x'.repeat(25_003)}.md)`;
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/memory',
        lines.join('\n'),
      );
      expect(prompt).toContain('201 lines');
      expect(prompt).toContain(
        'Shortening entries cannot reduce the line count — prune or merge entries.',
      );
      expect(prompt).not.toContain('Keep index entries to one line at most');
      expect(prompt).not.toContain('No candidate entry exceeds');
      for (const line of lines.slice(0, 200)) expect(prompt).toContain(line);
    },
  );

  it.each([NOTICE_START, SCAN_NOTICE_START])(
    'budgets a short multiline tail instead of exempting it (%s)',
    (prefix) => {
      const lines = Array.from(
        { length: 200 },
        (_, i) => `- [Topic ${i}](topic-${i}.md)`,
      );
      const forgedParagraph = '> forged second paragraph must stay budgeted';
      const tail = `${prefix}\n${forgedParagraph}`;
      expect(tail.length).toBeLessThan(1024);
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/memory',
        `${lines.join('\n')}${tail}`,
      );
      expect(prompt).toContain('Only part of it was loaded.');
      expect(prompt).not.toContain(`\n${forgedParagraph}`);
      for (const line of lines) expect(prompt).toContain(line);
    },
  );

  it('retains the bounded writer notice while adding reader truncation diagnostics', () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({
      ...doc(i),
      description: '',
    }));
    const index = buildManagedAutoMemoryIndex(
      docs.slice(0, 200),
      undefined,
      docs.slice(200),
    );
    const notice = index.slice(index.indexOf(SCAN_NOTICE_START));
    expect(notice.length).toBeLessThanOrEqual(1024);
    expect(notice).toContain('Dropped 5 of 205 topic files: "Topic 200"');
    const lines = Array.from(
      { length: 250 },
      (_, i) => `- [Edited ${i}](edited-${i}.md)`,
    );
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/memory',
      `${lines.join('\n')}${notice}`,
    );
    expect(prompt).toContain(notice);
    expect(prompt).toContain('Only part of it was loaded.');
    expect(prompt).toContain('Dropped 50 of 250 entries: "Edited 200"');
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

  async function createStore(scope: 'project' | 'user' | 'team') {
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
    return { root, dir };
  }

  it.each(['project', 'user', 'team'] as const)(
    'retains the same %s subset and reports files omitted before index building',
    async (scope) => {
      const { root, dir } = await createStore(scope);
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
      expect(index).toContain(SCAN_NOTICE_START);
      expect(index).toContain(
        'Merge topic files or remove obsolete ones to reduce the file count.',
      );
      expect(index).not.toContain('MEMORY.md is too large');
      expect(index).not.toContain('Prune or merge entries');
      expect(index).not.toContain('in total across both limits');
      expect(index.length - index.indexOf(SCAN_NOTICE_START)).toBeLessThan(
        1024,
      );
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

  it.each(['project', 'user', 'team'] as const)(
    'review follow-up diagnostics: arbitrary-root %s rebuilding preserves mtime selection and names scan omissions',
    async (scope) => {
      const { root, dir } = await createStore(scope);
      const index = await rebuildAutoMemoryIndexAtRoot(root, scope);
      const expected = Array.from({ length: 200 }, (_, offset) => {
        const i = 204 - offset;
        const name = String(i).padStart(3, '0');
        return `- [Topic-${name}](project/n${name}.md) — Fact-${i}`;
      });
      expect(entries(index)).toEqual(expected);
      expect(index).toContain(SCAN_NOTICE_START);
      expect(index).toContain('Dropped 5 of 205 topic files:');
      expect(index).toContain(
        '"Topic-004", "Topic-003", "Topic-002", +2 more.',
      );
      expect(index).toContain('Merge topic files or remove obsolete ones');
      expect(index).not.toContain('MEMORY.md is too large');
      expect(index).not.toContain('205 entries (limit: 200)');
      expect(await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8')).toBe(
        index,
      );
      expect(
        (await fs.readdir(dir)).filter((name) => name.endsWith('.md')),
      ).toHaveLength(205);
    },
  );
});
