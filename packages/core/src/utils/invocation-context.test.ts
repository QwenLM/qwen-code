/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getInvocationContext,
  INVOCATION_CONTEXT_META_KEY,
  parseInvocationContext,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from './invocation-context.js';

const context: InvocationContextV1 = {
  version: 1,
  sessionId: 'session-1',
  promptId: 'prompt-1',
  originatorClientId: 'client-1',
};

describe('invocation context wire contract', () => {
  it('exports the reserved metadata keys', () => {
    expect(INVOCATION_CONTEXT_META_KEY).toBe('qwen-code/invocation');
    expect(PRIVATE_PARENT_CAPABILITY_META_KEY).toBe(
      'qwen-code/private-parent-capability',
    );
  });

  it('strictly parses valid contexts', () => {
    const parsed = parseInvocationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseInvocationContext({
        version: 1,
        sessionId: 'session-2',
        promptId: 'prompt-2',
      }),
    ).toEqual({
      version: 1,
      sessionId: 'session-2',
      promptId: 'prompt-2',
    });
  });

  it.each([
    undefined,
    null,
    [],
    { version: 2, sessionId: 'session', promptId: 'prompt' },
    { version: 1, sessionId: ' ', promptId: 'prompt' },
    { version: 1, sessionId: 'session', promptId: '' },
    {
      version: 1,
      sessionId: 'session',
      promptId: 'prompt',
      originatorClientId: ' ',
    },
    {
      version: 1,
      sessionId: 'session',
      promptId: 'prompt',
      ingress: 'daemon',
    },
  ])('rejects malformed context %#', (value) => {
    expect(parseInvocationContext(value)).toBeUndefined();
  });
});

describe('invocation context async storage', () => {
  it('restores nested and explicitly cleared contexts', () => {
    const nested = { ...context, promptId: 'prompt-2' };

    expect(getInvocationContext()).toBeUndefined();
    runWithInvocationContext(context, () => {
      expect(getInvocationContext()).toBe(context);
      runWithInvocationContext(nested, () => {
        expect(getInvocationContext()).toBe(nested);
      });
      runWithInvocationContext(undefined, () => {
        expect(getInvocationContext()).toBeUndefined();
      });
      expect(getInvocationContext()).toBe(context);
    });
    expect(getInvocationContext()).toBeUndefined();
  });

  it('isolates concurrent async execution trees', async () => {
    const readPromptId = (promptId: string) =>
      runWithInvocationContext({ ...context, promptId }, async () => {
        await Promise.resolve();
        return getInvocationContext()?.promptId;
      });

    await expect(
      Promise.all([readPromptId('prompt-a'), readPromptId('prompt-b')]),
    ).resolves.toEqual(['prompt-a', 'prompt-b']);
  });
});
