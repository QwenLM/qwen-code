// @vitest-environment jsdom
import { FileTree } from '@pierre/trees';
import { expect, it, vi } from 'vitest';
import { formatFileName } from './file-name-display';

it('removes invisible controls without normalizing legal filename spaces', () => {
  expect(
    formatFileName('a\u00ad\u2060\u034f\u180e\ufff9\u{e0041}\u202eb.ts'),
  ).toBe('ab.ts');
  expect(formatFileName(' notes  draft\u00a0.md ')).toBe(
    ' notes  draft\u00a0.md ',
  );
  expect(formatFileName('\u001b[31mfile\u0001.ts')).toBe('file.ts');
  expect(formatFileName('\u202e')).toBe('[invalid]');
});

it('formats real Pierre rows and search while retaining raw path identity', async () => {
  const controlled = 'control-\u202e\u0001\u2060file.ts';
  const nested = 'dir-\u2060/child  notes.ts';
  const host = document.createElement('div');
  document.body.append(host);
  const tree = new FileTree({
    paths: [controlled, 'control-file.ts', nested],
    initialExpansion: 'open',
    flattenEmptyDirectories: false,
    formatItemName: formatFileName,
    search: false,
  });
  try {
    tree.render({ containerWrapper: host });
    const root = tree.getFileTreeContainer()!.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(4),
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
  } finally {
    tree.cleanUp();
    host.remove();
  }
});
