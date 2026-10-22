// @vitest-environment jsdom
import { FileTree } from '@pierre/trees';
import { expect, it, vi } from 'vitest';
import { formatFileName } from './file-name-display';

it('removes invisible controls without normalizing legal filename spaces', () => {
  expect(
    formatFileName('a\u00ad\u2060\u034f\u180e\ufff9\u{e0041}\u202eb.ts'),
  ).toBe('ab.ts');
  // Default-ignorable non-Cf characters: Hangul fillers and variation
  // selectors are zero-advance, so they must be stripped as well.
  expect(formatFileName('admin\u3164.ts')).toBe('admin.ts');
  expect(formatFileName('ad\ufe0fmin.ts')).toBe('admin.ts');
  expect(formatFileName(' notes  draft\u00a0.md ')).toBe(
    ' notes  draft\u00a0.md ',
  );
  expect(formatFileName('\u001b[31mfile\u0001.ts')).toBe('file.ts');
  expect(formatFileName('\u202e')).toBe('[invalid]');
});

it('formats real Pierre rows and search while retaining raw path identity', async () => {
  const controlled = 'control-\u202e\u0001\u2060file.ts';
  const nested = 'dir-\u2060/child  notes.ts';
  const filler = 'admin\u3164.ts';
  const host = document.createElement('div');
  document.body.append(host);
  const tree = new FileTree({
    paths: [controlled, 'control-file.ts', nested, filler],
    initialExpansion: 'open',
    flattenEmptyDirectories: false,
    formatItemName: formatFileName,
    search: false,
  });
  try {
    tree.render({ containerWrapper: host });
    const root = tree.getFileTreeContainer()!.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(5),
    );
    const rows = [...root.querySelectorAll('[role="treeitem"]')];
    const row = rows.find(
      (item) => item.getAttribute('data-item-path') === controlled,
    )!;
    expect(row.getAttribute('aria-label')).toBe('control-file.ts');
    for (const character of ['\u202e', '\u0001', '\u2060'])
      expect(row.textContent).not.toContain(character);
    tree.setSearch('control-file.ts');
    expect(tree.getSearchMatchingPaths()).toEqual(
      expect.arrayContaining([controlled, 'control-file.ts']),
    );
    tree.setSearch('dir-/child  notes.ts');
    expect(tree.getSearchMatchingPaths()).toEqual([nested]);
    tree.setSearch(controlled);
    expect(tree.getSearchMatchingPaths()).toEqual([controlled]);
    // The filler renders as 'admin.ts', so the visible-name query must match.
    tree.setSearch('admin.ts');
    expect(tree.getSearchMatchingPaths()).toEqual([filler]);
  } finally {
    tree.cleanUp();
    host.remove();
  }
});
