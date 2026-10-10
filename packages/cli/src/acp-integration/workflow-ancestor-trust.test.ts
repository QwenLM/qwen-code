/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import {
  createParentWorkflowAncestorTrustProvider,
  WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS,
  WorkflowAncestorTrustHolder,
} from './workflow-ancestor-trust.js';

const dirs = ['/repo/packages', '/repo'];

describe('WorkflowAncestorTrustHolder', () => {
  it('denies until a provider is bound and again after it is cleared', async () => {
    const holder = new WorkflowAncestorTrustHolder();
    await expect(holder.provider(dirs)).resolves.toEqual([false, false]);
    holder.set(async (d) => d.map(() => true));
    await expect(holder.provider(dirs)).resolves.toEqual([true, true]);
    holder.set(undefined);
    await expect(holder.provider(dirs)).resolves.toEqual([false, false]);
  });
});

describe('createParentWorkflowAncestorTrustProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the parent once with the chain and returns its answer', async () => {
    const extMethod = vi.fn(async () => ({ trusted: [true, false] }));
    const provider = createParentWorkflowAncestorTrustProvider({ extMethod });
    await expect(provider(dirs)).resolves.toEqual([true, false]);
    expect(extMethod).toHaveBeenCalledTimes(1);
    expect(extMethod).toHaveBeenCalledWith(
      SERVE_CONTROL_EXT_METHODS.workflowAncestorTrust,
      { ancestorDirs: dirs },
    );
  });

  it.each([
    [
      'rejects (older parent / methodNotFound)',
      async () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
    ],
    ['answers the wrong length', async () => ({ trusted: [true] })],
    ['answers non-booleans', async () => ({ trusted: ['yes', 1] })],
    ['answers extra fields', async () => ({ trusted: [true, true], extra: 1 })],
    ['answers no array', async () => ({ trusted: true })],
  ])('denies every ancestor when the parent %s', async (_l, impl) => {
    const provider = createParentWorkflowAncestorTrustProvider({
      extMethod: impl as never,
    });
    await expect(provider(dirs)).resolves.toEqual([false, false]);
  });

  it('denies after the bounded wait and ignores a late answer', async () => {
    vi.useFakeTimers();
    let answer: ((value: Record<string, unknown>) => void) | undefined;
    const provider = createParentWorkflowAncestorTrustProvider({
      extMethod: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const pending = provider(dirs);
    await vi.advanceTimersByTimeAsync(WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual([false, false]);
    answer?.({ trusted: [true, true] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not call the parent for an empty chain', async () => {
    const extMethod = vi.fn();
    const provider = createParentWorkflowAncestorTrustProvider({ extMethod });
    await expect(provider([])).resolves.toEqual([]);
    expect(extMethod).not.toHaveBeenCalled();
  });
});
