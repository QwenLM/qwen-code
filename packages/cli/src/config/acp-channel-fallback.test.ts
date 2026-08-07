/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QWEN_CODE_DESKTOP_ENV,
  QWEN_CODE_SERVE_ENV,
  resolveAcpChannelFallback,
} from './acp-channel-fallback.js';

describe('resolveAcpChannelFallback', () => {
  it('falls back to ACP for a direct launch without daemon markers', () => {
    expect(resolveAcpChannelFallback({})).toBe('ACP');
  });

  it('reports daemon for daemon-spawned children', () => {
    expect(resolveAcpChannelFallback({ [QWEN_CODE_SERVE_ENV]: '1' })).toBe(
      'daemon',
    );
  });

  it('reports desktop for the Tauri desktop shell', () => {
    expect(resolveAcpChannelFallback({ [QWEN_CODE_DESKTOP_ENV]: '1' })).toBe(
      'desktop',
    );
    // Tauri sessions are daemon-spawned too; the launcher identity wins.
    expect(
      resolveAcpChannelFallback({
        [QWEN_CODE_SERVE_ENV]: '1',
        [QWEN_CODE_DESKTOP_ENV]: '1',
      }),
    ).toBe('desktop');
  });

  it('ignores empty marker values', () => {
    expect(
      resolveAcpChannelFallback({
        [QWEN_CODE_SERVE_ENV]: '',
        [QWEN_CODE_DESKTOP_ENV]: '',
      }),
    ).toBe('ACP');
  });
});
