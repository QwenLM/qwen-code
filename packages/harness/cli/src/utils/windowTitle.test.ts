/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BRAND_CLI_NAME } from '@qwen-code/core';
import {
  computeTerminalTitle,
  createProvisionalTerminalTitle,
  isWindowsTerminalHost,
  type TerminalTitleOptions,
} from './windowTitle.js';
import { StreamingState } from '../ui/types.js';

describe('isWindowsTerminalHost', () => {
  it('detects native Windows', () => {
    expect(isWindowsTerminalHost('win32', undefined)).toBe(true);
  });

  it('detects Windows Terminal from WSL', () => {
    expect(isWindowsTerminalHost('linux', 'wt-session-id')).toBe(true);
  });

  it('does not classify ordinary macOS or Linux terminals as Windows hosts', () => {
    expect(isWindowsTerminalHost('darwin', undefined)).toBe(false);
    expect(isWindowsTerminalHost('linux', undefined)).toBe(false);
  });
});

describe('computeTerminalTitle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      description: 'idle state title',
      args: {
        streamingState: StreamingState.Idle,
        isConfirming: false,
        sessionTitle: 'Fix terminal titles',
        useDynamicTitle: true,
      } as TerminalTitleOptions,
      expected: '◇ Fix terminal titles | Ready',
    },
    {
      description: 'legacy title when useDynamicTitle is false',
      args: {
        streamingState: StreamingState.Responding,
        isConfirming: false,
        sessionTitle: 'Fix terminal titles',
        useDynamicTitle: false,
      } as TerminalTitleOptions,
      expected: `${BRAND_CLI_NAME} (Fix terminal titles)`.padEnd(80, ' '),
      exact: true,
    },
    {
      description: 'active state title with "Working"',
      args: {
        streamingState: StreamingState.Responding,
        isConfirming: false,
        sessionTitle: 'Fix terminal titles',
        useDynamicTitle: true,
      } as TerminalTitleOptions,
      expected: '✦ Fix terminal titles | Working',
    },
    {
      description: 'action required state when confirming',
      args: {
        streamingState: StreamingState.Idle,
        isConfirming: true,
        sessionTitle: 'Fix terminal titles',
        useDynamicTitle: true,
      } as TerminalTitleOptions,
      expected: '▲ Fix terminal titles | Action Required',
    },
  ])('should return $description', ({ args, expected, exact }) => {
    const title = computeTerminalTitle(args);
    if (exact) {
      expect(title).toBe(expected);
    } else {
      expect(title).toContain(expected);
    }
    expect(title.length).toBe(80);
  });

  it('should truncate a long session title before the status description', () => {
    const longSessionTitle = 'A'.repeat(100);
    const title = computeTerminalTitle({
      streamingState: StreamingState.Responding,
      isConfirming: false,
      sessionTitle: longSessionTitle,
      useDynamicTitle: true,
    });

    expect(title.length).toBe(80);
    expect(title).toContain('… | Working');
  });

  it('should strip control characters from the title', () => {
    const title = computeTerminalTitle({
      streamingState: StreamingState.Responding,
      isConfirming: false,
      sessionTitle: 'BadTitle\x00 With\x07Control\x1BChars',
      useDynamicTitle: true,
    });

    expect(title).toContain(
      '✦ BadTitle With Control Chars | Working',
    );
    expect(title).not.toContain('\x00');
    expect(title).not.toContain('\x07');
    expect(title).not.toContain('\x1B');
    expect(title.length).toBe(80);
  });

  it('should prioritize CLI_TITLE over the session title', () => {
    vi.stubEnv('CLI_TITLE', 'EnvOverride');

    const title = computeTerminalTitle({
      streamingState: StreamingState.Idle,
      isConfirming: false,
      sessionTitle: 'Fix terminal titles',
      useDynamicTitle: true,
    });

    expect(title).toContain('◇ EnvOverride | Ready');
    expect(title).not.toContain('Fix terminal titles');
    expect(title.length).toBe(80);
  });

  it.each([
    {
      name: 'session title',
      sessionTitle: 'A'.repeat(100),
      expected: '◇ AAAAA',
    },
    {
      name: 'CLI_TITLE',
      sessionTitle: 'Fix terminal titles',
      envTitle: 'B'.repeat(100),
      expected: '◇ BBBBB',
    },
  ])(
    'should truncate very long $name to fit within 80 characters',
    ({ sessionTitle, envTitle, expected }) => {
      if (envTitle) {
        vi.stubEnv('CLI_TITLE', envTitle);
      }

      const title = computeTerminalTitle({
        streamingState: StreamingState.Idle,
        isConfirming: false,
        sessionTitle,
        useDynamicTitle: true,
      });

      expect(title.length).toBe(80);
      expect(title).toContain(expected);
      expect(title).toContain('… | Ready');
    },
  );

  it('should truncate a long session title when useDynamicTitle is false', () => {
    const longSessionTitle = 'C'.repeat(100);
    const title = computeTerminalTitle({
      streamingState: StreamingState.Responding,
      isConfirming: false,
      sessionTitle: longSessionTitle,
      useDynamicTitle: false,
    });

    expect(title.length).toBe(80);
    expect(title).toContain(`${BRAND_CLI_NAME} (CCCCC`);
    expect(title).toContain('…)');
  });

  it('creates a compact provisional title from the submitted prompt', () => {
    expect(
      createProvisionalTerminalTitle(
        '  Fix terminal\nwindow\x07 titles across platforms  ',
      ),
    ).toBe('Fix terminal window titles across platforms');
  });

  it('truncates provisional titles to leave room for status text', () => {
    const title = createProvisionalTerminalTitle('A'.repeat(100));

    expect(title).toHaveLength(60);
    expect(title?.endsWith('…')).toBe(true);
  });
});
