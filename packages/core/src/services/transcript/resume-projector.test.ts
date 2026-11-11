/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getI18nService,
  initializeI18nService,
  resetI18nService,
} from '../../i18n/index.js';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import type { CompatibleTranscriptView } from './compatibility.js';
import type { TranscriptIndex } from './index.js';
import { projectTranscriptSession } from './resume-projector.js';

beforeEach(() => initializeI18nService());
afterEach(() => resetI18nService());

const SESSION_FIELDS = {
  cwd: '/tmp/project',
  sessionId: 'session-1',
  userType: 'external',
  version: '1.0.0',
  isSidechain: false,
} as const;

describe('projectTranscriptSession', () => {
  it('drops malformed attachments without truncating valid descendants', () => {
    const user: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'user',
      uuid: 'user',
      timestamp: '2026-07-20T08:00:00.000Z',
      parentUuid: null,
      message: { role: 'user', content: 'continue' },
    };
    const malformed = {
      ...SESSION_FIELDS,
      type: 'attachment',
      uuid: 'malformed-attachment',
      timestamp: '2026-07-20T08:00:00.001Z',
      parentUuid: user.uuid,
      attachment: null,
    } as unknown as TranscriptMessage;
    const assistant: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'assistant',
      uuid: 'assistant',
      timestamp: '2026-07-20T08:00:00.002Z',
      parentUuid: malformed.uuid,
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: 'assistant-message',

        model: 'test-model',
        stop_reason: 'end_turn',

        content: [{ type: 'text', text: 'done' }],
      },
    };
    const chain = [user, malformed, assistant];
    const index = {
      snapshots: [],
      contentReplacements: [],
    } as unknown as TranscriptIndex;
    const compatible: CompatibleTranscriptView = {
      messagesByUuid: new Map(chain.map((message) => [message.uuid, message])),
      orderByUuid: new Map(
        chain.map((message, index) => [message.uuid, index]),
      ),
      diagnostics: [],
      hasCompactBoundary: false,
    };

    const projected = projectTranscriptSession(index, compatible, {
      leafUuid: assistant.uuid,
      messages: chain,
      diagnostics: [],
    });

    expect(projected.chain.map((message) => message.uuid)).toEqual([
      user.uuid,
      assistant.uuid,
    ]);
    expect(projected.chain[1]?.parentUuid).toBe(user.uuid);
    expect(projected.messages.map((message) => message.uuid)).toEqual([
      user.uuid,
      assistant.uuid,
    ]);
    expect(projected.leafUuid).toBe(assistant.uuid);
  });

  it('removes only the legacy system error parented by a synthetic API error', () => {
    const syntheticError: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'assistant',
      uuid: 'synthetic-api-error',
      timestamp: '2026-07-20T08:00:00.000Z',
      parentUuid: null,
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: 'synthetic-message',

        model: '<synthetic>',
        stop_reason: null,

        content: [{ type: 'text', text: 'technical transport error' }],
      },
      isApiErrorMessage: true,
      displayErrorCode: 416,
      errorFallbackMessage: 'Session blocked',
    };
    const duplicateDisplayError: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'system',
      uuid: 'legacy-display-error',
      timestamp: '2026-07-20T08:00:00.001Z',
      parentUuid: syntheticError.uuid,
      subtype: 'error',
      level: 'error',
      content: 'Session blocked',
    };
    const userMessage: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'user',
      uuid: 'next-user-message',
      timestamp: '2026-07-20T08:00:01.000Z',
      parentUuid: duplicateDisplayError.uuid,
      message: { role: 'user', content: 'continue' },
    };
    const unrelatedSystemError: TranscriptMessage = {
      ...SESSION_FIELDS,
      type: 'system',
      uuid: 'unrelated-system-error',
      timestamp: '2026-07-20T08:00:01.001Z',
      parentUuid: syntheticError.uuid,
      subtype: 'error',
      level: 'error',
      content: 'Hook failed',
    };
    const chain = [
      syntheticError,
      duplicateDisplayError,
      userMessage,
      unrelatedSystemError,
    ];
    const index = {
      snapshots: [],
      contentReplacements: [],
    } as unknown as TranscriptIndex;
    const compatible: CompatibleTranscriptView = {
      messagesByUuid: new Map(chain.map((message) => [message.uuid, message])),
      orderByUuid: new Map(
        chain.map((message, index) => [message.uuid, index]),
      ),
      diagnostics: [],
      hasCompactBoundary: false,
    };

    const projected = projectTranscriptSession(index, compatible, {
      leafUuid: unrelatedSystemError.uuid,
      messages: chain,
      diagnostics: [],
    });

    expect(projected.chain.map((message) => message.uuid)).toEqual([
      'synthetic-api-error',
      'legacy-display-error',
      'next-user-message',
      'unrelated-system-error',
    ]);
    expect(projected.messages.map((message) => message.uuid)).toEqual([
      'synthetic-api-error',
      'next-user-message',
      'unrelated-system-error',
    ]);
    expect(projected.messages.at(-1)).toEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'error',
        content: 'Hook failed',
      }),
    );
    // New Provider records pass through without the legacy display lookup.
    const providerError: TranscriptMessage = {
      ...syntheticError,
      modelError: { kind: 'unknown' },
    };
    const providerChain = [providerError, ...chain.slice(1)];
    const textLookup = vi.spyOn(getI18nService(), 'getErrorCodeMessage');
    try {
      const resumed = projectTranscriptSession(index, compatible, {
        leafUuid: unrelatedSystemError.uuid,
        messages: providerChain,
        diagnostics: [],
      });
      expect(textLookup).not.toHaveBeenCalled();
      expect(resumed.messages.map((message) => message.uuid)).toEqual(
        providerChain.map((message) => message.uuid),
      );
    } finally {
      textLookup.mockRestore();
    }
  });
});
