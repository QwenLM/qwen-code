// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  moveWorkspace,
  orderWorkspaces,
  reorderWorkspace,
  readWorkspaceOrder,
  writeWorkspaceOrder,
} from './workspaceOrder';

const SCOPE = 'http://localhost:4170';

function workspace(cwd: string) {
  return { cwd, id: cwd };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('workspace order storage', () => {
  it('reads an empty order when nothing is stored', () => {
    expect(readWorkspaceOrder(SCOPE)).toEqual([]);
  });

  it('round-trips a written order', () => {
    writeWorkspaceOrder(SCOPE, ['/b', '/a', '/c']);
    expect(readWorkspaceOrder(SCOPE)).toEqual(['/b', '/a', '/c']);
  });

  it('keeps host scopes apart', () => {
    writeWorkspaceOrder('http://one', ['/a']);
    expect(readWorkspaceOrder('http://two')).toEqual([]);
  });

  it('ignores malformed or duplicated stored entries', () => {
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-order:http://localhost:4170',
      JSON.stringify(['/a', 42, '/a', '', '/b']),
    );
    expect(readWorkspaceOrder(SCOPE)).toEqual(['/a', '/b']);
  });

  it('reads an empty order from invalid JSON', () => {
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-order:http://localhost:4170',
      '{not json',
    );
    expect(readWorkspaceOrder(SCOPE)).toEqual([]);
  });
});

describe('orderWorkspaces', () => {
  it('returns the incoming order when nothing is stored', () => {
    const list = [workspace('/a'), workspace('/b')];
    expect(orderWorkspaces(list, [])).toEqual(list);
    expect(orderWorkspaces(list, [])).not.toBe(list);
  });

  it('sorts listed workspaces by their stored rank', () => {
    const list = [workspace('/a'), workspace('/b'), workspace('/c')];
    expect(orderWorkspaces(list, ['/c', '/a', '/b'])).toEqual([
      workspace('/c'),
      workspace('/a'),
      workspace('/b'),
    ]);
  });

  it('appends unlisted workspaces after the listed ones in daemon order', () => {
    const list = [workspace('/new1'), workspace('/a'), workspace('/new2')];
    expect(orderWorkspaces(list, ['/a'])).toEqual([
      workspace('/a'),
      workspace('/new1'),
      workspace('/new2'),
    ]);
  });

  it('ignores stored entries absent from the list', () => {
    const list = [workspace('/a'), workspace('/b')];
    expect(orderWorkspaces(list, ['/gone', '/b', '/a'])).toEqual([
      workspace('/b'),
      workspace('/a'),
    ]);
  });
});

describe('moveWorkspace', () => {
  it('swaps a workspace with its neighbour', () => {
    expect(moveWorkspace(['/a', '/b', '/c'], '/b', -1)).toEqual([
      '/b',
      '/a',
      '/c',
    ]);
    expect(moveWorkspace(['/a', '/b', '/c'], '/b', 1)).toEqual([
      '/a',
      '/c',
      '/b',
    ]);
  });

  it('refuses moves past either end or for an unknown cwd', () => {
    expect(moveWorkspace(['/a', '/b'], '/a', -1)).toBeUndefined();
    expect(moveWorkspace(['/a', '/b'], '/b', 1)).toBeUndefined();
    expect(moveWorkspace(['/a', '/b'], '/missing', 1)).toBeUndefined();
  });
});

describe('reorderWorkspace', () => {
  it('inserts before or after a target in either direction', () => {
    const order = ['/a', '/b', '/c', '/d'];
    expect(reorderWorkspace(order, '/d', '/b', false)).toEqual([
      '/a',
      '/d',
      '/b',
      '/c',
    ]);
    expect(reorderWorkspace(order, '/a', '/c', true)).toEqual([
      '/b',
      '/c',
      '/a',
      '/d',
    ]);
    expect(order).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('ignores self drops and workspaces absent from the current catalog', () => {
    expect(reorderWorkspace(['/a', '/b'], '/a', '/a', true)).toBeUndefined();
    expect(
      reorderWorkspace(['/a', '/b'], '/gone', '/b', false),
    ).toBeUndefined();
    expect(reorderWorkspace(['/a', '/b'], '/a', '/gone', true)).toBeUndefined();
  });
});
