/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getInvocationContext,
  INVOCATION_CONTEXT_META_KEY,
  INVOCATION_INGRESS_META_KEY,
  parseInvocationContext,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from './invocation-context.js';

const context: InvocationContextV1 = {
  version: 1,
  ingress: 'external_mcp',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  originatorClientId: 'client-1',
};

describe('invocation context wire contract', () => {
  it('exports the reserved metadata keys', () => {
    expect(INVOCATION_CONTEXT_META_KEY).toBe('qwen-code/invocation');
    expect(INVOCATION_INGRESS_META_KEY).toBe('qwen-code/invocation-ingress');
    expect(PRIVATE_PARENT_CAPABILITY_META_KEY).toBe(
      'qwen-code/private-parent-capability',
    );
  });

  it('parses valid contexts with and without an originator', () => {
    expect(parseInvocationContext(context)).toEqual(context);
    expect(
      parseInvocationContext({
        version: 1,
        ingress: 'cli',
        sessionId: 'session-2',
        promptId: 'prompt-2',
      }),
    ).toEqual({
      version: 1,
      ingress: 'cli',
      sessionId: 'session-2',
      promptId: 'prompt-2',
    });
  });

  it.each([
    undefined,
    null,
    [],
    {
      version: 2,
      ingress: 'cli',
      sessionId: 'session-3',
      promptId: 'prompt-3',
    },
    {
      version: 1,
      ingress: 'webhook',
      sessionId: 'session-4',
      promptId: 'prompt-4',
    },
    {
      version: 1,
      ingress: 'daemon',
      sessionId: '  ',
      promptId: 'prompt-5',
    },
    {
      version: 1,
      ingress: 'daemon',
      sessionId: 'session-6',
      promptId: '',
    },
    {
      version: 1,
      ingress: 'daemon',
      sessionId: 'session-7',
      promptId: 'prompt-7',
      originatorClientId: ' ',
    },
    {
      version: 1,
      ingress: 'daemon',
      sessionId: 'session-8',
      promptId: 'prompt-8',
      trusted: true,
    },
  ])('rejects malformed context %#', (value) => {
    expect(parseInvocationContext(value)).toBeUndefined();
  });
});

describe('invocation context async storage', () => {
  it('is undefined outside a context and restores nested contexts', () => {
    const nestedContext: InvocationContextV1 = {
      ...context,
      promptId: 'prompt-2',
    };

    expect(getInvocationContext()).toBeUndefined();
    runWithInvocationContext(context, () => {
      expect(getInvocationContext()).toBe(context);
      runWithInvocationContext(nestedContext, () => {
        expect(getInvocationContext()).toBe(nestedContext);
      });
      expect(getInvocationContext()).toBe(context);
    });
    expect(getInvocationContext()).toBeUndefined();
  });

  it('can explicitly clear and then restore an outer context', () => {
    runWithInvocationContext(context, () => {
      expect(getInvocationContext()).toBe(context);
      runWithInvocationContext(undefined, () => {
        expect(getInvocationContext()).toBeUndefined();
      });
      expect(getInvocationContext()).toBe(context);
    });
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
