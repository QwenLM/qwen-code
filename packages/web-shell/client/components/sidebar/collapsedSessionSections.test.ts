// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
  readWorkspaceCollapsedGroupIds,
  replaceOwnedCollapsedSessionSectionIds,
  writeWorkspaceCollapsedGroupIds,
} from './collapsedSessionSections';

afterEach(() => {
  window.localStorage.clear();
});

describe('collapsedSessionSections helpers', () => {
  it('merges owned ids without removing other owners', () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify([
        'group:primary',
        'recent',
        'ws:alpha|group:g1',
        'ws:beta|ungrouped',
      ]),
    );

    replaceOwnedCollapsedSessionSectionIds(
      new Set(['group:primary', 'color:red']),
      (id) => !id.startsWith('ws:'),
    );

    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual([
      'color:red',
      'group:primary',
      'ws:alpha|group:g1',
      'ws:beta|ungrouped',
    ]);
  });

  it('round-trips workspace-local group ids through namespaced storage', () => {
    writeWorkspaceCollapsedGroupIds('ws-1', new Set(['group-a', 'ungrouped']));
    writeWorkspaceCollapsedGroupIds('ws-2', new Set(['group-b']));

    expect(Array.from(readWorkspaceCollapsedGroupIds('ws-1')).sort()).toEqual([
      'group-a',
      'ungrouped',
    ]);
    expect(Array.from(readWorkspaceCollapsedGroupIds('ws-2')).sort()).toEqual([
      'group-b',
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual([
      'ws:ws-1|group:group-a',
      'ws:ws-1|ungrouped',
      'ws:ws-2|group:group-b',
    ]);
  });
});
