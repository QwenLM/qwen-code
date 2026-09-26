/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildManagedAutoMemoryPrompt,
  CONDENSED_DO_NOT_SAVE_SECTION,
  CONDENSED_TEAM_GUIDANCE,
  CONDENSED_TYPES_SECTION,
  CONDENSED_WHEN_TO_ACCESS_SECTION,
  MAX_MANAGED_AUTO_MEMORY_INDEX_LINES,
} from './prompt.js';

const DIR = '/tmp/project/.qwen/memory';
const USER_DIR = '/home/u/.qwen/memories';
const TEAM_DIR = '/tmp/project/.qwen/team-memory';
const TERSE_INDEX =
  '- [User Memory](user/terse.md) — User prefers terse responses.';
const TEAM_INDEX = '- [Convention](feedback/tests.md) — use real DBs.';
const emptyUser = { memoryDir: USER_DIR, indexContent: null };
const emptyTeam = { memoryDir: TEAM_DIR, indexContent: null };
const FULL = { forceFullProtocol: true };

type RestArgs =
  Parameters<typeof buildManagedAutoMemoryPrompt> extends [string, ...infer R]
    ? R
    : never;
/** buildManagedAutoMemoryPrompt rooted at DIR. */
const buildPrompt = (...rest: RestArgs) =>
  buildManagedAutoMemoryPrompt(DIR, ...rest);

describe('managed auto-memory prompt helpers', () => {
  it('builds a condensed memory prompt when MEMORY.md is empty', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('# auto memory');
    expect(prompt).toContain('persistent, file-based memory system');
    expect(prompt).toContain(DIR);
    expect(prompt).toContain('currently empty');
    // Condensed prompt omits verbose sections
    expect(prompt).not.toContain('## What NOT to save in memory');
    expect(prompt).not.toContain('## When to access memories');
    expect(prompt).not.toContain('## Before recommending from memory');
    expect(prompt).not.toContain('## Memory and other forms of persistence');
  });

  it('embeds the current MEMORY.md index content', () => {
    const prompt = buildPrompt(TERSE_INDEX);

    expect(prompt).toContain('## /tmp/project/.qwen/memory/MEMORY.md');
    expect(prompt).toContain('[User Memory](user/terse.md)');
    expect(prompt).toContain('User prefers terse responses.');
  });

  it('warns extraction not to save MCP tool schemas or failed calls', () => {
    const prompt = buildPrompt('- [Note](note.md) — a note.');

    expect(prompt).toContain(
      'MCP tool names, parameter schemas, field mappings, guessed tool-call formats, or raw failed tool-call transcripts',
    );
    expect(prompt).toContain('confirmed durable workaround');
    expect(prompt).toContain('live tool definitions are authoritative');
  });

  it('builds a standalone managed auto-memory section', () => {
    const result = buildPrompt(
      '- [Reference](reference/grafana.md) — Grafana dashboard link.',
    );

    expect(result).toContain('# auto memory');
    expect(result.startsWith('# auto memory')).toBe(true);
  });

  it('adds a shared team tier when a team section is provided', () => {
    const prompt = buildPrompt('- [Project](project/x.md) — note.', emptyUser, {
      memoryDir: TEAM_DIR,
      indexContent: TEAM_INDEX,
    });

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).toContain(TEAM_DIR);
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
    const prompt = buildPrompt('- [Project](project/x.md) — note.', undefined, {
      memoryDir: TEAM_DIR,
      indexContent: TEAM_INDEX,
    });

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
    const prompt = buildPrompt(null, emptyUser);

    expect(prompt).not.toContain('TEAM memory');
    expect(prompt).not.toContain('## Saving to team memory');
    expect(prompt).toContain('two persistent, file-based memory directories');
  });

  it('truncates oversized managed auto-memory index content', () => {
    const oversizedIndex = Array.from(
      { length: MAX_MANAGED_AUTO_MEMORY_INDEX_LINES + 50 },
      (_, index) => `- [Memory ${index}](memory-${index}.md) — hook ${index}`,
    ).join('\n');
    const result = buildPrompt(oversizedIndex);

    expect(result).toContain(
      'WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded.',
    );
    expect(result.split('\n').length).toBeLessThan(400);
  });

  it('condensed prompt with empty indexes is significantly shorter than full', () => {
    const condensed = buildPrompt();
    const full = buildPrompt(undefined, undefined, undefined, FULL);

    expect(condensed.length).toBeLessThan(full.length / 2);
  });

  it.each<[string, RestArgs]>([
    ['emits full prompt when at least one index has content', [TERSE_INDEX]],
    [
      'emits full prompt with forceFullProtocol even when all indexes are empty',
      [null, undefined, undefined, FULL],
    ],
    [
      'emits full prompt when only userSection has content (project index empty)',
      [
        null,
        {
          memoryDir: USER_DIR,
          indexContent: '- [Pref](user/pref.md) — prefers dark mode.',
        },
      ],
    ],
  ])('%s', (_title, args) => {
    const prompt = buildPrompt(...args);

    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('emits condensed prompt for multi-tier setup when all indexes are empty', () => {
    const prompt = buildPrompt(null, emptyUser);

    // Condensed multi-tier still shows both dirs
    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).toContain(USER_DIR);
    expect(prompt).toContain(DIR);
    // Uses condensed sections, omits verbose full-protocol ones
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## How to save memories');
    expect(prompt).toContain('## Do not save');
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## What NOT to save in memory');
  });

  it('emits condensed prompt for three-tier setup with team section when all indexes are empty', () => {
    const prompt = buildPrompt(null, emptyUser, emptyTeam);

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    // Condensed team guidance, incl. the team auto-index rule (do NOT
    // hand-edit team MEMORY.md) and the condensed exclusion list, replaces
    // the full team scope section.
    expect(prompt).toContain(
      'route project-wide conventions and shared references to TEAM',
    );
    expect(prompt).toContain('do NOT hand-edit the team `MEMORY.md`');
    expect(prompt).toContain('## Do not save');
    expect(prompt).not.toContain('## Saving to team memory');
  });

  it('buildManagedAutoMemoryPrompt passes through options', () => {
    const withOptions = buildPrompt(null, undefined, undefined, FULL);
    const without = buildPrompt(null);

    // Full verbose sections with forceFullProtocol; condensed without it
    expect(withOptions).toContain('## Types of memory');
    expect(without).not.toContain('## Types of memory');
    expect(without).toContain('## Memory types');
  });

  it('treats whitespace-only indexContent as empty (triggers condensed)', () => {
    const prompt = buildPrompt('   \n  \t  \n  ');

    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## Do not save');
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## What NOT to save in memory');
    expect(prompt).toContain('currently empty');
  });

  it('emits condensed prompt for project+team two-tier without userSection (all empty)', () => {
    const prompt = buildPrompt(null, undefined, emptyTeam);

    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).not.toContain('USER memory');
    expect(prompt).toContain('TEAM memory');
    // Condensed sections and team guidance; full verbose sections omitted
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## Do not save');
    expect(prompt).toContain('## How to save memories');
    expect(prompt).toContain(
      'route project-wide conventions and shared references to TEAM',
    );
    expect(prompt).toContain('do NOT hand-edit the team `MEMORY.md`');
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## Saving to team memory');
  });

  it.each([
    [
      'condensed prompt includes maintenance directives',
      [
        'Keep the name, description, and type fields',
        'Organize memories semantically by topic',
        'Update or remove memories that turn out to be wrong',
      ],
    ],
    [
      'condensed prompt includes read-path behavioral guidance',
      [
        '## Accessing memories',
        'MUST access memory when the user explicitly asks',
        'ignore memory, proceed as if empty',
        'stale',
      ],
    ],
    [
      'condensed prompt includes surprising/non-obvious heuristic in do-not-save',
      ['surprising', 'non-obvious'],
    ],
    [
      'condensed prompt includes date normalization for project type and negative judgement for user type',
      ['convert relative dates to absolute dates', 'negative judgement'],
    ],
    [
      'condensed save section includes index truncation warning',
      ['lines after 200 will be truncated', 'keep each index concise'],
    ],
    [
      'condensed prompt includes persistence guidance',
      [
        'Use plans and tasks for in-conversation work; reserve memory for durable cross-conversation knowledge',
      ],
    ],
  ])('%s', (_title, needles) => {
    const prompt = buildPrompt();
    for (const needle of needles) expect(prompt).toContain(needle);
  });

  it('condensed multi-tier prompt includes cross-directory duplicate check', () => {
    expect(buildPrompt(null, emptyUser)).toContain(
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

  it.each([
    [
      'condensed do-not-save section covers all key exclusions from full version',
      CONDENSED_DO_NOT_SAVE_SECTION,
      [
        'conventions',
        'project structure',
        'recent changes',
        'who-changed-what',
        'guessed tool-call formats',
        'owner',
        'escalation path',
        'surprising',
        'non-obvious',
      ],
    ],
    [
      'condensed stale-memory bullet includes remediation step',
      CONDENSED_WHEN_TO_ACCESS_SECTION,
      ['trust what you observe now', 'update or remove the stale memory'],
    ],
    [
      // Separate exclusion bullets, not merged
      'condensed do-not-save splits git history and debugging solutions into separate bullets',
      CONDENSED_DO_NOT_SAVE_SECTION,
      [
        '- Git history, recent changes, or who-changed-what',
        '- Debugging solutions or fix recipes',
      ],
    ],
    [
      'condensed team guidance includes explicit credential types and user-memory privacy',
      CONDENSED_TEAM_GUIDANCE,
      [
        'never API keys, tokens, or credentials',
        '`user` memories are always private',
        'never save them to TEAM',
        '`MEMORY.md`', // backtick consistency
      ],
    ],
    [
      'condensed prompt includes verify-before-recommending guidance',
      CONDENSED_WHEN_TO_ACCESS_SECTION,
      ['verify it still exists in the current code'],
    ],
  ])('%s', (_title, section, needles) => {
    const joined = section.join('\n');
    for (const needle of needles) expect(joined).toContain(needle);
  });

  it('emits condensed prompt when forceFullProtocol is explicitly false', () => {
    const prompt = buildPrompt(null, undefined, undefined, {
      forceFullProtocol: false,
    });
    expect(prompt).toContain('## Memory types'); // condensed
    expect(prompt).not.toContain('## Types of memory'); // not full
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
});
