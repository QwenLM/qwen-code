// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  buildSessionTree,
  readSessionTreeExpanded,
  writeSessionTreeExpanded,
} from './sessionTree';

function session(
  sessionId: string,
  parentSessionId?: string,
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/w',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayName: sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

const ids = (rows: ReturnType<typeof buildSessionTree>) =>
  rows.map((row) => `${row.session.sessionId}:${row.depth}`);

afterEach(() => {
  window.localStorage.clear();
});

describe('buildSessionTree', () => {
  it('keeps a page without lineage flat', () => {
    const rows = buildSessionTree([session('a'), session('b')]);

    expect(ids(rows)).toEqual(['a:0', 'b:0']);
    expect(rows.every((row) => row.childCount === 0)).toBe(true);
    expect(rows.every((row) => !row.expanded)).toBe(true);
  });

  it('hides children under a collapsed parent', () => {
    const rows = buildSessionTree([
      session('parent'),
      session('child-1', 'parent'),
      session('child-2', 'parent'),
      session('other'),
    ]);

    expect(ids(rows)).toEqual(['parent:0', 'other:0']);
    expect(rows[0]!.childCount).toBe(2);
    expect(rows[0]!.expanded).toBe(false);
  });

  it('emits children directly after their expanded parent', () => {
    const rows = buildSessionTree(
      [
        session('child-1', 'parent'),
        session('parent'),
        session('other'),
        session('child-2', 'parent'),
      ],
      { expandedParentIds: new Set(['parent']) },
    );

    expect(ids(rows)).toEqual([
      'parent:0',
      'child-1:1',
      'child-2:1',
      'other:0',
    ]);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[1]!.expanded).toBe(false);
    expect(rows[1]!.childCount).toBe(0);
  });

  it('lets a forced parent expand over the stored toggle', () => {
    const rows = buildSessionTree(
      [session('parent'), session('child', 'parent')],
      { forceExpandedParentIds: new Set(['parent']) },
    );

    expect(ids(rows)).toEqual(['parent:0', 'child:1']);
  });

  it('keeps a child flat when its parent is outside the page', () => {
    const rows = buildSessionTree([
      session('before'),
      session('orphan', 'missing'),
      session('a'),
    ]);

    // No sidebar list would show an unarchived child whose parent left the
    // active catalog, so a missing anchor must not hide the row.
    expect(ids(rows)).toEqual(['before:0', 'orphan:0', 'a:0']);
    expect(rows[1]!.childCount).toBe(0);
  });

  it('keeps a child flat when its parent was archived out of the page', () => {
    const rows = buildSessionTree([session('child', 'archived-parent')]);

    expect(ids(rows)).toEqual(['child:0']);
  });

  it('leaves a child of an unanchored parent ungrouped instead of nesting it', () => {
    const rows = buildSessionTree([
      session('middle', 'missing'),
      session('leaf', 'middle'),
    ]);

    expect(ids(rows)).toEqual(['middle:0', 'leaf:0']);
  });
});

describe('session tree expansion storage', () => {
  it('round-trips expanded parent ids per storage id', () => {
    writeSessionTreeExpanded('ws-a', new Set(['p1', 'p2']));

    expect([...readSessionTreeExpanded('ws-a')].sort()).toEqual(['p1', 'p2']);
    expect([...readSessionTreeExpanded('ws-b')]).toEqual([]);
  });

  it('ignores malformed stored values', () => {
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.session-tree-expanded:ws-a',
      '{"not":"an array"}',
    );

    expect([...readSessionTreeExpanded('ws-a')]).toEqual([]);
  });
});
