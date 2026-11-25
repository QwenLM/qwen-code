/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SideQuestionParams } from '@qwen-code/core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { persistentState } from '../../utils/persistentState.js';
import * as storeModule from '../state/btwHistoryStore.js';
import { btwCommand } from './btwCommand.js';

vi.mock('../../utils/persistentState.js', () => ({
  persistentState: { get: vi.fn(), update: vi.fn() },
}));

vi.mock('../state/btwHistoryStore.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../state/btwHistoryStore.js')>();
  const runner = vi.fn(
    (_params: SideQuestionParams) => new Promise<never>(() => {}),
  );
  return {
    ...actual,
    btwHistoryStore: new actual.BtwHistoryStore(runner),
    __runner: runner,
  };
});

const runner = (storeModule as unknown as { __runner: Mock }).__runner;
const store = storeModule.btwHistoryStore;

function contextFor(sessionId: string) {
  return createMockCommandContext({
    services: {
      agentContext: {
        config: {
          getSessionId: () => sessionId,
          getModel: () => 'model-x',
        },
        getCacheSafeQuerySnapshot: () => ({
          systemPrompt: [{ type: 'text' as const, text: 'system prompt' }],
          forkContextMessages: [],
          model: 'model-x',
          toolSchemas: [],
        }),
        getParentToolSchemas: () => [],
      },
    },
    messages: [{ type: 'user', uuid: 'u1' }],
  } as never);
}

function dialogRequestId(result: unknown): string | undefined {
  const component = (result as { component?: React.ReactElement })
    ?.component as React.ReactElement<{ requestId: string }> | undefined;
  return component?.props.requestId;
}

describe('btwCommand', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('takes an optional question', () => {
    expect(btwCommand.argumentHint).toBe('[question]');
  });

  it('shows usage when there is nothing to reopen', async () => {
    const result = await btwCommand.action!(contextFor('session-1'), '  ');

    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('starts a side question with the parent context and opens its panel', async () => {
    const result = await btwCommand.action!(
      contextFor('session-1'),
      ' where is it? ',
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'where is it?',
        cacheSafeQuerySnapshot: {
          systemPrompt: [{ type: 'text', text: 'system prompt' }],
          forkContextMessages: [],
          model: 'model-x',
          toolSchemas: [],
        },
        sessionId: 'session-1',
        history: [],
      }),
    );
    const params = runner.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty('parentToolSchemas');
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('messages');
    expect(persistentState.update).toHaveBeenCalledWith(
      'btwUseCount',
      expect.any(Function),
    );
    const updater = vi.mocked(persistentState.update).mock.calls[0][1];
    expect(updater(undefined)).toEqual({ value: 1, result: true });
    expect(result).toMatchObject({ type: 'custom_dialog' });
    expect(dialogRequestId(result)).toBe(store.getReopenTargetId());
  });

  it('forwards session context without copying the model when no parent snapshot exists', async () => {
    const context = contextFor('session-1');
    Object.assign(context.services.agentContext!, {
      getCacheSafeQuerySnapshot: () => undefined,
    });
    await btwCommand.action!(context, 'question');
    const params = runner.mock.calls[0]![0];
    expect(params).toMatchObject({
      config: context.services.agentContext!.config,
      messages: context.messages,
      parentToolSchemas: [],
    });
    expect(params.cacheSafeQuerySnapshot).toBeUndefined();
    expect(params).not.toHaveProperty('model');
  });

  it('reopens the running question without asking again', async () => {
    const asked = await btwCommand.action!(contextFor('session-1'), 'q');
    const reopened = await btwCommand.action!(contextFor('session-1'), '');

    expect(runner).toHaveBeenCalledTimes(1);
    expect(dialogRequestId(reopened)).toBe(dialogRequestId(asked));
  });

  it('forgets side questions from a previous session', async () => {
    await btwCommand.action!(contextFor('session-1'), 'q');
    const result = await btwCommand.action!(contextFor('session-2'), '');

    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
  });
});
