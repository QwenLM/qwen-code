/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentions.js';
import type { WorkspaceAgent } from './types.js';

const agents: WorkspaceAgent[] = [
  { id: 'ag_alice', name: 'alice', createdAt: 1 },
  { id: 'ag_bob', name: 'Bob', createdAt: 1 },
  { id: 'ag_ci', name: 'ci-runner', createdAt: 1 },
];

describe('parseMentions', () => {
  it('resolves names case-insensitively and keeps first-appearance order', () => {
    expect(parseMentions('@BOB then @alice', agents).ids).toEqual([
      'ag_bob',
      'ag_alice',
    ]);
  });

  it('deduplicates repeated mentions of the same agent', () => {
    expect(parseMentions('@alice @alice @alice', agents).ids).toEqual([
      'ag_alice',
    ]);
  });

  it('stops at trailing punctuation', () => {
    expect(parseMentions('ask @alice, then @Bob.', agents).ids).toEqual([
      'ag_alice',
      'ag_bob',
    ]);
  });

  it('accepts hyphenated names', () => {
    expect(parseMentions('ping @ci-runner please', agents).ids).toEqual([
      'ag_ci',
    ]);
  });

  it('does not read an email address as a mention', () => {
    expect(parseMentions('mail alice@example.com', agents)).toEqual({
      ids: [],
      unknown: [],
    });
  });

  it('reports an unmatched token so a typo is visible', () => {
    expect(parseMentions('@alicce can you look', agents)).toEqual({
      ids: [],
      unknown: ['alicce'],
    });
  });

  it('resolves a disabled agent, leaving the decision to policy', () => {
    const disabled: WorkspaceAgent[] = [
      { id: 'ag_alice', name: 'alice', createdAt: 1, enabled: false },
    ];
    expect(parseMentions('@alice', disabled).ids).toEqual(['ag_alice']);
  });

  it('reads a mention written straight after Chinese text', () => {
    const roster: WorkspaceAgent[] = [
      { id: 'ag_move', name: '迁移助手', createdAt: 1 },
      { id: 'ag_alice', name: 'alice', createdAt: 1 },
    ];
    expect(parseMentions('请@迁移助手看一下，再让@alice复核', roster)).toEqual({
      ids: ['ag_move', 'ag_alice'],
      unknown: [],
    });
  });

  it('does not stretch a name into a longer ASCII word', () => {
    const roster: WorkspaceAgent[] = [
      { id: 'ag_alice', name: 'alice', createdAt: 1 },
    ];
    expect(parseMentions('@alice2 and mail@alice.dev', roster)).toEqual({
      ids: [],
      unknown: ['alice2'],
    });
  });
});
