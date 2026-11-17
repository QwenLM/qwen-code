/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SKILL_INSTALL_ATTEMPTS,
  SKILL_INSTALL_RECEIPT_TTL_MS,
  SkillInstallAttemptStore,
} from './skill-install-attempts.js';

const input = () => ({
  attemptId: randomUUID(),
  scope: 'workspace' as const,
  skillName: 'example',
  workspaceId: 'secondary',
  generationId: 1,
  phase: 'receiving' as const,
});
afterEach(() => vi.useRealTimers());
describe('Skill installation receipts', () => {
  it('binds history to an owner incarnation and scope instead of a reusable workspace id', () => {
    const store = new SkillInstallAttemptStore();
    const workspace = { workspaceId: 'secondary' };
    const owner = store.owner('workspace', workspace);
    const attempt = input();
    store.reserve(owner, attempt);
    expect(store.owner('workspace', workspace)).toBe(owner);
    expect(
      store.get(store.owner('global', workspace), attempt.attemptId),
    ).toBeUndefined();
    expect(
      store.get(store.owner('workspace', { ...workspace }), attempt.attemptId),
    ).toBeUndefined();
    expect(store.get(owner, attempt.attemptId)?.generationId).toBe(1);
  });

  it('reserves synchronously, rejects duplicates and limits active operations across owners', () => {
    const store = new SkillInstallAttemptStore();
    const first = input();
    store.reserve('global', first);
    expect(() =>
      store.reserve('global', {
        ...first,
        attemptId: first.attemptId.toUpperCase(),
      }),
    ).toThrow(expect.objectContaining({ code: 'skill_attempt_conflict' }));
    store.reserve('secondary', input());
    expect(() => store.reserve('third', input())).toThrow(
      expect.objectContaining({ code: 'skill_install_busy', statusCode: 429 }),
    );
    expect(store.get('secondary', first.attemptId)).toBeUndefined();
  });

  it('holds committed operations through cleanup and starts retention only when they settle', () => {
    vi.useFakeTimers();
    const store = new SkillInstallAttemptStore();
    const first = store.reserve('owner', input());
    first.state = 'committed';
    store.reserve('owner', input());
    vi.advanceTimersByTime(SKILL_INSTALL_RECEIPT_TTL_MS * 2);
    expect(store.get('owner', first.attemptId)?.state).toBe('committed');
    expect(() => store.reserve('owner', input())).toThrow(
      expect.objectContaining({ code: 'skill_install_busy' }),
    );
    store.settle('owner', first.attemptId);
    const next = store.reserve('owner', input());
    next.state = 'not_committed';
    store.settle('owner', next.attemptId);
    vi.advanceTimersByTime(SKILL_INSTALL_RECEIPT_TTL_MS - 1);
    expect(store.get('owner', first.attemptId)?.state).toBe('committed');
    vi.advanceTimersByTime(1);
    expect(store.get('owner', first.attemptId)).toBeUndefined();
  });

  it('does not evict unexpired receipts to admit new work', () => {
    vi.useFakeTimers();
    const store = new SkillInstallAttemptStore();
    const ids: string[] = [];
    for (let i = 0; i < MAX_SKILL_INSTALL_ATTEMPTS; i++) {
      const receipt = store.reserve('owner', input());
      receipt.state = 'not_committed';
      store.settle('owner', receipt.attemptId);
      ids.push(receipt.attemptId);
    }
    expect(() => store.reserve('owner', input())).toThrow(
      expect.objectContaining({ code: 'skill_install_receipts_full' }),
    );
    expect(store.get('owner', ids[0])).toBeDefined();
    vi.advanceTimersByTime(SKILL_INSTALL_RECEIPT_TTL_MS);
    expect(() => store.reserve('owner', input())).not.toThrow();
    expect(new SkillInstallAttemptStore().get('owner', ids[0])).toBeUndefined();
  });
});
