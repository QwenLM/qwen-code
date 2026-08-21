/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  buildQuitFarewellLines,
  buildQuitFarewellForConfig,
} from './quit-farewell.js';

const NOW = 1_000_000_000_000;

describe('buildQuitFarewellLines', () => {
  it('includes the goodbye line and formatted wall time', () => {
    const lines = buildQuitFarewellLines({
      sessionId: 'abc',
      sessionStartTime: new Date(NOW - 65_000),
      canResume: false,
      hasMessages: false,
      now: NOW,
    });
    expect(lines[0]).toBe('Agent powering down. Goodbye!');
    expect(lines[1]).toMatch(/Wall Time:.*1m/);
    expect(lines.join('\n')).not.toContain('--resume');
  });

  it('adds the resume hint only when there are messages and recording', () => {
    const lines = buildQuitFarewellLines({
      sessionId: 'sess-123',
      sessionStartTime: new Date(NOW),
      canResume: true,
      hasMessages: true,
      now: NOW,
    });
    expect(lines).toContain('qwen --resume sess-123');
  });

  it('omits the resume hint when there were no messages', () => {
    const lines = buildQuitFarewellLines({
      sessionId: 'sess-123',
      sessionStartTime: new Date(NOW),
      canResume: true,
      hasMessages: false,
      now: NOW,
    });
    expect(lines.join('\n')).not.toContain('--resume');
  });

  it('omits the resume hint when recording is disabled', () => {
    const lines = buildQuitFarewellLines({
      sessionId: 'sess-123',
      sessionStartTime: new Date(NOW),
      canResume: false,
      hasMessages: true,
      now: NOW,
    });
    expect(lines.join('\n')).not.toContain('--resume');
  });

  it('never reports a negative wall time', () => {
    const lines = buildQuitFarewellLines({
      sessionId: 'abc',
      sessionStartTime: new Date(NOW + 5_000),
      canResume: false,
      hasMessages: false,
      now: NOW,
    });
    expect(lines[1]).toMatch(/Wall Time:.*0s/);
  });
});

describe('buildQuitFarewellForConfig', () => {
  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      getSessionId: () => 'session-xyz',
      getChatRecordingService: () => ({}),
      ...overrides,
    } as unknown as Config;
  }

  it('builds a resume hint for a recording-enabled config', () => {
    const lines = buildQuitFarewellForConfig(
      makeConfig(),
      true,
      new Date(Date.now()),
    );
    expect(lines).not.toBeNull();
    expect(lines!.join('\n')).toContain('qwen --resume session-xyz');
  });

  it('returns null when there is no session id', () => {
    const lines = buildQuitFarewellForConfig(
      makeConfig({ getSessionId: () => '' } as unknown as Partial<Config>),
      true,
      new Date(),
    );
    expect(lines).toBeNull();
  });
});
