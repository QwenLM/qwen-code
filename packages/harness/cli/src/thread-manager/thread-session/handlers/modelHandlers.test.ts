/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import type { ThreadCallContext, ThreadHostRequests } from '../contract/hostContext.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';
import { setModel } from './modelHandlers.js';

function fixture() {
  let model = 'before';
  let identity = 'account';
  const refreshRuntimeContext = vi.fn();
  const config = {
    getModel: () => model,
    getModelRequestIdentity: () => identity,
    setModel: vi.fn(async (next: string) => { model = next; return true; }),
  } as unknown as Config;
  const requests: Pick<ThreadHostRequests, 'changeModel'> = {};
  const session = {
    host: { requests },
    requireConfig: () => config,
    isTerminated: () => false,
    signal: new AbortController().signal,
    peekQueryRunner: () => ({ refreshRuntimeContext }),
  } as unknown as ThreadSessionInternals;
  return {
    config, requests, session, refreshRuntimeContext,
    changeIdentity: () => { identity = 'other-account'; },
  };
}
const ctx = {} as ThreadCallContext;

describe('host model changes', () => {
  it('keeps the default Config operation for a host without an override', async () => {
    const f = fixture();
    await setModel(f.session, ctx, { model: 'after' });
    expect(f.config.setModel).toHaveBeenCalledExactlyOnceWith('after', true);
    expect(f.refreshRuntimeContext).toHaveBeenCalledExactlyOnceWith({ resetModelRouting: true });
  });

  it('awaits the host operation and forwards persistence semantics', async () => {
    const f = fixture();
    f.requests.changeModel = vi.fn(async ({ config, model, isTemporary }) =>
      config.setModel(model, isTemporary),
    );
    await setModel(f.session, ctx, { model: 'after', persisted: true });
    expect(f.requests.changeModel).toHaveBeenCalledExactlyOnceWith({
      config: f.config, model: 'after', isTemporary: true, persisted: true,
    });
    expect(f.config.setModel).toHaveBeenCalledOnce();
    expect(f.refreshRuntimeContext).toHaveBeenCalledOnce();
  });

  it('validates context windows before invoking the host', async () => {
    const f = fixture();
    f.requests.changeModel = vi.fn();
    await expect(setModel(f.session, ctx, { model: 'after', contextWindow: 'invalid' }))
      .rejects.toThrow('invalid context_window');
    expect(f.requests.changeModel).not.toHaveBeenCalled();
    expect(f.config.setModel).not.toHaveBeenCalled();
  });

  it('rejects late host results after an identity change', async () => {
    const f = fixture();
    f.requests.changeModel = async ({ config, model }) => {
      const saved = await config.setModel(model, true);
      f.changeIdentity();
      return saved;
    };
    await expect(setModel(f.session, ctx, { model: 'after' }))
      .rejects.toThrow('会话目标已变化');
    expect(f.refreshRuntimeContext).not.toHaveBeenCalled();
  });
});
