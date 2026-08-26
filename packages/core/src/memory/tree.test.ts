/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { MemorySourceStatus, ScannedAutoMemoryDocument } from './scan.js';
import {
  buildAutoMemoryTree,
  createAutoMemoryTreeSnapshot,
  renderAutoMemoryFocusedSubtree,
} from './tree.js';

const sourceStatus: MemorySourceStatus = {
  requestedScopes: ['project'],
  searchedScopes: ['project'],
  unavailableScopes: [],
  complete: true,
  incompleteScopes: [],
};

function doc(
  relativePath: string,
  overrides: Partial<ScannedAutoMemoryDocument> = {},
): ScannedAutoMemoryDocument {
  return {
    scope: 'project',
    type: 'project',
    filePath: `/tmp/memory/${relativePath}`,
    relativePath,
    filename: relativePath.split('/').at(-1) ?? relativePath,
    title: relativePath,
    description: 'description trigger',
    category: 'project_introduction',
    keywords: ['memory architecture'],
    usageScenarios: ['designing memory recall'],
    body: 'SECRET BODY DETAIL',
    mtimeMs: 1,
    ...overrides,
  };
}

describe('auto memory tree rendering', () => {
  it('does not repeat a legacy description fallback as a usage scenario', () => {
    const memory = doc('project/legacy.md', {
      description: 'Legacy description',
      usageScenarios: ['Legacy description'],
    });
    const focused = renderAutoMemoryFocusedSubtree([memory]).prompt;

    expect(focused.match(/Legacy description/gu)).toHaveLength(1);
  });

  it('builds a two-level tree sorted by fixed category order', () => {
    const tree = buildAutoMemoryTree([
      doc('feedback/test.md', {
        category: 'testing_standard',
        keywords: ['testing policy'],
      }),
      doc('project/intro.md', {
        category: 'project_introduction',
        keywords: ['memory architecture'],
      }),
    ]);

    expect(tree.categories.map((category) => category.category)).toEqual([
      'project_introduction',
      'testing_standard',
    ]);
    expect(tree.categories[0]?.leaves[0]?.memoryRef).toBe(
      'project:project/intro.md',
    );
  });

  it('deduplicates all child keywords before limiting category summaries', () => {
    const keywords = Array.from({ length: 12 }, (_, index) => `term-${index}`);
    const tree = buildAutoMemoryTree([
      doc('project/one.md', {
        keywords: ['shared', 'Shared', ...keywords],
      }),
      doc('project/two.md', {
        keywords: ['shared', 'tail-term'],
      }),
    ]);
    const category = tree.categories[0];

    expect(category?.keywords).toHaveLength(12);
    expect(category?.keywords[0]).toBe('shared');
    expect(category?.hiddenKeywordCount).toBe(2);
  });

  it('keeps the tree revision stable across body, mtime, and read-state changes', () => {
    const original = doc('project/stable.md');
    const first = createAutoMemoryTreeSnapshot([original], sourceStatus);
    const second = createAutoMemoryTreeSnapshot(
      [{ ...original, body: 'NEW BODY', mtimeMs: 999 }],
      sourceStatus,
    );

    expect(second.revision).toBe(first.revision);
  });

  it('changes the tree revision when metadata or source visibility changes', () => {
    const original = doc('project/stable.md');
    const first = createAutoMemoryTreeSnapshot([original], sourceStatus);
    const metadataChanged = createAutoMemoryTreeSnapshot(
      [{ ...original, keywords: ['different retrieval phrase'] }],
      sourceStatus,
    );
    const sourceChanged = createAutoMemoryTreeSnapshot([original], {
      ...sourceStatus,
      requestedScopes: ['project', 'team'],
      unavailableScopes: [{ scope: 'team', reason: 'disabled' }],
    });

    expect(metadataChanged.revision).not.toBe(first.revision);
    expect(sourceChanged.revision).not.toBe(first.revision);
  });

  it('renders every complete-tree leaf with only its ref and title', () => {
    const docs = [
      doc('project/intro.md', {
        title: 'Project introduction',
        description: 'PRIVATE DESCRIPTION',
        keywords: ['PRIVATE KEYWORD'],
        usageScenarios: ['PRIVATE SCENARIO'],
      }),
      doc('feedback/testing.md', {
        category: 'testing_standard',
        title: 'Testing standard',
      }),
    ];
    const complete = createAutoMemoryTreeSnapshot(
      docs,
      sourceStatus,
    ).routerPrompt;

    expect(complete).toContain('project_introduction');
    expect(complete).toContain(
      '└── [project:project/intro.md] Project introduction',
    );
    expect(complete).toContain('testing_standard');
    expect(complete).toContain(
      '└── [project:feedback/testing.md] Testing standard',
    );
    expect(complete).not.toContain('PRIVATE DESCRIPTION');
    expect(complete).not.toContain('PRIVATE KEYWORD');
    expect(complete).not.toContain('PRIVATE SCENARIO');
  });

  it('does not omit complete-tree leaves to meet the compact router budget', () => {
    const docs = Array.from({ length: 100 }, (_, index) =>
      doc(`project/memory-${index}.md`, { title: `Memory ${index}` }),
    );
    const complete = createAutoMemoryTreeSnapshot(
      docs,
      sourceStatus,
    ).routerPrompt;

    for (const memory of docs) {
      expect(complete).toContain(`project:${memory.relativePath}`);
    }
    expect(complete.length).toBeGreaterThan(1_200);
  });

  it('renders a focused subtree without a second global router', () => {
    const memory = doc('project/focus.md');
    const focused = renderAutoMemoryFocusedSubtree([memory]).prompt;

    expect(focused).toContain('Memory focus for this turn');
    expect(focused).toContain('[project:project/focus.md]');
    expect(focused).not.toContain('Complete memory tree');
    expect(focused).not.toContain('Category Router');
  });

  it('aggregates every focused keyword once at its category node', () => {
    const first = doc('project/first.md', {
      keywords: [
        'shared phrase',
        ...Array.from({ length: 8 }, (_, index) => `first-${index}`),
      ],
    });
    const second = doc('project/second.md', {
      keywords: [
        'Shared Phrase',
        ...Array.from({ length: 8 }, (_, index) => `second-${index}`),
      ],
    });
    const focused = renderAutoMemoryFocusedSubtree([first, second]).prompt;

    expect(focused.match(/shared phrase/giu)).toHaveLength(1);
    expect(focused).toContain('first-7');
    expect(focused).toContain('second-7');
    expect(focused).not.toContain('本轮显示');
    expect(focused).not.toContain('可见关键词');
    expect(focused).not.toContain('另 5 个未展示');
  });

  it('deduplicates category keywords while preserving leaf metadata', () => {
    const first = doc('project/first.md', {
      description: 'First detailed summary',
      keywords: ['shared phrase', 'first identifier'],
      usageScenarios: ['first scenario', 'shared scenario'],
    });
    const second = doc('project/second.md', {
      description: 'Second detailed summary',
      keywords: ['shared phrase', 'second identifier'],
      usageScenarios: ['second scenario', 'shared scenario'],
    });
    const docs = [first, second];
    const focused = renderAutoMemoryFocusedSubtree(docs).prompt;

    expect(focused.match(/shared phrase/gu)).toHaveLength(1);
    expect(focused).toContain('First detailed summary');
    expect(focused).toContain('Second detailed summary');
    expect(focused).toContain('first scenario; shared scenario');
    expect(focused).toContain('second scenario; shared scenario');
  });

  it('uses a leaf placeholder only while the same body version is present', () => {
    const memory = doc('project/present.md', {
      description: 'Detailed metadata summary',
      keywords: ['present keyword'],
      usageScenarios: ['using the present memory'],
      mtimeMs: 42,
    });
    const present = renderAutoMemoryFocusedSubtree([memory], {
      bodyPresentVersions: new Map([['project:project/present.md', 42]]),
    }).prompt;

    expect(present).toContain('关键词：present keyword');
    expect(present).toContain(
      '[内容已在当前上下文] [project:project/present.md]',
    );
    expect(present).not.toContain('Detailed metadata summary');
    expect(present).not.toContain('using the present memory');

    const changed = renderAutoMemoryFocusedSubtree([memory], {
      bodyPresentVersions: new Map([['project:project/present.md', 41]]),
    }).prompt;

    expect(changed).not.toContain('[内容已在当前上下文]');
    expect(changed).toContain('[内容已更新，需要重新读取]');
    expect(changed).toContain('摘要：Detailed metadata summary');
    expect(changed).toContain('适用：using the present memory');

    const unread = renderAutoMemoryFocusedSubtree([memory]).prompt;
    expect(unread).not.toContain('[内容已更新，需要重新读取]');
    expect(unread).toContain(
      '└── [project:project/present.md] project/present.md',
    );
  });
});
