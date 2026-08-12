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
      'dwsPath',
      'profile',
      'documentIds',
      'wikiSpaceIds',
      'wikiDiscoveryInterval',
      'trigger',
      'pollInterval',
      'groupPolicy',
      'senderPolicy',
      'allowedUsers',
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

  it('rejects malformed source lists and triggers', () => {
    expect(plugin.management?.validateConfig?.({ trigger: ' ' })).toContain(
      'non-empty string',
    );
    expect(
      plugin.management?.validateConfig?.({ wikiDiscoveryInterval: -1 }),
    ).toContain('non-negative integer');
    expect(
      plugin.management?.validateConfig?.({
        documentIds: ['doc-1'],
        approvalMode: 'yolo',
      }),
    ).toContain('require approvalMode');
    expect(
      plugin.management?.validateConfig?.({
        documents: { '*': { requireMention: false } },
      }),
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({
        documents: { 'doc-1': { requireMention: 'no' } },
      }),
    ).toContain('documents must map');
    expect(
      plugin.management?.validateConfig?.({ profile: 'corp:a,corp:b' }),
    ).toContain('exactly one account');
    expect(
      plugin.management?.validateConfig?.({ pollInterval: 5_000.5 }),
    ).toContain('integer of at least 5000');
  });
});
