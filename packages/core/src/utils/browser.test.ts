/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  browserLaunchIneligibilityReasons,
  shouldAttemptBrowserLaunch,
} from './browser.js';

describe('browser launch eligibility', () => {
  it('preserves the boolean decision while exposing every reason', () => {
    const options = {
      env: {
        BROWSER: 'www-browser --new-window',
        CI: '1',
        DEBIAN_FRONTEND: 'noninteractive',
      },
      platform: 'linux' as const,
    };

    expect(browserLaunchIneligibilityReasons(options)).toEqual([
      'BROWSER command "www-browser" is blocklisted',
      'CI is set',
      'DEBIAN_FRONTEND=noninteractive',
      'Linux has no DISPLAY, WAYLAND_DISPLAY, or MIR_SOCKET',
    ]);
    expect(shouldAttemptBrowserLaunch(options)).toBe(false);
  });

  it('allows Linux with a display and no non-interactive signals', () => {
    const options = {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      platform: 'linux' as const,
    };

    expect(browserLaunchIneligibilityReasons(options)).toEqual([]);
    expect(shouldAttemptBrowserLaunch(options)).toBe(true);
  });

  it('reports remote non-Linux sessions', () => {
    expect(
      browserLaunchIneligibilityReasons({
        env: { SSH_CONNECTION: 'client server' },
        platform: 'darwin',
      }),
    ).toEqual(['SSH_CONNECTION is set on darwin']);
  });
});
