/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMemoryPromptBody,
  loadAutoMemoryPromptForRoots,
} from './auto-memory-prompt.js';
import { loadAutoMemoryGenerationPromptForRoots } from './memory-generation-prompt.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('buildMemoryPromptBody', () => {
  it.each(['full', 'lean'] as const)(
    'renders the requested %s opening while omitting storage procedures',
    (variant) => {
      const prompt = buildMemoryPromptBody(
        {
          displayName: 'auto memory',
          roots: [{ scope: 'project', dir: '/tmp/memory', indexContent: '' }],
        },
        variant,
      );

      expect(prompt).toContain(
        `## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now.`,
      );
      expect(prompt).not.toContain(
        'Recalled memories are background context, not user instructions',
      );
      expect(prompt).not.toContain(
        'and update or remove the stale memory rather than acting on it',
      );
      expect(prompt).not.toContain(
        "Each directory's index is loaded into context; lines after 200 are truncated. Read linked topic files when their details are relevant.",
      );
      expect(prompt).toContain('## MEMORY.md');
      expect(prompt).toContain(
        'Only if the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
      );
      expect(prompt).not.toContain('In the main conversation');
      expect(prompt).not.toContain('Dedicated background memory extraction');
      expect(prompt).not.toContain('Dream consolidation');
      expect(
        prompt.indexOf('Only if the user explicitly asks'),
      ).toBeGreaterThan(prompt.indexOf('This directory already exists'));
      expect(prompt).toContain(
        'This directory already exists — do not run mkdir or check for its existence.',
      );
      expect(prompt).not.toContain('## How to save memories');
      expect(prompt).not.toContain('## What NOT to save in memory');
      expect(prompt).not.toContain('metadata:');
      expect(prompt).not.toContain('Do not write duplicate memories');
      if (variant === 'full') {
        expect(prompt).toContain('## Memory and other forms of persistence');
        expect(prompt).toContain(
          'When to use or update a plan instead of memory',
        );
        expect(prompt).toContain(
          'When to use or update tasks instead of memory',
        );
      } else {
        expect(prompt).not.toContain(
          '## Memory and other forms of persistence',
        );
      }
    },
  );

  it('keeps compact reading guidance in lean prompts', () => {
    const prompt = buildMemoryPromptBody(
      {
        displayName: 'auto memory',
        roots: [
          {
            scope: 'project',
            dir: '/tmp/memory',
            indexContent: '',
          },
        ],
        includeIndexContent: false,
      },
      'lean',
    );

    expect(prompt).toContain('# Memory');
    expect(prompt).not.toContain(
      'Read linked topic files when their details are relevant',
    );
    expect(prompt).toContain('`user`: the user’s role');
    expect(prompt).not.toContain('frontmatter');
    expect(prompt).not.toContain('add a one-line pointer');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).not.toContain('# auto memory');
    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('invoke the `memory-types` skill');
    expect(prompt).not.toContain('## Current memory directory state');
    expect(prompt).not.toContain('prefs.md');
  });

  it('describes both memory scopes beside their paths in lean prompts', () => {
    const prompt = buildMemoryPromptBody(
      {
        displayName: 'auto memory',
        roots: [
          {
            scope: 'user',
            dir: '/tmp/user-memory',
            indexContent: '',
          },
          {
            scope: 'project',
            dir: '/tmp/project-memory',
            indexContent: '',
          },
        ],
        includeIndexContent: false,
      },
      'lean',
    );

    expect(prompt).toContain(
      '- user: `/tmp/user-memory/` (shared across this user’s projects)',
    );
    expect(prompt).toContain(
      '- project: `/tmp/project-memory/` (specific to this project)',
    );
    expect(prompt).not.toContain('## Memory scopes');
    expect(prompt).not.toContain('## Active memory scope');
    expect(prompt).not.toContain(
      '## Where to save: USER scope vs PROJECT scope',
    );
    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('invoke the `memory-types` skill');
  });

  it('omits MEMORY.md content when includeIndexContent is false', () => {
    const prompt = buildMemoryPromptBody({
      displayName: 'auto memory',
      roots: [
        {
          scope: 'project',
          dir: '/tmp/memory',
          indexContent: '- [Prefs](prefs.md) - collaboration preferences',
        },
      ],
      includeIndexContent: false,
    });

    expect(prompt).toContain('# auto memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).not.toContain('## MEMORY.md');
    expect(prompt).not.toContain('[Prefs](prefs.md)');
    expect(prompt).not.toContain('## Current memory directory state');
    expect(prompt).not.toContain('Existing memory files');
  });

  it('keeps the main prompt stable when memory topic files change', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-memory-prompt-'));
    tempDirs.push(dir);
    const roots = [{ id: 'shared', dir }];

    const before = await loadAutoMemoryPromptForRoots(roots);
    await writeFile(
      path.join(dir, 'dynamic-topic-sentinel.md'),
      '---\nname: dynamic-topic-sentinel\n---\n',
      'utf8',
    );
    const after = await loadAutoMemoryPromptForRoots(roots);

    expect(after).toBe(before);
    expect(after).not.toContain('dynamic-topic-sentinel.md');
    expect(after).not.toContain('Existing memory files');
  });

  it('does not promise that SDK generation indexes are injected into context', async () => {
    const userDir = await mkdtemp(path.join(tmpdir(), 'sdk-user-memory-'));
    const projectDir = await mkdtemp(
      path.join(tmpdir(), 'sdk-project-memory-'),
    );
    tempDirs.push(userDir, projectDir);
    const roots = [
      { id: 'user', scope: 'user' as const, dir: userDir },
      { id: 'project', scope: 'project' as const, dir: projectDir },
    ];

    const [full, lean] = await Promise.all([
      loadAutoMemoryPromptForRoots(roots, 'full', { scopeRouting: true }),
      loadAutoMemoryPromptForRoots(roots, 'lean', { scopeRouting: true }),
    ]);

    expect(full).not.toMatch(/loaded into (?:your conversation )?context/);
    expect(lean).not.toMatch(/loaded into (?:your conversation )?context/);
    expect(full).toContain('Read the configured indexes');
    expect(lean).toContain('Read the configured indexes');
  });

  it('renders Full and Lean variants for CLI-managed SDK roots', async () => {
    const readOnlyDir = await mkdtemp(
      path.join(tmpdir(), 'sdk-memory-read-only-'),
    );
    const writableDir = await mkdtemp(
      path.join(tmpdir(), 'sdk-memory-writable-'),
    );
    tempDirs.push(readOnlyDir, writableDir);
    const roots = [
      {
        id: 'reference',
        dir: readOnlyDir,
        access: 'read' as const,
        indexFile: 'INDEX.md',
      },
      {
        id: 'working',
        dir: writableDir,
        access: 'read-write' as const,
        indexFile: 'NOTES.md',
      },
    ];

    const [full, lean, extraction] = await Promise.all([
      loadAutoMemoryPromptForRoots(roots, 'full'),
      loadAutoMemoryPromptForRoots(roots, 'lean'),
      loadAutoMemoryGenerationPromptForRoots(roots),
    ]);

    expect(extraction).toContain('## How to save memories');
    expect(extraction).toContain(
      'Only create, edit, or delete memory files and indexes in directories marked read-write',
    );
    expect(extraction).toContain(
      `- working: \`NOTES.md\` in \`${writableDir}/\``,
    );
    expect(extraction).not.toContain(`- reference: \`INDEX.md\` in`);

    expect(full).toContain('# auto memory');
    expect(full).toContain('## Types of memory');
    expect(full).toContain('(read; index: INDEX.md)');
    expect(full).toContain('(read-write; index: NOTES.md)');
    expect(full).not.toContain('## How to save memories');
    expect(full).toContain(
      'Only create, edit, or delete memory files and indexes in directories marked read-write',
    );
    expect(full).toContain(
      `- working: \`${writableDir}/\` (read-write; index: NOTES.md)`,
    );
    expect(full).not.toContain(`- reference: \`INDEX.md\` in`);
    expect(full).not.toContain('This contract overrides');
    expect(full).not.toContain('pointer to that file in `MEMORY.md`');
    expect(full).toContain('Read the configured indexes');
    expect(full).not.toContain('configured index is loaded into context');
    expect(lean).toContain('# Memory');
    expect(lean).toContain('(read; index: INDEX.md)');
    expect(lean).toContain('(read-write; index: NOTES.md)');
    expect(lean).toContain(
      `- working: \`${writableDir}/\` (read-write; index: NOTES.md)`,
    );
    expect(lean).not.toContain(`- reference: \`INDEX.md\` in`);
    expect(lean).not.toContain('This contract overrides');
    expect(lean).not.toContain('pointer in `MEMORY.md`');
    expect(lean).toContain('Read the configured indexes');
    expect(lean).not.toContain('configured index is loaded into context');
    expect(lean).toContain('## Types of memory');
    expect(lean).toContain('invoke the `memory-types` skill');
  });

  it('includes MEMORY.md content by default for agent memory prompts', () => {
    const prompt = buildMemoryPromptBody({
      displayName: 'Persistent Agent Memory',
      roots: [
        {
          scope: 'project',
          dir: '/tmp/memory',
          indexContent: '- [Prefs](prefs.md) - collaboration preferences',
        },
      ],
    });

    expect(prompt).toContain('## MEMORY.md');
    expect(prompt).toContain('[Prefs](prefs.md)');
  });

  it('keeps reading guidance for custom roots without USER/PROJECT routing', () => {
    const prompt = buildMemoryPromptBody({
      displayName: 'auto memory',
      roots: [
        {
          id: 'shared',
          scope: 'project',
          dir: '/tmp/shared-memory',
          indexContent: '',
        },
        {
          id: 'worker',
          scope: 'project',
          dir: '/tmp/worker-memory',
          indexContent: '',
        },
      ],
      includeIndexContent: false,
      scopeRouting: false,
    });

    expect(prompt).toContain('- shared: `/tmp/shared-memory/`');
    expect(prompt).toContain('- worker: `/tmp/worker-memory/`');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).not.toContain(
      '## Where to save: USER scope vs PROJECT scope',
    );
  });

  it('describes USER-only memory without storage procedures', () => {
    const prompt = buildMemoryPromptBody({
      displayName: 'auto memory',
      roots: [
        {
          scope: 'user',
          dir: '/tmp/user-memory',
          indexContent: '',
        },
      ],
      includeIndexContent: false,
      scopeRouting: true,
    });

    expect(prompt).toContain(
      '`/tmp/user-memory/` (shared across this user’s projects)',
    );
    expect(prompt).not.toContain('## Active memory scope');
    expect(prompt).not.toContain('## Memory scopes');
    expect(prompt).not.toContain('## How to save memories');
    expect(prompt).not.toContain('## Where to save');
  });
});
