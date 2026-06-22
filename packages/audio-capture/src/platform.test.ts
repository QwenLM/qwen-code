/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getPlatformBackendName } from './platform.js';

describe('getPlatformBackendName', () => {
  it('maps macOS, Linux, and Windows to native audio backends', () => {
    expect(getPlatformBackendName('darwin')).toBe('coreaudio');
    expect(getPlatformBackendName('linux')).toBe('alsa-pulse');
    expect(getPlatformBackendName('win32')).toBe('wasapi');
  });

  it('rejects unsupported platforms with a useful error', () => {
    expect(() => getPlatformBackendName('freebsd')).toThrow(
      'Native audio capture is not available for freebsd.',
    );
  });
});
