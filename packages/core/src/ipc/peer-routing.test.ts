/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isInProcessRecipient } from './peer-routing.js';

const team = {
  leadAgentId: 'lead-1',
  members: [{ name: 'alice' }, { name: 'qa-tester' }],
};

describe('isInProcessRecipient', () => {
  it('always claims the broadcast keyword, team or not', () => {
    expect(isInProcessRecipient('*', team)).toBe(true);
    expect(isInProcessRecipient('*', null)).toBe(true);
    expect(isInProcessRecipient('*', undefined)).toBe(true);
  });

  it('claims the leader handle and lead agent id only while a team is active', () => {
    expect(isInProcessRecipient('leader', team)).toBe(true);
    expect(isInProcessRecipient('Leader', team)).toBe(true);
    expect(isInProcessRecipient('lead-1', team)).toBe(true);
    // No team: a session that happens to be named "leader" is reachable.
    expect(isInProcessRecipient('leader', null)).toBe(false);
    expect(isInProcessRecipient('lead-1', undefined)).toBe(false);
  });

  it('matches members the way TeamManager does — sanitized', () => {
    expect(isInProcessRecipient('alice', team)).toBe(true);
    expect(isInProcessRecipient('Alice', team)).toBe(true);
    expect(isInProcessRecipient('QA Tester', team)).toBe(true);
    expect(isInProcessRecipient('alice [ab12cd]', team)).toBe(false);
    expect(isInProcessRecipient('bob', team)).toBe(false);
  });

  it('claims nothing but the keyword with no team', () => {
    expect(isInProcessRecipient('alice', null)).toBe(false);
    expect(isInProcessRecipient('', null)).toBe(false);
  });
});
