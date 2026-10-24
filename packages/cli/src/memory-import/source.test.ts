/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { previewSource, validateSource } from './source.js';
const source = (content: string) => ({
  version: 1,
  source: 'codex',
  files: [{ path: 'MEMORY.md', content }],
});
describe('Codex source preview', () => {
  it.each([
    '## /synthetic/alpha ##',
    '## `/synthetic/alpha`',
    '/synthetic/alpha\n===',
    '/synthetic/alpha\n---',
  ])('recognizes the project in Markdown heading %s', (heading) => {
    const preview = previewSource(source(`${heading}\nA qualified fact.`));
    expect(preview.sections).toHaveLength(1);
    expect(preview.sections[0].sourceProject).toBe('/synthetic/alpha');
    expect(preview.sections[0].content).toBe(`${heading}\nA qualified fact.`);
  });
  it('keeps the source digest independent of file order and locale', () => {
    const input = {
      version: 1,
      source: 'codex',
      files: [
        { path: 'MEMORY.md', content: '# Topic\nA qualified fact.' },
        {
          path: 'memory_summary.md',
          content: '## User profile\nPortable fact.',
        },
      ],
    };
    const before = previewSource(input);
    const compare = String.prototype.localeCompare;
    const localized = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (this: string, other: string) {
        return compare.call(this, other, 'th');
      });
    try {
      expect(
        previewSource({ ...input, files: [...input.files].reverse() }),
      ).toEqual(before);
    } finally {
      localized.mockRestore();
    }
  });
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
  it.each([
    {
      content:
        '# Shared\n## Alpha\n### Task\ncwd: /alpha\nAlpha fact\n## Beta\nBeta fact',
      project: '/alpha',
      siblingTitle: 'Beta',
      sibling: 'Beta fact',
    },
    {
      content:
        '# Knowledge\n## Notes\n### /beta\nBeta fact\n## Other\nOther fact',
      project: '/beta',
      siblingTitle: 'Other',
      sibling: 'Other fact',
    },
    {
      content:
        '# Shared\n## Alpha\n### Notes\n#### /beta\nBeta fact\n### Other\nOther fact',
      project: '/beta',
      siblingTitle: 'Other',
      sibling: 'Other fact',
    },
  ])(
    'keeps a later sibling visible as its own section when a project hint is nested',
    ({ content, project, siblingTitle, sibling }) => {
      const preview = previewSource(source(content));
      expect(preview.sections).toHaveLength(2);
      const projectSection = preview.sections.find(
        (section) => section.sourceProject === project,
      );
      expect(projectSection).toBeDefined();
      expect(projectSection?.content).not.toContain(sibling);
      const siblingSection = preview.sections.find(
        (section) => section.title === siblingTitle,
      );
      expect(siblingSection?.suggestedScope).toBe('unassigned');
      expect(siblingSection?.content).toContain(sibling);
      expect(preview.warnings).toEqual([]);
    },
  );
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
  it.each(['', '# Shared\n'])(
    'keeps task qualifiers intact with mixed project heading depths (%s)',
    (prefix) => {
      const marker = prefix ? '#' : '';
      const preview = previewSource(
        source(
          `${prefix}${marker}# Alpha\ncwd: /alpha\n${marker}## Task\nTask fact.\n${marker}### Caveat\nOnly on migrations.\n${marker}# Knowledge\n${marker}### /beta\nBeta fact.`,
        ),
      );
      const tasks = preview.sections.filter((section) =>
        section.content.includes('Task fact.'),
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].content).toContain('Only on migrations.');
      expect(tasks[0].content).not.toContain('Beta fact.');
      expect(
        preview.sections.find((section) => section.sourceProject === '/beta')
          ?.content,
      ).not.toContain('Task fact.');
    },
  );
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
  it('rejects more than 256 source files', () => {
    expect(() =>
      validateSource({
        version: 1,
        source: 'codex',
        files: [
          { path: 'MEMORY.md', content: '# Topic\nFact.' },
          ...Array.from({ length: 256 }, (_, i) => ({
            path: `rollout_summaries/${i}.md`,
            content: '# Detail\nFact.',
          })),
        ],
      }),
    ).toThrow('Invalid version 1 Codex source set.');
  });
  it('rejects a single file above 512 KiB', () => {
    expect(() =>
      validateSource(source(`# Topic\n${'x'.repeat(512 * 1024)}`)),
    ).toThrow('Source exceeds limits');
  });
  it('rejects aggregate source above 8 MiB', () => {
    expect(() =>
      validateSource({
        version: 1,
        source: 'codex',
        files: Array.from({ length: 17 }, (_, i) => ({
          path: i === 0 ? 'MEMORY.md' : `rollout_summaries/${i}.md`,
          content: 'x'.repeat(512 * 1024),
        })),
      }),
    ).toThrow('Source exceeds limits');
  });
  it('requires a root memory file', () => {
    expect(() =>
      validateSource({
        version: 1,
        source: 'codex',
        files: [
          { path: 'rollout_summaries/one.md', content: '# Detail\nFact.' },
        ],
      }),
    ).toThrow('Select the Codex memories folder');
  });
  it('rejects NUL content', () => {
    expect(() => validateSource(source('# Topic\n\0Fact.'))).toThrow(
      'Invalid Codex Markdown resource',
    );
  });
  it('includes the source path in section identities', () => {
    const preview = previewSource({
      version: 1,
      source: 'codex',
      files: [
        { path: 'MEMORY.md', content: '# Topic\nSame fact.' },
        { path: 'memory_summary.md', content: '# Topic\nSame fact.' },
      ],
    });
    expect(preview.sections.map((section) => section.path)).toEqual([
      'MEMORY.md',
      'memory_summary.md',
    ]);
    expect(new Set(preview.sections.map((section) => section.id)).size).toBe(2);
  });
  it('keeps sections above 64 KiB visible but unselectable', () => {
    const over = previewSource(source(`# Big\n${'x'.repeat(64 * 1024)}`));
    expect(over.sections).toHaveLength(1);
    expect(over.sections[0].selectable).toBe(false);
    expect(over.warnings[0]).toContain('exceeds 65536 bytes');

    const exact = previewSource(source(`# Big\n${'x'.repeat(64 * 1024 - 6)}`));
    expect(exact.sections[0].selectable).toBe(true);
  });
  it('excludes unselectable sections from the aggregate estimate', () => {
    const huge = `# Big\n${'x'.repeat(70_000)}`;
    const withHuge = previewSource(source(`${huge}\n# Small\nSmall fact.`));
    const withoutHuge = previewSource(source('# Small\nSmall fact.'));
    expect(
      withHuge.sections.find((section) => !section.selectable),
    ).toBeDefined();
    expect(withHuge.estimate).toEqual(withoutHuge.estimate);
  });
  it.each([
    ['rollout_summaries/One.md', 'rollout_summaries/one.md'],
    ['rollout_summaries/one.md', 'rollout_summaries/One.md'],
  ])(
    'rejects case-insensitive duplicate paths (%s then %s)',
    (first, second) => {
      expect(() =>
        validateSource({
          version: 1,
          source: 'codex',
          files: [
            { path: 'MEMORY.md', content: '# Topic\nFact.' },
            { path: first, content: '# One\nFact.' },
            { path: second, content: '# Two\nFact.' },
          ],
        }),
      ).toThrow('duplicate paths');
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
  it('keeps referenced evidence independently selectable', () => {
    const input = source('# Topic\nSee rollout_summaries/one.md for evidence.');
    input.files.push({
      path: 'rollout_summaries/one.md',
      content: '# Evidence\nA qualified fact.',
    });
    const preview = previewSource(input);
    expect(preview.sections).toHaveLength(2);
    expect(
      preview.sections.find((section) => section.path === 'MEMORY.md')
        ?.references,
    ).toEqual(['rollout_summaries/one.md']);
    expect(preview.sections.every((section) => section.selectable)).toBe(true);
    expect(preview.warnings).toEqual([]);
  });
});
