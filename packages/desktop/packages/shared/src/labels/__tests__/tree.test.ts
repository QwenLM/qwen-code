import { describe, it, expect } from 'bun:test';
import { flattenLabelsWithParentPath, sortLabelsForDisplay } from '../tree.ts';
import type { LabelConfig } from '../types.ts';

function names(labels: LabelConfig[]): string[] {
  return labels.map(label => label.name);
}

describe('sortLabelsForDisplay', () => {
  it('sorts labels alphabetically at every level without mutating the input tree', () => {
    const input: LabelConfig[] = [
      {
        id: 'priority',
        name: 'Priority',
        children: [
          { id: 'priority::zeta', name: 'Zeta' },
          { id: 'priority::alpha', name: 'Alpha' },
        ],
      },
      { id: 'bug', name: 'Bug' },
      {
        id: 'assignee',
        name: 'Assignee',
        children: [
          { id: 'assignee::zoe', name: 'Zoe' },
          { id: 'assignee::amy', name: 'Amy' },
        ],
      },
    ];

    const sorted = sortLabelsForDisplay(input);

    expect(names(sorted)).toEqual(['Assignee', 'Bug', 'Priority']);
    expect(names(sorted[0]!.children || [])).toEqual(['Amy', 'Zoe']);
    expect(names(sorted[2]!.children || [])).toEqual(['Alpha', 'Zeta']);

    // Original input remains unchanged
    expect(names(input)).toEqual(['Priority', 'Bug', 'Assignee']);
    expect(names(input[0]!.children || [])).toEqual(['Zeta', 'Alpha']);
    expect(names(input[2]!.children || [])).toEqual(['Zoe', 'Amy']);
    expect(sorted[0]).not.toBe(input[2]);
  });
});

describe('flattenLabelsWithParentPath', () => {
  it('includes parent breadcrumbs for nested labels while preserving tree traversal order', () => {
    const input: LabelConfig[] = [
      {
        id: 'priority',
        name: 'Priority',
        children: [
          { id: 'priority::high', name: 'High' },
          { id: 'priority::low', name: 'Low' },
        ],
      },
      { id: 'bug', name: 'Bug' },
    ];

    const flattened = flattenLabelsWithParentPath(input);

    expect(flattened.map(entry => entry.label.name)).toEqual(['Priority', 'High', 'Low', 'Bug']);
    expect(flattened.map(entry => entry.parentPath)).toEqual([
      undefined,
      'Priority / ',
      'Priority / ',
      undefined,
    ]);
    expect(flattened[1]!.parentNames).toEqual(['Priority']);
  });
});
