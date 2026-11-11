/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const manifestMocks = vi.hoisted(() => ({
  getWindowsAvx2Support: vi.fn(),
  hasAVX2: vi.fn(),
}));

vi.mock('../update/manifest.js', () => manifestMocks);

import { detectAvx2Support } from './systemInfo.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

describe('detectAvx2Support', () => {
  it('uses the Windows runtime AVX2 probe on Windows', () => {
    setPlatform('win32');
    manifestMocks.getWindowsAvx2Support.mockReturnValue(false);

    expect(detectAvx2Support()).toBe(false);
    expect(manifestMocks.getWindowsAvx2Support).toHaveBeenCalledTimes(1);
    expect(manifestMocks.hasAVX2).not.toHaveBeenCalled();
  });

  it('does not report Windows AVX2 as present when detection is unknown', () => {
    setPlatform('win32');
    manifestMocks.getWindowsAvx2Support.mockReturnValue(null);

    expect(detectAvx2Support()).toBe(false);
  });

  it('keeps the existing Linux AVX2 probe on non-Windows platforms', () => {
    setPlatform('linux');
    manifestMocks.hasAVX2.mockReturnValue(true);

    expect(detectAvx2Support()).toBe(true);
    expect(manifestMocks.hasAVX2).toHaveBeenCalledTimes(1);
    expect(manifestMocks.getWindowsAvx2Support).not.toHaveBeenCalled();
  });
});
