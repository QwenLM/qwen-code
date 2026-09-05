/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from './index.js';

describe('DWS channel plugin', () => {
  it('registers a standalone DWS channel without replacing DingTalk', () => {
    expect(plugin.channelType).toBe('dws');
    expect(plugin.displayName).toBe('DingTalk Workspace');
    expect(plugin.defaultSessionScope).toBe('chat_thread');
    expect(plugin.requiredConfigFields).toBeUndefined();
    expect(plugin.management?.fields.map((field) => field.key)).toEqual([
      'profile',
      'groupPolicy',
      'senderPolicy',
      'allowedUsers',
      'watchTodos',
      'startReaction',
      'endReaction',
    ]);
  });

  it('accepts the default @ message source', () => {
    expect(plugin.management?.validateConfig?.({})).toBeUndefined();
  });

  it('defaults sender and group access to pairing', () => {
    const groupPolicy = plugin.management?.fields.find(
      (field) => field.key === 'groupPolicy',
    );
    expect(groupPolicy?.default).toBe('pairing');
    expect(groupPolicy?.options?.map((option) => option.value)).toEqual([
      'pairing',
      'allowlist',
      'open',
      'disabled',
    ]);
    expect(
      plugin.management?.fields.find((field) => field.key === 'senderPolicy')
        ?.default,
    ).toBe('pairing');
    expect(
      plugin.management?.fields.find((field) => field.key === 'watchTodos')
        ?.default,
    ).toBeUndefined();
  });

  it('exposes configurable task reactions', () => {
    expect(
      plugin.management?.fields.find((field) => field.key === 'startReaction')
        ?.default,
    ).toBe('🤔');
    expect(
      plugin.management?.fields.find((field) => field.key === 'endReaction')
        ?.default,
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({
        startReaction: '👏',
        endReaction: '赞',
      }),
    ).toBeUndefined();
    expect(plugin.management?.validateConfig?.({ startReaction: 1 })).toContain(
      'startReaction must be a string',
    );
    expect(
      plugin.management?.validateConfig?.({ endReaction: false }),
    ).toContain('endReaction must be a string');
  });

  it('ignores removed source settings', () => {
    expect(
      plugin.management?.validateConfig?.({ imUserIds: 'legacy-user' }),
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({ imGroupIds: 'legacy-group' }),
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({ disableAtMessages: 'legacy' }),
    ).toBeUndefined();
  });

  it('allows yolo approval mode', () => {
    expect(
      plugin.management?.validateConfig?.({
        approvalMode: 'yolo',
      }),
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({ approvalMode: 'auto' }),
    ).toContain('require approvalMode');
  });

  it('rejects ambiguous profiles and invalid todo inputs', () => {
    expect(
      plugin.management?.validateConfig?.({ profile: 'corp:a,corp:b' }),
    ).toContain('exactly one login profile');
    expect(
      plugin.management?.validateConfig?.({ watchTodos: 'true' }),
    ).toContain('must be a boolean');
  });
});
