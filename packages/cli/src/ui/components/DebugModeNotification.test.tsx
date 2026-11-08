/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Config } from '@qwen-code/qwen-code-core';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { DebugModeNotification } from './DebugModeNotification.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    isEnabled: () => false,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
  Storage: {
    getDebugLogPath: (sessionId: string) => `/tmp/qwen-debug/${sessionId}.txt`,
  },
  isDebugLoggingDegraded: () => false,
  isDebugLogFileEnabled: () => {
    const value = process.env['QWEN_DEBUG_LOG_FILE'];
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return !['', '0', 'false', 'off', 'no'].includes(normalized);
  },
}));

describe('DebugModeNotification', () => {
  const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];

  afterEach(() => {
    if (previousDebugLogFileEnv === undefined) {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
    } else {
      process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
    }
  });

  function renderNotification() {
    const config = {
      getDebugMode: () => true,
      getSessionId: () => '92ec0176-d354-4147-848b-5cd2d80609c4',
    } as unknown as Config;

    return render(
      <ConfigContext.Provider value={config}>
        <DebugModeNotification />
      </ConfigContext.Provider>,
    );
  }

  it('shows the debug log path when file logging is enabled', () => {
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';

    const { lastFrame } = renderNotification();

    expect(lastFrame()).toContain('Debug mode enabled');
    expect(lastFrame()).toContain('Logging to:');
    expect(lastFrame()).toContain('92ec0176-d354-4147-848b-5cd2d80609c4.txt');
  });

  it('does not show a log path when debug file logging is disabled', () => {
    process.env['QWEN_DEBUG_LOG_FILE'] = '0';

    const { lastFrame } = renderNotification();

    expect(lastFrame()).toContain('Debug mode enabled');
    expect(lastFrame()).toContain(
      'Debug log file disabled by QWEN_DEBUG_LOG_FILE',
    );
    expect(lastFrame()).not.toContain('Logging to:');
  });
});
