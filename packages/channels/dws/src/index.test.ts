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
      'disableAtMessages',
      'imUserIds',
      'imGroupIds',
      'documentIds',
      'wikiSpaceIds',
      'wikiDiscoveryInterval',
      'trigger',
      'pollInterval',
      'senderPolicy',
      'allowedUsers',
    ]);
  });

  it('accepts the default @ message source', () => {
    expect(plugin.management?.validateConfig?.({})).toBeUndefined();
  });

  it('defaults sender access to open', () => {
    expect(
      plugin.management?.fields.find((field) => field.key === 'senderPolicy')
        ?.default,
    ).toBe('open');
  });

  it('requires another source when @ message listening is disabled', () => {
    expect(
      plugin.management?.validateConfig?.({ disableAtMessages: true }),
    ).toContain('at least one');
    expect(
      plugin.management?.validateConfig?.({
        disableAtMessages: true,
        documentIds: ['doc-1'],
      }),
    ).toBeUndefined();
    expect(
      plugin.management?.validateConfig?.({
        disableAtMessages: true,
        wikiSpaceIds: ['wiki-1'],
      }),
    ).toBeUndefined();
  });

  it('rejects malformed source lists and triggers', () => {
    expect(plugin.management?.validateConfig?.({ imUserIds: [''] })).toContain(
      'non-empty strings',
    );
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
  });
});
