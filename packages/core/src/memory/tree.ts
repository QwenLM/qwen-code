/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_UNCATEGORIZED,
  type AutoMemoryScope,
  type AutoMemoryTreeCategoryKey,
  type AutoMemoryType,
} from './types.js';
import {
  sanitizeAutoMemoryPromptField,
  type MemorySourceStatus,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { createHash } from 'node:crypto';

const OVERVIEW_CHAR_BUDGET = 6_000;
const CATEGORY_KEYWORD_LIMIT = 12;
const SCOPE_ORDER: readonly AutoMemoryScope[] = ['project', 'user', 'team'];
const CATEGORY_ORDER: readonly AutoMemoryTreeCategoryKey[] = [
  ...AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_UNCATEGORIZED,
];
const MEMORY_OVERVIEW_USAGE_LINES = [
  'Use the metadata below to decide relevance. It can be enough by itself.',
  'If the user asks about the visible overview or directory metadata, answer from these cards without calling search_memory or empty explore.',
  'When you need a managed memory body, use search_memory.fetch/search/explore; do not read .qwen/memory, .qwen/team-memory, or ~/.qwen/memories with read_file, shell commands, glob, or directory browsing.',
];

export interface AutoMemoryTreeLeaf {
  memoryRef: string;
  scope: AutoMemoryScope;
  type: AutoMemoryType;
  category: AutoMemoryTreeCategoryKey;
  title: string;
  description: string;
  keywords: string[];
  usageScenarios: string[];
  mtimeMs: number;
}

export interface AutoMemoryTreeCategoryNode {
  category: AutoMemoryTreeCategoryKey;
  total: number;
  leaves: AutoMemoryTreeLeaf[];
  keywords: string[];
  hiddenKeywordCount: number;
}

export interface AutoMemoryTree {
  categories: AutoMemoryTreeCategoryNode[];
}

export interface AutoMemoryTreeSnapshot {
  revision: string;
  tree: AutoMemoryTree;
  routerPrompt: string;
  sourceStatus: MemorySourceStatus;
}

interface RenderAutoMemoryFocusedSubtreeResult {
  prompt: string;
  displayed: number;
  omitted: number;
}

export function toAutoMemoryRef(doc: ScannedAutoMemoryDocument): string {
  return `${doc.scope}:${sanitizeAutoMemoryPromptField(doc.relativePath, 512)}`;
}

function sanitizeList(values: readonly string[], maxChars: number): string[] {
  return values
    .map((value) => sanitizeAutoMemoryPromptField(value, maxChars))
    .filter(Boolean);
}

function toAutoMemoryTreeLeaf(
  doc: ScannedAutoMemoryDocument,
): AutoMemoryTreeLeaf {
  const ref = toAutoMemoryRef(doc);
  const description = sanitizeAutoMemoryPromptField(doc.description, 512);
  return {
    memoryRef: ref,
    scope: doc.scope,
    type: doc.type,
    category: doc.category,
    title: sanitizeAutoMemoryPromptField(doc.title, 256),
    description,
    keywords: sanitizeList(doc.keywords, 64),
    usageScenarios: sanitizeList(doc.usageScenarios, 64).filter(
      (scenario) =>
        scenario.toLocaleLowerCase('en-US') !==
        description.toLocaleLowerCase('en-US'),
    ),
    mtimeMs: doc.mtimeMs,
  };
}

function categoryIndex(category: AutoMemoryTreeCategoryKey): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function scopeIndex(scope: AutoMemoryScope): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

function sortLeaves(a: AutoMemoryTreeLeaf, b: AutoMemoryTreeLeaf): number {
  return (
    scopeIndex(a.scope) - scopeIndex(b.scope) ||
    a.memoryRef.localeCompare(b.memoryRef)
  );
}

function aggregateKeywords(
  leaves: readonly AutoMemoryTreeLeaf[],
  limit: number,
): { keywords: string[]; hiddenKeywordCount: number } {
  const stats = new Map<
    string,
    { value: string; count: number; first: number }
  >();
  let first = 0;
  for (const leaf of leaves) {
    const seen = new Set<string>();
    for (const keyword of leaf.keywords) {
      const normalized = keyword.toLocaleLowerCase('en-US');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const existing = stats.get(normalized);
      if (existing) {
        existing.count += 1;
      } else {
        stats.set(normalized, { value: keyword, count: 1, first });
        first += 1;
      }
    }
  }
  const sorted = [...stats.values()].sort(
    (a, b) => b.count - a.count || a.first - b.first,
  );
  return {
    keywords: sorted.slice(0, limit).map((item) => item.value),
    hiddenKeywordCount: Math.max(0, sorted.length - limit),
  };
}

export function buildAutoMemoryTree(
  docs: readonly ScannedAutoMemoryDocument[],
): AutoMemoryTree {
  const groups = new Map<AutoMemoryTreeCategoryKey, AutoMemoryTreeLeaf[]>();
  for (const doc of docs) {
    const leaf = toAutoMemoryTreeLeaf(doc);
    const leaves = groups.get(leaf.category) ?? [];
    leaves.push(leaf);
    groups.set(leaf.category, leaves);
  }

  return {
    categories: [...groups.entries()]
      .map(([category, leaves]) => {
        const sortedLeaves = [...leaves].sort(sortLeaves);
        const { keywords, hiddenKeywordCount } = aggregateKeywords(
          sortedLeaves,
          CATEGORY_KEYWORD_LIMIT,
        );
        return {
          category,
          total: sortedLeaves.length,
          leaves: sortedLeaves,
          keywords,
          hiddenKeywordCount,
        };
      })
      .sort((a, b) => categoryIndex(a.category) - categoryIndex(b.category)),
  };
}

function stableSourceStatus(sourceStatus: MemorySourceStatus): object {
  return {
    requestedScopes: [...sourceStatus.requestedScopes].sort(),
    searchedScopes: [...sourceStatus.searchedScopes].sort(),
    unavailableScopes: [...sourceStatus.unavailableScopes].sort((a, b) =>
      `${a.scope}:${a.reason}`.localeCompare(`${b.scope}:${b.reason}`),
    ),
    complete: sourceStatus.complete,
    incompleteScopes: [...sourceStatus.incompleteScopes].sort((a, b) =>
      `${a.scope}:${a.reason}`.localeCompare(`${b.scope}:${b.reason}`),
    ),
  };
}

export function createAutoMemoryTreeSnapshot(
  docs: readonly ScannedAutoMemoryDocument[],
  sourceStatus: MemorySourceStatus,
): AutoMemoryTreeSnapshot {
  const tree = buildAutoMemoryTree(docs);
  const revisionValue = {
    leaves: tree.categories.flatMap((category) =>
      category.leaves.map((leaf) => ({
        memoryRef: leaf.memoryRef,
        scope: leaf.scope,
        type: leaf.type,
        category: leaf.category,
        title: leaf.title,
        description: leaf.description,
        keywords: leaf.keywords,
        usageScenarios: leaf.usageScenarios,
      })),
    ),
    sourceStatus: stableSourceStatus(sourceStatus),
  };
  return {
    revision: createHash('sha256')
      .update(JSON.stringify(revisionValue))
      .digest('hex'),
    tree,
    routerPrompt: renderAutoMemoryGlobalRouter(tree, {
      sourceStatus,
      compact: true,
    }),
    sourceStatus,
  };
}

function sourceWarning(sourceStatus?: MemorySourceStatus): string[] {
  if (!sourceStatus) return [];
  const warnings: string[] = [];
  if (!sourceStatus.complete) {
    warnings.push(
      `> Source incomplete: counts cover ${sourceStatus.searchedScopes.join(', ') || 'no'} successfully searched scope(s) only.`,
    );
  }
  if (sourceStatus.unavailableScopes.length > 0) {
    warnings.push(
      `> Unavailable memory scope(s): ${sourceStatus.unavailableScopes
        .map((item) => `${item.scope}:${item.reason}`)
        .join(', ')}.`,
    );
  }
  return warnings;
}

function renderFocusedLeafLines(
  leaf: AutoMemoryTreeLeaf,
  prefix: string,
  isLast: boolean,
  bodyState: 'absent' | 'present' | 'stale' = 'absent',
): string[] {
  const marker = isLast ? '└──' : '├──';
  if (bodyState === 'present') {
    return [
      `${prefix}${marker} [内容已在当前上下文] [${leaf.memoryRef}] ${leaf.title}`,
    ];
  }

  const state = bodyState === 'stale' ? '[内容已更新，需要重新读取] ' : '';
  const lines = [
    `${prefix}${marker} ${state}[${leaf.memoryRef}] ${leaf.title}`,
  ];
  const detailPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
  if (leaf.description) {
    lines.push(`${detailPrefix}摘要：${leaf.description}`);
  }
  if (leaf.usageScenarios.length > 0) {
    lines.push(`${detailPrefix}适用：${leaf.usageScenarios.join('; ')}`);
  }
  return lines;
}

export function renderAutoMemoryFocusedSubtree(
  selectedDocs: readonly ScannedAutoMemoryDocument[],
  options: {
    bodyPresentVersions?: ReadonlyMap<string, number>;
    charBudget?: number;
  } = {},
): RenderAutoMemoryFocusedSubtreeResult {
  if (selectedDocs.length === 0) {
    return { prompt: '', displayed: 0, omitted: 0 };
  }
  const bodyPresentVersions = options.bodyPresentVersions ?? new Map();
  const charBudget = options.charBudget ?? OVERVIEW_CHAR_BUDGET;

  const buildPrompt = (docsToRender: readonly ScannedAutoMemoryDocument[]) => {
    const grouped = new Map<
      AutoMemoryTreeCategoryKey,
      { firstRank: number; leaves: AutoMemoryTreeLeaf[] }
    >();
    docsToRender.forEach((doc, index) => {
      const leaf = toAutoMemoryTreeLeaf(doc);
      const group = grouped.get(leaf.category) ?? {
        firstRank: index,
        leaves: [],
      };
      group.leaves.push(leaf);
      grouped.set(leaf.category, group);
    });
    const groups = [...grouped.entries()]
      .map(([category, group]) => ({ category, ...group }))
      .sort((a, b) => a.firstRank - b.firstRank);
    const lines = [
      '## Memory focus for this turn',
      '',
      'The paths below are the query-relevant subtree for this turn. They add focus to the existing memory tree; they do not replace it.',
    ];
    for (const group of groups) {
      const { keywords } = aggregateKeywords(
        group.leaves,
        Number.POSITIVE_INFINITY,
      );
      const groupIsLast = group === groups.at(-1);
      const prefix = groupIsLast ? '    ' : '│   ';
      lines.push(`${groupIsLast ? '└──' : '├──'} ${group.category}`);
      if (keywords.length > 0) {
        lines.push(`${prefix}关键词：${keywords.join(', ')}`);
      }
      group.leaves.forEach((leaf, index) => {
        const presentVersion = bodyPresentVersions.get(leaf.memoryRef);
        const bodyState =
          presentVersion === undefined
            ? 'absent'
            : presentVersion === leaf.mtimeMs
              ? 'present'
              : 'stale';
        lines.push(
          ...renderFocusedLeafLines(
            leaf,
            prefix,
            index === group.leaves.length - 1,
            bodyState,
          ),
        );
      });
    }
    const omitted = selectedDocs.length - docsToRender.length;
    if (omitted > 0) lines.push('', `另 ${omitted} 条已选记忆未展示`);
    return lines.join('\n');
  };

  for (let displayed = selectedDocs.length; displayed > 0; displayed -= 1) {
    const prompt = buildPrompt(selectedDocs.slice(0, displayed));
    if (prompt.length <= charBudget) {
      return {
        prompt,
        displayed,
        omitted: selectedDocs.length - displayed,
      };
    }
  }
  return {
    prompt: `## Memory focus for this turn\n\n另 ${selectedDocs.length} 条已选记忆未展示`,
    displayed: 0,
    omitted: selectedDocs.length,
  };
}

function renderAutoMemoryGlobalRouter(
  tree: AutoMemoryTree,
  options: {
    sourceStatus?: MemorySourceStatus;
    charBudget?: number;
    compact?: boolean;
  } = {},
): string {
  const header = options.compact
    ? [
        '## Complete memory tree',
        '',
        'This is the latest complete memory metadata tree. It replaces any older complete memory tree in the conversation. Use it to route into the focused subtree or search_memory when metadata is insufficient.',
        ...sourceWarning(options.sourceStatus),
        '',
      ]
    : [
        '## Complete memory tree',
        '',
        'This is the latest complete memory metadata tree. It replaces any older complete memory tree in the conversation.',
        ...sourceWarning(options.sourceStatus),
        '',
        ...MEMORY_OVERVIEW_USAGE_LINES,
        '',
      ];
  const lines = [...header];
  if (tree.categories.length === 0) {
    lines.push('No managed memory entries are currently visible.');
    return lines.join('\n');
  }
  tree.categories.forEach((category, categoryIndex) => {
    if (categoryIndex > 0) lines.push('');
    lines.push(category.category);
    category.leaves.forEach((leaf, leafIndex) => {
      const marker = leafIndex === category.leaves.length - 1 ? '└──' : '├──';
      lines.push(`${marker} [${leaf.memoryRef}] ${leaf.title}`);
    });
  });
  return lines.join('\n');
}
