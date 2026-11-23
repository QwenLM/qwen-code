/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QWEN_CODE_DESKTOP_ENV,
  QWEN_CODE_MANAGED_RUNTIME_ENV,
  QWEN_CODE_SERVE_ENV,
  resolveAcpChannelFallback,
  resolveDaemonExportChannel,
} from './acp-channel-fallback.js';

describe('resolveDaemonExportChannel', () => {
  it('labels hosted-harness daemons managed regardless of ambient markers', () => {
    expect(resolveDaemonExportChannel('hosted-harness', {})).toBe('managed');
    expect(
      resolveDaemonExportChannel('hosted-harness', {
        [QWEN_CODE_DESKTOP_ENV]: '1',
      }),
    ).toBe('managed');
  });

  it('labels desktop-shell daemons desktop and everything else daemon', () => {
    expect(
      resolveDaemonExportChannel(undefined, { [QWEN_CODE_DESKTOP_ENV]: '1' }),
    ).toBe('desktop');
    expect(resolveDaemonExportChannel(undefined, {})).toBe('daemon');
    // A co-resident harness's marker must not relabel an independent daemon.
    expect(
      resolveDaemonExportChannel(undefined, {
        [QWEN_CODE_MANAGED_RUNTIME_ENV]: '1',
      }),
    ).toBe('daemon');
  });
});

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

  it('reports managed for the Hosted Harness and its children', () => {
    expect(
      resolveAcpChannelFallback({ [QWEN_CODE_MANAGED_RUNTIME_ENV]: '1' }),
    ).toBe('managed');
    // The Harness is a daemon too; the Managed deployment identity wins.
    expect(
      resolveAcpChannelFallback({
        [QWEN_CODE_SERVE_ENV]: '1',
        [QWEN_CODE_MANAGED_RUNTIME_ENV]: '1',
      }),
    ).toBe('managed');
    expect(
      resolveAcpChannelFallback({
        [QWEN_CODE_SERVE_ENV]: '1',
        [QWEN_CODE_DESKTOP_ENV]: '1',
        [QWEN_CODE_MANAGED_RUNTIME_ENV]: '1',
      }),
    ).toBe('managed');
  });

  it.each(['', '0', 'false'])('ignores marker value %j', (value) => {
    expect(
      resolveAcpChannelFallback({
        [QWEN_CODE_SERVE_ENV]: value,
        [QWEN_CODE_DESKTOP_ENV]: value,
        [QWEN_CODE_MANAGED_RUNTIME_ENV]: value,
      }),
    ).toBe('ACP');
  });
});
