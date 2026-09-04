/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Fixtures mirror the TUI counterpart's tests
// (packages/cli/src/ui/components/background-view/agent-forest.test.ts) so
// the two ports can't silently diverge in semantics.

import { describe, expect, it } from 'vitest';
import {
  type AgentForestNode,
  computeAgentTreeInfo,
  computeUserBlockingIds,
  reorderChildrenUnderParents,
} from './agentForest';

interface TestNode extends AgentForestNode {
  kind: string;
  id?: string;
}

function agent(id: string, overrides: Partial<TestNode> = {}): TestNode {
  return { kind: 'agent', id, ...overrides };
}

function idsOf(entries: readonly TestNode[]): Array<string | undefined> {
  return entries.map((e) => (e.kind === 'agent' ? e.id : e.kind));
}

describe('reorderChildrenUnderParents', () => {
  it('keeps a flat roster unchanged', () => {
    const entries = [agent('a'), agent('b'), agent('c')];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('pulls a child from behind an interleaving sibling up under its parent', () => {
    const entries = [
      agent('p'),
      agent('q'),
      agent('p-child', { parentAgentId: 'p' }),
    ];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual([
      'p',
      'p-child',
      'q',
    ]);
  });

  it('orders a multi-level tree depth-first with siblings in input order', () => {
    const entries = [
      agent('root'),
      agent('child-1', { parentAgentId: 'root' }),
      agent('other-root'),
      agent('grandchild', { parentAgentId: 'child-1' }),
      agent('child-2', { parentAgentId: 'root' }),
    ];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual([
      'root',
      'child-1',
      'grandchild',
      'child-2',
      'other-root',
    ]);
  });

  it('keeps non-agent entries at their exact positions', () => {
    const shell: TestNode = { kind: 'shell', id: 'sh-1' };
    const monitor: TestNode = { kind: 'monitor', id: 'mon-1' };
    const entries = [
      agent('p'),
      shell,
      agent('q'),
      agent('p-child', { parentAgentId: 'p' }),
      monitor,
    ];
    const result = reorderChildrenUnderParents(entries);
    expect(idsOf(result)).toEqual(['p', 'shell', 'p-child', 'q', 'monitor']);
  });

  it('treats an agent with a departed parent as a root in input order', () => {
    const entries = [
      agent('a'),
      agent('orphan', { parentAgentId: 'gone' }),
      agent('b'),
    ];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual([
      'a',
      'orphan',
      'b',
    ]);
  });

  it('does not drop members of a parent cycle', () => {
    const entries = [
      agent('x', { parentAgentId: 'y' }),
      agent('y', { parentAgentId: 'x' }),
      agent('z'),
    ];
    const result = reorderChildrenUnderParents(entries);
    expect(result).toHaveLength(3);
    expect(new Set(idsOf(result))).toEqual(new Set(['x', 'y', 'z']));
  });

  it('ignores a self-parent reference', () => {
    const entries = [agent('a', { parentAgentId: 'a' }), agent('b')];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual(['a', 'b']);
  });

  it('ignores a shell task whose id collides with a parentAgentId', () => {
    // Only kind === 'agent' entries participate in the tree; a shell task
    // with the same id must not adopt the agent as its child.
    const shell: TestNode = { kind: 'shell', id: 'p' };
    const entries = [shell, agent('child', { parentAgentId: 'p' }), agent('q')];
    expect(idsOf(reorderChildrenUnderParents(entries))).toEqual([
      'shell',
      'child',
      'q',
    ]);
  });
});

describe('computeAgentTreeInfo', () => {
  it('computes visible depth along the present parent chain', () => {
    const entries = [
      agent('root'),
      agent('child', { parentAgentId: 'root' }),
      agent('grandchild', { parentAgentId: 'child' }),
    ];
    const info = computeAgentTreeInfo(entries);
    expect(info.get('root')).toEqual({ visibleDepth: 0, orphaned: false });
    expect(info.get('child')).toEqual({ visibleDepth: 1, orphaned: false });
    expect(info.get('grandchild')).toEqual({
      visibleDepth: 2,
      orphaned: false,
    });
  });

  it('promotes an agent with a departed parent to visible root and flags it', () => {
    const entries = [agent('orphan', { parentAgentId: 'gone' })];
    expect(computeAgentTreeInfo(entries).get('orphan')).toEqual({
      visibleDepth: 0,
      orphaned: true,
    });
  });

  it('counts depth up to the nearest missing ancestor only', () => {
    const entries = [
      agent('parent', { parentAgentId: 'gone' }),
      agent('child', { parentAgentId: 'parent' }),
    ];
    const info = computeAgentTreeInfo(entries);
    expect(info.get('parent')).toEqual({ visibleDepth: 0, orphaned: true });
    expect(info.get('child')).toEqual({ visibleDepth: 1, orphaned: false });
  });

  it('terminates on parent cycles', () => {
    const entries = [
      agent('x', { parentAgentId: 'y' }),
      agent('y', { parentAgentId: 'x' }),
    ];
    const info = computeAgentTreeInfo(entries);
    expect(info.get('x')).toEqual({ visibleDepth: 0, orphaned: false });
    expect(info.get('y')).toEqual({ visibleDepth: 0, orphaned: false });
  });
});

describe('computeUserBlockingIds', () => {
  it('tags a top-level foreground agent', () => {
    const entries = [agent('fg', { isBackgrounded: false })];
    expect(computeUserBlockingIds(entries)).toEqual(new Set(['fg']));
  });

  it('never tags background agents', () => {
    const entries = [agent('bg', { isBackgrounded: true })];
    expect(computeUserBlockingIds(entries).size).toBe(0);
  });

  it('does not tag a foreground child awaited by a background parent', () => {
    const entries = [
      agent('bg-parent', { isBackgrounded: true }),
      agent('fg-child', { isBackgrounded: false, parentAgentId: 'bg-parent' }),
    ];
    expect(computeUserBlockingIds(entries).size).toBe(0);
  });

  it('tags a fully-foreground chain down from the top-level session', () => {
    const entries = [
      agent('fg-parent', { isBackgrounded: false }),
      agent('fg-child', { isBackgrounded: false, parentAgentId: 'fg-parent' }),
    ];
    expect(computeUserBlockingIds(entries)).toEqual(
      new Set(['fg-parent', 'fg-child']),
    );
  });

  it('does not tag when an ancestor is missing from the visible set', () => {
    const entries = [
      agent('fg-child', { isBackgrounded: false, parentAgentId: 'gone' }),
    ];
    expect(computeUserBlockingIds(entries).size).toBe(0);
  });

  it('does not tag members of a parent cycle', () => {
    const entries = [
      agent('x', { isBackgrounded: false, parentAgentId: 'y' }),
      agent('y', { isBackgrounded: false, parentAgentId: 'x' }),
    ];
    expect(computeUserBlockingIds(entries).size).toBe(0);
  });

  it('does not tag entries missing the isBackgrounded flag', () => {
    // The daemon always sends isBackgrounded for agent tasks; a node
    // without it (defensive) must not be claimed as user-blocking.
    const entries = [agent('unknown')];
    expect(computeUserBlockingIds(entries).size).toBe(0);
  });
});
