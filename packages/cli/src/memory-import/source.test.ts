/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewSource, readLocalSource, validateSource } from './source.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const source = (content: string) => ({
  version: 1,
  source: 'codex',
  files: [{ path: 'MEMORY.md', content }],
});
describe('Codex source preview', () => {
  it('preserves whole task context and separates source projects', () => {
    const preview = previewSource(
      source(
        '# Alpha\ncwd: /synthetic/alpha\n## Task 1\n- Prefer transactional updates.\n## Caveat\nOnly for migrations.\n# Beta\ncwd: /synthetic/beta\n- Prefer streaming.',
      ),
    );
    expect(preview.sections).toHaveLength(2);
    expect(preview.groups).toHaveLength(2);
    expect(preview.sections[0].content).toContain('Only for migrations.');
    expect(preview.sections[1].sourceProject).toBe('/synthetic/beta');
  });
  it('separates nested project headings and preserves only their ancestor context', () => {
    const preview = previewSource({
      version: 1,
      source: 'codex',
      files: [
        {
          path: 'memory_summary.md',
          content:
            "## What's in Memory\n### /synthetic/alpha\nAlpha-only fact.\n### /synthetic/beta\nBeta-only fact.",
        },
      ],
    });
    expect(preview.sections.map((s) => s.sourceProject)).toEqual([
      '/synthetic/alpha',
      '/synthetic/beta',
    ]);
    expect(preview.sections[0].content).toContain("What's in Memory");
    expect(preview.sections[0].content).not.toContain('Beta-only');
    expect(preview.sections[1].content).not.toContain('Alpha-only');
    const handbook = previewSource(
      source(
        '# Shared notes\n## Alpha\ncwd: /synthetic/alpha\nAlpha-only fact.\n## Beta\ncwd: /synthetic/beta\nBeta-only fact.',
      ),
    );
    expect(handbook.sections.map((s) => s.sourceProject)).toEqual([
      '/synthetic/alpha',
      '/synthetic/beta',
    ]);
  });
  it('splits a memory file at its shallowest heading depth', () => {
    const preview = previewSource(
      source('## Alpha\nAlpha-only fact.\n## Beta\nBeta-only fact.'),
    );
    expect(preview.sections.map((section) => section.title)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(preview.sections[0].content).toContain('Alpha-only fact.');
    expect(preview.sections[1].content).not.toContain('Alpha-only fact.');
  });
  it('keeps CR-terminated section bodies instead of dropping them as heading-only', () => {
    const preview = previewSource(
      source('## /home/u/b\rcwd=/home/u/b\rfact\r'),
    );
    expect(preview.sections).toHaveLength(1);
    expect(preview.sections[0].suggestedScope).toBe('project');
    expect(preview.sections[0].sourceProject).toBe('/home/u/b');

    const crOnly = previewSource(source('# Topic\rKeep this fact.\r'));
    expect(crOnly.sections).toHaveLength(1);
    expect(crOnly.sections[0].content).toContain('Keep this fact.');
  });
  it('normalizes setext and closed ATX headings before scope classification', () => {
    const project = previewSource(
      source('/home/u/b\n---------\ncwd=/home/u/b\nfact\n'),
    );
    expect(project.sections[0].title).toBe('/home/u/b');
    expect(project.sections[0].suggestedScope).toBe('project');
    expect(project.sections[0].sourceProject).toBe('/home/u/b');

    const multiline = previewSource(
      source('/home/u/proj\nand more text\n-------------\nfact\n'),
    );
    expect(multiline.sections[0].title).toBe('/home/u/proj and more text');
    expect(multiline.sections[0].suggestedScope).toBe('unassigned');

    const user = previewSource({
      version: 1,
      source: 'codex',
      files: [
        {
          path: 'memory_summary.md',
          content: 'User preferences\n----------------\nPrefer concise.\n',
        },
      ],
    });
    expect(user.sections[0].title).toBe('User preferences');
    expect(user.sections[0].suggestedScope).toBe('user');

    const closed = previewSource(source('## Foo ##\nFact.\n'));
    expect(closed.sections[0].title).toBe('Foo');
  });
  it('does not treat prose after a cwd token as a project path', () => {
    const prose = previewSource(
      source('# Topic\ncwd=/home/u/proj: the main repo\nFact.\n'),
    );
    expect(prose.sections[0].suggestedScope).toBe('unassigned');

    const heading = previewSource(
      source('## /home/u/proj is the backend\nFact.\n'),
    );
    expect(heading.sections[0].suggestedScope).toBe('unassigned');
  });
  it('unifies trailing punctuation and keeps quoted paths with spaces', () => {
    const variants = previewSource(
      source(
        '# A\ncwd=/home/u/proj\nA.\n# B\ncwd=/home/u/proj.\nB.\n# C\ncwd: /home/u/proj/\nC.\n',
      ),
    );
    expect(variants.groups).toHaveLength(1);
    expect(variants.sections.map((s) => s.sourceProject)).toEqual([
      '/home/u/proj',
      '/home/u/proj',
      '/home/u/proj',
    ]);

    const quoted = previewSource(
      source('# Topic\ncwd=`/home/u/my project`\nFact.\n'),
    );
    expect(quoted.sections[0].suggestedScope).toBe('project');
    expect(quoted.sections[0].sourceProject).toBe('/home/u/my project');
  });
  it('leaves unknown and conflicting scopes unassigned', () => {
    const preview = previewSource(
      source(
        '# Unknown\nKeep provenance.\n# Mixed\ncwd: /synthetic/alpha\ncwd: /synthetic/beta\nNever guess.',
      ),
    );
    expect(
      preview.sections.every((item) => item.suggestedScope === 'unassigned'),
    ).toBe(true);
  });
  it('recognizes explicit summary user sections without globalizing project content', () => {
    const preview = previewSource({
      version: 1,
      source: 'codex',
      files: [
        {
          path: 'memory_summary.md',
          content:
            '## User preferences\nPrefer concise explanations.\n## General Tips\nUse project build commands.',
        },
      ],
    });
    expect(preview.sections.map((s) => s.suggestedScope)).toEqual([
      'user',
      'unassigned',
    ]);
  });
  it('bounds heading work before contextual expansion', () => {
    expect(() =>
      previewSource(source('# Topic\nFact.\n'.repeat(4097))),
    ).toThrow('heading limit');
  });
  it('rejects a heading-dense source without parsing it', () => {
    const dense = source('# x\n'.repeat(131072));
    const started = performance.now();
    expect(() => previewSource(dense)).toThrow('heading limit');
    expect(performance.now() - started).toBeLessThan(1500);
  });
  it.each([
    { kind: 'setext', content: 'a\n=\n'.repeat(8193) },
    { kind: 'emphasis', content: '*a'.repeat(4097) },
  ])('rejects excessive $kind Markdown work before parsing', ({ content }) => {
    expect(() => previewSource(source(content))).toThrow('Markdown complexity');
  });
  it('bounds repeated ancestor context across the complete preview', () => {
    const content =
      '# Shared\n' +
      'x'.repeat(60_000) +
      '\n' +
      Array.from(
        { length: 512 },
        (_, i) => `## Project ${i}\ncwd: /synthetic/p${i}\nKeep this fact.`,
      ).join('\n');
    expect(() => previewSource(source(content))).toThrow('expanded context');
    const small = previewSource(
      source(content.slice(0, content.indexOf('## Project 2\n'))),
    );
    expect(small.sections.length).toBeGreaterThan(1);
    expect(
      small.sections.every((section) =>
        section.content.includes('x'.repeat(100)),
      ),
    ).toBe(true);
  });
  it('keeps stable identities after reordering', () => {
    const a = '# Alpha\ncwd: /synthetic/alpha\nA.';
    const b = '# Beta\ncwd: /synthetic/beta\nB.';
    expect(previewSource(source(`${a}\n${b}`)).sections[0].id).toBe(
      previewSource(source(`${b}\n${a}`)).sections[1].id,
    );
  });
  it.each([
    '../secret.md',
    '/secret.md',
    'C:/secret.md',
    'rollout_summaries/../../secret.md',
    'sessions/chat.jsonl',
    'skills/SKILL.md',
    'config.toml',
    'rollout_summaries\\one.md',
  ])('rejects unsafe or excluded path %s', (file) => {
    expect(() =>
      validateSource({
        version: 1,
        source: 'codex',
        files: [{ path: file, content: 'private' }],
      }),
    ).toThrow();
  });
  it.each(['rollout_summaries/会话 记录.md', 'rollout_summaries/a b.md'])(
    'rejects the admitted-but-undiscoverable rollout name %s',
    (name) => {
      expect(() =>
        validateSource({
          version: 1,
          source: 'codex',
          files: [
            { path: 'MEMORY.md', content: '# Topic\ncwd: /x\nFact.' },
            { path: name, content: '# Detail\nFact.' },
          ],
        }),
      ).toThrow('Only memory Markdown');
    },
  );
  it('warns missing references and excludes unrelated supporting files', () => {
    const preview = previewSource({
      version: 1,
      source: 'codex',
      files: [
        {
          path: 'MEMORY.md',
          content: '# Topic\nReference rollout_summaries/missing.md',
        },
        {
          path: 'rollout_summaries/unrelated.md',
          content: '# Unrelated\nDo not import.',
        },
      ],
    });
    expect(preview.sections).toHaveLength(1);
    expect(preview.warnings).toHaveLength(2);
  });
  it('reads only allowed referenced Markdown locally and refuses symlink folders', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'memory-source-test-'),
    );
    roots.push(root);
    await fs.writeFile(
      path.join(root, 'MEMORY.md'),
      '# Topic\nrollout_summaries/one.md',
    );
    await fs.writeFile(path.join(root, 'credentials.json'), 'never read');
    await fs.mkdir(path.join(root, 'rollout_summaries'));
    await fs.writeFile(
      path.join(root, 'rollout_summaries/one.md'),
      '# Detail\ncwd: /synthetic/alpha\nA qualified fact.',
    );
    expect((await readLocalSource(root)).files.map((f) => f.path)).toEqual([
      'MEMORY.md',
      'rollout_summaries/one.md',
    ]);
    await fs.rename(
      path.join(root, 'rollout_summaries'),
      path.join(root, 'outside'),
    );
    await fs.symlink(
      path.join(root, 'outside'),
      path.join(root, 'rollout_summaries'),
    );
    await expect(readLocalSource(root)).rejects.toThrow('symlink');
  });
});
