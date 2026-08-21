/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';

const startPostRenderPrefetchesMock = vi.fn();
vi.mock('../../startup/startup-prefetch.js', () => ({
  startPostRenderPrefetches: (...args: unknown[]) =>
    startPostRenderPrefetchesMock(...args),
}));

import { updateEventEmitter } from '../../utils/updateEventEmitter.js';
import {
  startOpenTuiPostRenderPrefetches,
  setupUpdateNotifications,
} from './post-render.js';
import type { LoadedSettings } from '../../config/settings.js';

function makeConfig(deferred = true): Config {
  return {
    isTelemetryInitializationDeferred: () => deferred,
  } as unknown as Config;
}

describe('startOpenTuiPostRenderPrefetches', () => {
  beforeEach(() => startPostRenderPrefetchesMock.mockReset());

  it('delegates to startPostRenderPrefetches with defaults', () => {
    const config = makeConfig(true);
    const settings = { merged: {} } as unknown as LoadedSettings;
    startOpenTuiPostRenderPrefetches(config, settings);
    expect(startPostRenderPrefetchesMock).toHaveBeenCalledWith(
      config,
      settings,
      { connectIde: false, initializeTelemetry: true },
    );
  });

  it('respects explicit options', () => {
    const config = makeConfig(true);
    const settings = { merged: {} } as unknown as LoadedSettings;
    startOpenTuiPostRenderPrefetches(config, settings, {
      connectIde: true,
      initializeTelemetry: false,
    });
    expect(startPostRenderPrefetchesMock).toHaveBeenCalledWith(
      config,
      settings,
      { connectIde: true, initializeTelemetry: false },
    );
  });
});

describe('setupUpdateNotifications', () => {
  afterEach(() => {
    updateEventEmitter.removeAllListeners();
  });

  it('surfaces update-info notifications through the callback', () => {
    const onNotice = vi.fn();
    const handle = setupUpdateNotifications(onNotice);
    updateEventEmitter.emit('update-info', { message: 'Update available' });
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Update available' }),
    );
    handle.dispose();
  });

  it('defers notifications while not idle and flushes on demand', () => {
    const onNotice = vi.fn();
    const isIdleRef = { current: false };
    const handle = setupUpdateNotifications(onNotice, isIdleRef);

    updateEventEmitter.emit('update-info', { message: 'Deferred' });
    expect(onNotice).not.toHaveBeenCalled();

    handle.flush();
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Deferred' }),
    );
    handle.dispose();
  });

  it('stops listening after dispose', () => {
    const onNotice = vi.fn();
    const handle = setupUpdateNotifications(onNotice);
    handle.dispose();
    updateEventEmitter.emit('update-info', { message: 'Gone' });
    expect(onNotice).not.toHaveBeenCalled();
  });
});
