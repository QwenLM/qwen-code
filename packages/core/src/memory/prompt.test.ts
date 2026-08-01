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

describe('managed auto-memory prompt helpers', () => {
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

    expect(prompt).toContain('Keep the name, description, and type fields');
    expect(prompt).toContain('Organize memories semantically by topic');
    expect(prompt).toContain(
      'Update or remove memories that turn out to be wrong',
    );
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
