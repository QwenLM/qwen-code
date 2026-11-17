/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionClient } from '@qwen-code/sdk/daemon';
import {
  beginSessionConfigMutation,
  beginSessionConfigRead,
  observeSessionConfig,
  queueSessionConfigRefresh,
  resetSessionConfigSync,
  type SessionConfigSyncMap,
} from './session-config-sync.js';

describe('session config ordering', () => {
  const session = {} as DaemonSessionClient;

  it('does not treat two unfinished writes as idle and reconciles once', async () => {
    const states: SessionConfigSyncMap = new WeakMap();
    const first = beginSessionConfigMutation(states, session);
    const second = beginSessionConfigMutation(states, session);
    const read = beginSessionConfigRead(states, session);
    const refresh = vi.fn();
    queueSessionConfigRefresh(states, session, refresh);
    queueSessionConfigRefresh(states, session, refresh);
    expect(read()).toBe(false);
    first.finish();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    second.finish();
    second.finish();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(read()).toBe(false);
    expect(beginSessionConfigRead(states, session)()).toBe(true);
  });

  it('rejects a pre-push read and a late acknowledgement', () => {
    const states: SessionConfigSyncMap = new WeakMap();
    const read = beginSessionConfigRead(states, session);
    const write = beginSessionConfigMutation(states, session);
    observeSessionConfig(states, session);
    write.finish();
    expect(read()).toBe(false);
    expect(write.isCurrent()).toBe(false);
  });

  it('rejects a GET which finishes after a newer GET', () => {
    const states: SessionConfigSyncMap = new WeakMap();
    const first = beginSessionConfigRead(states, session);
    const second = beginSessionConfigRead(states, session);
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it('retires the old stream even when the session object is reused', () => {
    const states: SessionConfigSyncMap = new WeakMap();
    const oldWrite = beginSessionConfigMutation(states, session);
    const oldRead = beginSessionConfigRead(states, session);
    resetSessionConfigSync(states, session);
    const newRead = beginSessionConfigRead(states, session);
    oldWrite.finish();
    expect(oldWrite.isCurrent()).toBe(false);
    expect(oldRead()).toBe(false);
    expect(newRead()).toBe(true);
  });
});
