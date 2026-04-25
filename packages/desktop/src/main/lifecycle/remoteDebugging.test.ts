/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { configureDesktopRemoteDebugging } from './remoteDebugging.js';

describe('configureDesktopRemoteDebugging', () => {
  it('enables CDP on 127.0.0.1 when QWEN_DESKTOP_CDP_PORT is valid', () => {
    const appendSwitch = vi.fn();

    const enabled = configureDesktopRemoteDebugging(
      { appendSwitch },
      { QWEN_DESKTOP_CDP_PORT: '9222' },
    );

    expect(enabled).toBe(true);
    expect(appendSwitch).toHaveBeenCalledWith(
      'remote-debugging-address',
      '127.0.0.1',
    );
    expect(appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '9222');
  });

  it('does not enable CDP when the port is missing', () => {
    const appendSwitch = vi.fn();

    const enabled = configureDesktopRemoteDebugging({ appendSwitch }, {});

    expect(enabled).toBe(false);
    expect(appendSwitch).not.toHaveBeenCalled();
  });

  it('rejects invalid remote debugging ports', () => {
    const appendSwitch = vi.fn();

    for (const port of ['0', '65536', '0.0.0.0:9222', '9222abc']) {
      const enabled = configureDesktopRemoteDebugging(
        { appendSwitch },
        { QWEN_DESKTOP_CDP_PORT: port },
      );
      expect(enabled).toBe(false);
    }

    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
