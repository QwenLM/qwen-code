/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildManagedAutoMemoryIndex } from './indexer.js';
import {
  INDEX_TRUNCATION_NOTICE,
  INDEX_TRUNCATION_WARNING,
  MAX_INDEX_CHARS,
  MAX_INDEX_LINE_CHARS,
} from './index-budget.js';
import {
  buildManagedAutoMemoryPrompt,
  buildStructuredAutoMemoryPrompt,
  CONDENSED_DO_NOT_SAVE_SECTION,
  CONDENSED_TEAM_GUIDANCE,
  CONDENSED_TYPES_SECTION,
  CONDENSED_WHEN_TO_ACCESS_SECTION,
  MAX_MANAGED_AUTO_MEMORY_INDEX_LINES,
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_METADATA_ITEM_BOUNDS,
} from './prompt.js';

describe('managed auto-memory prompt helpers', () => {
  it('keeps the structured main-model contract minimal', () => {
    const prompt = buildStructuredAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '/home/user/.qwen/memories',
      '/tmp/project/.qwen/team-memory',
    );

    expect(prompt).toContain('complete tree and focused metadata');
    expect(prompt).toContain('search_memory only when');
    expect(prompt).toContain(
      'manage_memory only when the user explicitly asks to remember, update, or forget',
    );
    expect(prompt).not.toContain('frontmatter');
    expect(prompt).not.toContain('usage_scenarios');
    expect(prompt).not.toContain('## Memory categories');
    expect(prompt).not.toContain('```markdown');
  });

  it('builds a condensed memory prompt when MEMORY.md is empty', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('# auto memory');
    expect(prompt).toContain('persistent, file-based memory system');
    expect(prompt).toContain('/tmp/project/.qwen/memory');
    expect(prompt).toContain('currently empty');
    // Condensed prompt omits verbose sections
    expect(prompt).not.toContain('## What NOT to save in memory');
    expect(prompt).not.toContain('## When to access memories');
    expect(prompt).not.toContain('## Before recommending from memory');
    expect(prompt).not.toContain('## Memory and other forms of persistence');
  });

  it('embeds the current MEMORY.md index content', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [User Memory](user/terse.md) — User prefers terse responses.',
    );

    expect(prompt).toContain('## /tmp/project/.qwen/memory/MEMORY.md');
    expect(prompt).toContain('[User Memory](user/terse.md)');
    expect(prompt).toContain('User prefers terse responses.');
  });

  it('warns extraction not to save MCP tool schemas or failed calls', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Note](note.md) — a note.',
    );

    expect(prompt).toContain(
      'MCP tool names, parameter schemas, field mappings, guessed tool-call formats, or raw failed tool-call transcripts',
    );
    expect(prompt).toContain('confirmed durable workaround');
    expect(prompt).toContain('live tool definitions are authoritative');
  });

  it('builds a standalone managed auto-memory section', () => {
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Reference](reference/grafana.md) — Grafana dashboard link.',
    );

    expect(result).toContain('# auto memory');
    expect(result.startsWith('# auto memory')).toBe(true);
  });

  it('adds a shared team tier when a team section is provided', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Project](project/x.md) — note.',
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
      {
        memoryDir: '/tmp/project/.qwen/team-memory',
        indexContent: '- [Convention](feedback/tests.md) — use real DBs.',
      },
    );

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).toContain('/tmp/project/.qwen/team-memory');
    expect(prompt).toContain('## Saving to team memory');
    expect(prompt).toContain('MUST NOT save sensitive data to TEAM memory');
    // The team index is auto-generated; the model must not hand-edit it.
    expect(prompt).toContain('generated automatically from the saved files');
    // The team index block is rendered with its own content.
    expect(prompt).toContain('## /tmp/project/.qwen/team-memory/MEMORY.md');
    expect(prompt).toContain('[Convention](feedback/tests.md)');
    // PROJECT is now described as private; the old misleading wording is gone.
    expect(prompt).toContain(
      'PROJECT memory (this project only, private to you)',
    );
    expect(prompt).not.toContain('may be shared with teammates');
  });

  it('renders a two-tier project+team prompt when no user section is given', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Project](project/x.md) — note.',
      undefined,
      {
        memoryDir: '/tmp/project/.qwen/team-memory',
        indexContent: '- [Convention](feedback/tests.md) — use real DBs.',
      },
    );

    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).not.toContain('USER memory');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).toContain('## Saving to team memory');
    // PROJECT index block comes before the TEAM index block.
    expect(
      prompt.indexOf('## /tmp/project/.qwen/memory/MEMORY.md'),
    ).toBeLessThan(
      prompt.indexOf('## /tmp/project/.qwen/team-memory/MEMORY.md'),
    );
  });

  it('omits the team tier when no team section is provided', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      {
        memoryDir: '/home/u/.qwen/memories',
        indexContent: null,
      },
    );

    expect(prompt).not.toContain('TEAM memory');
    expect(prompt).not.toContain('## Saving to team memory');
    expect(prompt).toContain('two persistent, file-based memory directories');
  });

  it('truncates oversized managed auto-memory index content', () => {
    const oversizedIndex = Array.from(
      { length: MAX_MANAGED_AUTO_MEMORY_INDEX_LINES + 50 },
      (_, index) => `- [Memory ${index}](memory-${index}.md) — hook ${index}`,
    ).join('\n');
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      oversizedIndex,
    );

    expect(result).toContain(
      'WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded.',
    );
    expect(result.split('\n').length).toBeLessThan(400);
  });

  it.each(['project', 'user', 'team'] as const)(
    'drops an oversized %s index entry whole and retains subsequent complete links',
    (scope) => {
      const oversizedEntry = `- [Oversized](reference/${'%28'.repeat(9_000)}.md)`;
      const retainedEntry = '- [Retained](reference/kept%28note%29.md)';
      const index = `${oversizedEntry}\n${retainedEntry}`;
      const result = buildManagedAutoMemoryPrompt(
        '/tmp/project/.qwen/memory',
        scope === 'project' ? index : null,
        scope === 'user'
          ? { memoryDir: '/home/u/.qwen/memories', indexContent: index }
          : undefined,
        scope === 'team'
          ? { memoryDir: '/tmp/project/.qwen/team-memory', indexContent: index }
          : undefined,
      );

      expect(result).not.toContain('- [Oversized](');
      expect(result).toContain(retainedEntry);
      expect(result).toContain('Only part of it was loaded.');
      expect(result).toContain(
        `one line at most ${MAX_INDEX_LINE_CHARS} UTF-16 code units`,
      );
    },
  );

  it('does not load a partial link from an oversized index with no newline', () => {
    const index = `- [Oversized](reference/${'%28'.repeat(9_000)}.md)`;
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      index,
    );

    expect(result).not.toContain('- [Oversized](');
    expect(result).toContain('Only part of it was loaded.');
  });

  it.each([
    ['project', '\n'],
    ['user', '\n'],
    ['team', '\n'],
    ['project', '\r\n'],
    ['user', '\r\n'],
    ['team', '\r\n'],
  ] as const)(
    'keeps every writer-retained entry in the %s prompt with %j line endings',
    (scope, newline) => {
      const doc = (relativePath: string, title: string) => ({
        scope: 'project' as const,
        type: 'reference' as const,
        relativePath,
        filePath: `/tmp/memory/${relativePath}`,
        filename: relativePath.slice(relativePath.lastIndexOf('/') + 1),
        title,
        description: 'h'.repeat(150),
        category: 'uncategorized' as const,
        keywords: [],
        usageScenarios: [],
        body: '',
        mtimeMs: 0,
      });
      // Legal path components can expand into long percent-encoded targets.
      const longDocs = ['A', 'B', 'C'].map((label) =>
        doc(
          `reference/${[
            ...Array.from(
              { length: 14 },
              (_, i) => `${label}${' '.repeat(253)}${i % 10}`,
            ),
            `${label}${' '.repeat(250)}b.md`,
          ].join('/')}`,
          label.repeat(120),
        ),
      );
      const ordinaryDocs = Array.from({ length: 12 }, (_, i) =>
        doc(`reference/normal-${i}.md`, `Normal ${i}`),
      );
      const generated = buildManagedAutoMemoryIndex([
        ...longDocs,
        ...ordinaryDocs,
      ]);
      const entries = generated
        .split('\n')
        .filter((line) => line.startsWith('- ['));
      expect(entries).toHaveLength(14);
      expect(generated.length).toBeGreaterThan(25_000);
      expect(generated).toContain('only part of it was written.');
      const index = generated.replaceAll('\n', newline);
      const result = buildManagedAutoMemoryPrompt(
        '/tmp/project/.qwen/memory',
        scope === 'project' ? index : null,
        scope === 'user'
          ? { memoryDir: '/home/u/.qwen/memories', indexContent: index }
          : undefined,
        scope === 'team'
          ? { memoryDir: '/tmp/project/.qwen/team-memory', indexContent: index }
          : undefined,
      );

      for (const entry of entries) {
        expect(result).toContain(entry);
      }
      expect(result).toContain('Only part of it was loaded.');
    },
  );

  it('keeps all 200 writer-retained entries when the notice exceeds the line limit', () => {
    const entries = Array.from(
      { length: 200 },
      (_, i) => `- [Memory ${i}](memory-${i}.md)`,
    );
    const index = `${entries.join('\n')}${INDEX_TRUNCATION_NOTICE}`;
    const result = buildManagedAutoMemoryPrompt('/tmp/memory', index);

    for (const entry of entries) {
      expect(result).toContain(entry);
    }
    expect(result).toContain('202 lines (limit: 200)');
  });

  it('does not strip handwritten warning-like text from an over-budget index', () => {
    const retained = '> WARNING: a handwritten memory note';
    const index = `- [Oversized](reference/${'%28'.repeat(9_000)}.md)\n\n${retained}`;
    const result = buildManagedAutoMemoryPrompt('/tmp/memory', index);

    expect(result).toContain(retained);
    expect(result).not.toContain('- [Oversized](');
  });

  it.each([
    ['project', '\r\n'],
    ['user', '\r\n'],
    ['team', '\r\n'],
    ['project', '\r'],
    ['user', '\r'],
    ['team', '\r'],
  ] as const)(
    'preserves 150-code-unit entry priority in the %s prompt with %j line endings',
    (scope, newline) => {
      const entry = (label: string, length: number) => {
        const prefix = `- [${label}](notes/`;
        return `${prefix}${'a'.repeat(length - prefix.length - 1)})`;
      };
      const long = Array.from({ length: 40 }, (_, i) =>
        entry(`Long ${i}`, 600),
      );
      const ordinary = Array.from({ length: 60 }, (_, i) =>
        entry(`Ordinary ${i}`, MAX_INDEX_LINE_CHARS),
      );
      const render = (index: string) =>
        buildManagedAutoMemoryPrompt(
          '/tmp/memory',
          scope === 'project' ? index : null,
          scope === 'user'
            ? { memoryDir: '/tmp/user-memory', indexContent: index }
            : undefined,
          scope === 'team'
            ? { memoryDir: '/tmp/team-memory', indexContent: index }
            : undefined,
        );
      const lines = [...long, ...ordinary];
      const expected = render(lines.join('\n'));
      const result = render(lines.join(newline));

      for (const line of ordinary) {
        expect(expected).toContain(line);
        expect(result).toContain(line);
      }
      expect(result).toBe(expected);
    },
  );

  it('does not let CRLF overhead evict an entry from an exactly full LF body', () => {
    const lines = [
      'a'.repeat(MAX_INDEX_CHARS - 3 * 150 - 3),
      ...['A', 'B', 'C'].map((label) => label.repeat(150)),
    ];
    const index = lines.join('\n');
    expect(index).toHaveLength(MAX_INDEX_CHARS);
    const expected = buildManagedAutoMemoryPrompt('/tmp/memory', index);
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/memory',
      index.replaceAll('\n', '\r\n'),
    );
    for (const line of lines) expect(result).toContain(line);
    expect(result).toBe(expected);
    expect(result).not.toContain('Only part of it was loaded.');
  });

  it.each(['\r\n', '\r', '\n\r\n'])(
    'recognizes the exact writer notice after normalizing %j separators',
    (separator) => {
      const first = `- [Long](notes/${'a'.repeat(24_830)}.md)`;
      const ordinary = '- [Ordinary](notes/ordinary.md)';
      const body = `${first}\n${ordinary}`;
      expect(body.length).toBeLessThan(MAX_INDEX_CHARS);
      const canonical = `${body}\n\n${INDEX_TRUNCATION_WARNING}`;
      expect(canonical.length).toBeGreaterThan(MAX_INDEX_CHARS);
      const result = buildManagedAutoMemoryPrompt(
        '/tmp/memory',
        `${body}${separator}${separator}${INDEX_TRUNCATION_WARNING}`,
      );
      expect(result).toContain(first);
      expect(result).toContain(ordinary);
      expect(result).not.toContain(INDEX_TRUNCATION_WARNING);
    },
  );

  it.each(['\n', '\r\n'])(
    'keeps an under-budget writer omission notice with %j line endings',
    (newline) => {
      const entry = '- [Retained](notes/retained.md)';
      const result = buildManagedAutoMemoryPrompt(
        '/tmp/memory',
        `${entry}${newline}${newline}${INDEX_TRUNCATION_WARNING}`,
      );
      expect(result).toContain(entry);
      expect(result).toContain(INDEX_TRUNCATION_WARNING);
      expect(result).not.toContain('Only part of it was loaded.');
    },
  );

  it.each([
    [
      '中'.repeat(MAX_INDEX_CHARS + 1),
      `${MAX_INDEX_CHARS + 1} UTF-16 code units (limit: ${MAX_INDEX_CHARS})`,
    ],
    [
      Array.from({ length: 201 }, () => '中'.repeat(125)).join('\n'),
      '201 lines and 25325 UTF-16 code units',
    ],
  ])(
    'reports the actual code-unit count for non-ASCII input',
    (index, reason) => {
      const result = buildManagedAutoMemoryPrompt('/tmp/memory', index);
      expect(result).toContain(reason);
      expect(result).not.toContain(' KB');
    },
  );

  it('condensed prompt with empty indexes is significantly shorter than full', () => {
    const condensed = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');
    const full = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      undefined,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );

    // Condensed should be less than half the length of full
    expect(condensed.length).toBeLessThan(full.length / 2);
  });

  it('emits full prompt when at least one index has content', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [User Memory](user/terse.md) — User prefers terse responses.',
    );

    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('emits full prompt with forceFullProtocol even when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );

    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('emits condensed prompt for multi-tier setup when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
    );

    // Condensed multi-tier still shows both dirs
    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).toContain('/home/u/.qwen/memories');
    expect(prompt).toContain('/tmp/project/.qwen/memory');
    // Uses condensed sections
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## How to save memories');
    expect(prompt).toContain('## Do not save');
    // Omits verbose full-protocol sections
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## What NOT to save in memory');
  });

  it('emits condensed prompt for three-tier setup with team section when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
      { memoryDir: '/tmp/project/.qwen/team-memory', indexContent: null },
    );

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    // Condensed team guidance is present
    expect(prompt).toContain(
      'route project-wide conventions and shared references to TEAM',
    );
    // Team auto-index guidance is present (do NOT hand-edit team MEMORY.md)
    expect(prompt).toContain('do NOT hand-edit the team `MEMORY.md`');
    // Condensed exclusion list is present
    expect(prompt).toContain('## Do not save');
    // Full team scope section is omitted
    expect(prompt).not.toContain('## Saving to team memory');
  });

  it('buildManagedAutoMemoryPrompt passes through options', () => {
    const withOptions = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );
    const without = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
    );

    // With forceFullProtocol, full verbose sections are present
    expect(withOptions).toContain('## Types of memory');
    // Without it, condensed prompt is returned
    expect(without).not.toContain('## Types of memory');
    expect(without).toContain('## Memory types');
  });

  it('emits full prompt when only userSection has content (project index empty)', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      {
        memoryDir: '/home/u/.qwen/memories',
        indexContent: '- [Pref](user/pref.md) — prefers dark mode.',
      },
    );

    // Full verbose sections should be present because userSection has content
    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('treats whitespace-only indexContent as empty (triggers condensed)', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '   \n  \t  \n  ',
    );

    // Should take the condensed path
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## Do not save');
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## What NOT to save in memory');
    expect(prompt).toContain('currently empty');
  });

  it('emits condensed prompt for project+team two-tier without userSection (all empty)', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      { memoryDir: '/tmp/project/.qwen/team-memory', indexContent: null },
    );

    // Two-tier (project + team), no user section
    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).not.toContain('USER memory');
    expect(prompt).toContain('TEAM memory');
    // Uses condensed sections
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## Do not save');
    expect(prompt).toContain('## How to save memories');
    // Condensed team guidance is present
    expect(prompt).toContain(
      'route project-wide conventions and shared references to TEAM',
    );
    expect(prompt).toContain('do NOT hand-edit the team `MEMORY.md`');
    // Full verbose sections are omitted
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## Saving to team memory');
  });

  it('condensed prompt includes maintenance directives', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain(
      'Keep the name, description, type, category, keywords, and usage_scenarios fields',
    );
    expect(prompt).toContain('one independently retrievable fact or rule');
    expect(prompt).toContain('body near or below 1,200 characters');
    expect(prompt).toContain('discriminative retrieval terms or short phrases');
    expect(prompt).toContain('domain-qualified phrases');
    expect(prompt).toContain('Organize memories semantically by topic');
    expect(prompt).toContain(
      'Update or remove memories that turn out to be wrong',
    );
  });

  it('states the per-item frontmatter bounds in the writer example', () => {
    const example = MEMORY_FRONTMATTER_EXAMPLE.join('\n');

    expect(example).toContain('at most 64 characters');
    expect(example).toContain('unique case-insensitively');
  });

  it('tells writers to double-quote values YAML would misparse', () => {
    // An unquoted keyword like `git: bisect`, `#1234`, or `!important` is
    // parsed by YAML as a map / comment / unresolved tag — the hazard list
    // has no last corner, so the recipe requires quoting unconditionally.
    const example = MEMORY_FRONTMATTER_EXAMPLE.join('\n');

    const keywordsLine = example
      .split('\n')
      .find((line) => line.includes('discriminative retrieval terms'));
    const scenariosLine = example
      .split('\n')
      .find((line) => line.includes('future tasks'));
    expect(keywordsLine).toContain('double-quote every value');
    expect(scenariosLine).toContain('double-quote every value');
    expect(example).not.toContain('starts with "#"');
    expect(MEMORY_METADATA_ITEM_BOUNDS).toContain('double-quote every');
  });

  it('condensed prompt includes read-path behavioral guidance', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('## Accessing memories');
    expect(prompt).toContain(
      'MUST access memory when the user explicitly asks',
    );
    expect(prompt).toContain('ignore memory, proceed as if empty');
    expect(prompt).toContain('stale');
  });

  it('condensed prompt includes surprising/non-obvious heuristic in do-not-save', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('surprising');
    expect(prompt).toContain('non-obvious');
  });

  it('condensed prompt includes date normalization for project type and negative judgement for user type', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('convert relative dates to absolute dates');
    expect(prompt).toContain('negative judgement');
  });

  it('condensed multi-tier prompt includes cross-directory duplicate check', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
    );

    expect(prompt).toContain(
      'check if there is an existing memory in any of your memory directories',
    );
  });

  it('exports CONDENSED_DO_NOT_SAVE_SECTION and CONDENSED_WHEN_TO_ACCESS_SECTION as module constants', () => {
    expect(CONDENSED_DO_NOT_SAVE_SECTION).toBeDefined();
    expect(CONDENSED_DO_NOT_SAVE_SECTION.length).toBeGreaterThan(0);
    expect(CONDENSED_WHEN_TO_ACCESS_SECTION).toBeDefined();
    expect(CONDENSED_WHEN_TO_ACCESS_SECTION.length).toBeGreaterThan(0);
  });

  it('exports CONDENSED_TEAM_GUIDANCE with user-memory privacy rule', () => {
    expect(CONDENSED_TEAM_GUIDANCE).toBeDefined();
    expect(CONDENSED_TEAM_GUIDANCE.length).toBeGreaterThan(0);
    const joined = CONDENSED_TEAM_GUIDANCE.join('\n');
    expect(joined).toContain('`user` memories are always private');
    expect(joined).toContain('never save them to TEAM');
  });

  it('condensed do-not-save section covers all key exclusions from full version', () => {
    const joined = CONDENSED_DO_NOT_SAVE_SECTION.join('\n');
    expect(joined).toContain('conventions');
    expect(joined).toContain('project structure');
    expect(joined).toContain('recent changes');
    expect(joined).toContain('who-changed-what');
    expect(joined).toContain('guessed tool-call formats');
    expect(joined).toContain('owner');
    expect(joined).toContain('escalation path');
    expect(joined).toContain('surprising');
    expect(joined).toContain('non-obvious');
  });

  it('condensed stale-memory bullet includes remediation step', () => {
    const joined = CONDENSED_WHEN_TO_ACCESS_SECTION.join('\n');
    expect(joined).toContain('trust what you observe now');
    expect(joined).toContain('update or remove the stale memory');
  });

  it('condensed save section includes index truncation warning', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');
    expect(prompt).toContain('lines after 200 will be truncated');
    expect(prompt).toContain('keep each index concise');
  });

  it('emits condensed prompt when forceFullProtocol is explicitly false', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      undefined,
      { forceFullProtocol: false },
    );
    expect(prompt).toContain('## Memory types'); // condensed
    expect(prompt).not.toContain('## Types of memory'); // not full
  });

  it('condensed do-not-save splits git history and debugging solutions into separate bullets', () => {
    const joined = CONDENSED_DO_NOT_SAVE_SECTION.join('\n');
    // These should be separate exclusion bullets, not merged
    expect(joined).toContain(
      '- Git history, recent changes, or who-changed-what',
    );
    expect(joined).toContain('- Debugging solutions or fix recipes');
  });

  it('exports CONDENSED_TYPES_SECTION with scope guidance for all four types', () => {
    expect(CONDENSED_TYPES_SECTION).toBeDefined();
    const joined = CONDENSED_TYPES_SECTION.join('\n');
    expect(joined).toContain('**user**');
    expect(joined).toContain('**feedback**');
    expect(joined).toContain('**project**');
    expect(joined).toContain('**reference**');
    // Scope routing guidance
    expect(joined).toContain('always user-scoped');
    expect(joined).toContain('always project-scoped');
    expect(joined).toContain('default user');
    expect(joined).toContain('default project');
    // Key behavioral notes
    expect(joined).toContain('Record from both failure and success');
    expect(joined).toContain('convert relative dates to absolute dates');
  });

  it('condensed team guidance includes explicit credential types and user-memory privacy', () => {
    const joined = CONDENSED_TEAM_GUIDANCE.join('\n');
    expect(joined).toContain('never API keys, tokens, or credentials');
    expect(joined).toContain('`user` memories are always private');
    expect(joined).toContain('never save them to TEAM');
    expect(joined).toContain('`MEMORY.md`'); // backtick consistency
  });

  it('condensed prompt includes verify-before-recommending guidance', () => {
    const joined = CONDENSED_WHEN_TO_ACCESS_SECTION.join('\n');
    expect(joined).toContain('verify it still exists in the current code');
  });

  it('condensed prompt includes persistence guidance', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');
    expect(prompt).toContain(
      'Use plans and tasks for in-conversation work; reserve memory for durable cross-conversation knowledge',
    );
  });
});
