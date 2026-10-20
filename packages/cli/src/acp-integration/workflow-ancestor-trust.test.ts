/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { WORKFLOW_ANCESTOR_TRUST_METHOD } from '@qwen-code/acp-bridge/workflowAncestorTrust';
import {
  createParentWorkflowAncestorTrustProvider,
  WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS,
} from './workflow-ancestor-trust.js';

describe('private parent workflow ancestor trust', () => {
  const target = path.resolve('repo', 'packages', 'app');
  const ancestors = [path.dirname(target), path.dirname(path.dirname(target))];

  afterEach(() => vi.useRealTimers());

  function setup() {
    let trusted = false;
    let sessionId: string | undefined;
    let targetDir = target;
    let epoch = 0;
    const extMethod = vi
      .fn()
      .mockResolvedValue({ v: 1, trusted: [true, false] });
    return {
      extMethod,
      provider: createParentWorkflowAncestorTrustProvider(
        { extMethod },
        {
          isParentTrusted: () => trusted,
          getSessionId: () => sessionId,
          getCwdState: () => ({ canonicalTargetDir: targetDir, epoch }),
        },
      ),
      authenticate() {
        trusted = true;
      },
      bind(id = 'live-session') {
        sessionId = id;
      },
      close() {
        trusted = false;
      },
      setCwd(directory: string, revision: number) {
        targetDir = directory;
        epoch = revision;
      },
    };
  }

  it('denies before authentication or session binding without querying', async () => {
    const state = setup();
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
    state.authenticate();
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
    expect(state.extMethod).not.toHaveBeenCalled();
    state.bind();
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      true,
      false,
    ]);
    expect(state.extMethod).toHaveBeenCalledWith(
      WORKFLOW_ANCESTOR_TRUST_METHOD,
      {
        v: 1,
        sessionId: 'live-session',
        canonicalTargetDir: target,
        ancestorDirs: ancestors,
      },
    );
  });

  it('queries each lookup with its current canonical target', async () => {
    const state = setup();
    state.authenticate();
    state.bind();
    await state.provider(ancestors, target);
    const next = path.join(target, 'nested');
    state.setCwd(next, 2);
    state.extMethod.mockResolvedValue({ v: 1, trusted: [false] });
    await expect(state.provider([target], next)).resolves.toEqual([false]);
    expect(state.extMethod).toHaveBeenLastCalledWith(
      WORKFLOW_ANCESTOR_TRUST_METHOD,
      {
        v: 1,
        sessionId: 'live-session',
        canonicalTargetDir: next,
        ancestorDirs: [target],
      },
    );
  });

  it.each([
    {},
    { v: 2, trusted: [true, true] },
    { v: 1, trusted: [true] },
    { v: 1, trusted: [true, 'true'] },
    { v: 1, trusted: new Array(2) },
  ])('denies the entire malformed response %j', async (response) => {
    const state = setup();
    state.authenticate();
    state.bind();
    state.extMethod.mockResolvedValue(response);
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
  });

  it('denies an unsupported or disconnected parent', async () => {
    const state = setup();
    state.authenticate();
    state.bind();
    state.extMethod.mockRejectedValue(new Error('method not found'));
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
  });

  it.each(['close', 'rebind'] as const)(
    'discards a late grant after %s',
    async (change) => {
      const state = setup();
      state.authenticate();
      state.bind();
      let resolve: (value: Record<string, unknown>) => void = () => undefined;
      state.extMethod.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const pending = state.provider(ancestors, target);
      if (change === 'close') state.close();
      else state.bind('another-session');
      resolve({ v: 1, trusted: [true, true] });
      await expect(pending).resolves.toEqual([false, false]);
    },
  );

  it('bounds a stuck parent and consumes a late rejection', async () => {
    vi.useFakeTimers();
    const state = setup();
    state.authenticate();
    state.bind();
    let reject: (error: Error) => void = () => undefined;
    state.extMethod.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const pending = state.provider(ancestors, target);
    await vi.advanceTimersByTimeAsync(WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual([false, false]);
    reject(new Error('late disconnect'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('denies during a cwd transition without querying the parent', async () => {
    const state = setup();
    state.authenticate();
    state.bind();
    state.setCwd(target, 1);
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
    expect(state.extMethod).not.toHaveBeenCalled();
    state.setCwd(target, 2);
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      true,
      false,
    ]);
  });

  it('denies a lookup captured before the current cwd without querying', async () => {
    const state = setup();
    state.authenticate();
    state.bind();
    state.setCwd(path.join(target, 'nested'), 2);
    await expect(state.provider(ancestors, target)).resolves.toEqual([
      false,
      false,
    ]);
    expect(state.extMethod).not.toHaveBeenCalled();
  });

  it.each(['target', 'transition', 'settled', 'roundtrip'])(
    'rejects a late reply after cwd %s changes',
    async (change) => {
      const state = setup();
      state.authenticate();
      state.bind();
      let release!: (value: Record<string, unknown>) => void;
      state.extMethod.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const pending = state.provider(ancestors, target);
      state.setCwd(
        change === 'target' || change === 'transition'
          ? path.join(target, 'nested')
          : target,
        change === 'target'
          ? 0
          : change === 'transition'
            ? 1
            : change === 'settled'
              ? 2
              : 4,
      );
      release({ v: 1, trusted: [true, true] });
      await expect(pending).resolves.toEqual([false, false]);
    },
  );

  it('does not send empty or oversized batches', async () => {
    const state = setup();
    state.authenticate();
    state.bind();
    await expect(state.provider([], target)).resolves.toEqual([]);
    const oversized = Array.from({ length: 257 }, () => ancestors[0]);
    await expect(state.provider(oversized, target)).resolves.toEqual(
      oversized.map(() => false),
    );
    expect(state.extMethod).not.toHaveBeenCalled();
  });
});
