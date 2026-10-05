/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceAgent } from '../workspace-agents/types.js';
import {
  coalesceChainDepth,
  isWithinChainLimit,
  nextChainDepth,
  normalizeAgentChainLimit,
  resolveMentionTargets,
  isWithinTokenBudget,
  normalizeAgentTokenBudget,
} from './chain.js';

const agent = (id: string, name: string, extra: Partial<WorkspaceAgent> = {}) =>
  ({ id, name, createdAt: 1, ...extra }) as WorkspaceAgent;

const roster = [
  agent('ag_a', 'alice'),
  agent('ag_b', 'bob'),
  agent('ag_off', 'carol', { enabled: false }),
  agent('ag_gone', 'dave', { retiredAt: 5 }),
];

describe('resolveMentionTargets', () => {
  it('resolves addressable agents in mention order', () => {
    const targets = resolveMentionTargets('@bob then @alice and @bob', roster);
    expect(targets.agents.map((a) => a.id)).toEqual(['ag_b', 'ag_a']);
    expect(targets.selfMentioned).toBe(false);
  });

  it('separates disabled and retired agents', () => {
    const targets = resolveMentionTargets('@carol @dave @alice', roster);
    expect(targets.agents.map((a) => a.id)).toEqual(['ag_a']);
    expect(targets.unavailable.map((a) => a.id)).toEqual(['ag_off', 'ag_gone']);
  });

  it('does not trigger the author on a self-mention', () => {
    const targets = resolveMentionTargets('@alice @bob', roster, 'ag_a');
    expect(targets.agents.map((a) => a.id)).toEqual(['ag_b']);
    expect(targets.selfMentioned).toBe(true);
  });

  it('ignores email addresses', () => {
    expect(resolveMentionTargets('mail me@bob.dev', roster).agents).toEqual([]);
  });
});

describe('chain depth', () => {
  it('resets on a human post and adds one per agent hop', () => {
    expect(nextChainDepth({ kind: 'human' })).toBe(0);
    expect(nextChainDepth({ kind: 'agent', chainDepth: 0 })).toBe(1);
    expect(nextChainDepth({ kind: 'agent', chainDepth: 3 })).toBe(4);
  });

  it('treats 0 as unlimited and N as N hops', () => {
    expect(isWithinChainLimit(1_000, 0)).toBe(true);
    expect(isWithinChainLimit(2, 2)).toBe(true);
    expect(isWithinChainLimit(3, 2)).toBe(false);
  });

  it('normalizes the setting', () => {
    expect(normalizeAgentChainLimit(5)).toBe(5);
    expect(normalizeAgentChainLimit(0)).toBe(0);
    expect(normalizeAgentChainLimit(-1)).toBe(0);
    expect(normalizeAgentChainLimit(1.5)).toBe(0);
    expect(normalizeAgentChainLimit('8')).toBe(0);
  });

  it('lets a human trigger reset a coalesced run', () => {
    expect(coalesceChainDepth(4, 0)).toBe(0);
    expect(coalesceChainDepth(1, 3)).toBe(1);
  });
});

describe('agent token budget', () => {
  it('defaults to one million tokens and accepts 0 as unlimited', () => {
    expect(normalizeAgentTokenBudget(undefined)).toBe(1_000_000);
    expect(normalizeAgentTokenBudget(-5)).toBe(1_000_000);
    expect(normalizeAgentTokenBudget(0)).toBe(0);
    expect(normalizeAgentTokenBudget(2500.7)).toBe(2500);
  });

  it('stops agent hops once the budget is spent', () => {
    expect(isWithinTokenBudget(999_999, 1_000_000)).toBe(true);
    expect(isWithinTokenBudget(1_000_000, 1_000_000)).toBe(false);
    expect(isWithinTokenBudget(5_000_000, 0)).toBe(true);
  });
});
