/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
} from '@qwen-code/qwen-code-core';
import { HooksListStep } from './HooksListStep.js';
import type { HookEventDisplayInfo } from './types.js';

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string, options?: { count?: string }) => {
    // Handle pluralization
    if (key === '{{count}} hook configured' && options?.count) {
      return `${options.count} hook configured`;
    }
    if (key === '{{count}} hooks configured' && options?.count) {
      return `${options.count} hooks configured`;
    }
    return key;
  }),
}));

// Mock useTerminalSize
vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 24 })),
}));

// Mock semantic-colors
vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: {
      primary: 'white',
      secondary: 'gray',
      accent: 'cyan',
    },
    status: {
      success: 'green',
      error: 'red',
    },
  },
}));

describe('HooksListStep', () => {
  const createMockHookInfo = (
    event: HookEventName,
    configCount = 0,
  ): HookEventDisplayInfo => ({
    event,
    shortDescription: `Description for ${event}`,
    description: `Detailed description for ${event}`,
    exitCodes: [
      { code: 0, description: 'Success' },
      { code: 2, description: 'Block' },
    ],
    configs: Array(configCount)
      .fill(null)
      .map((_, i) => ({
        config: { command: `hook-${i}`, type: HookType.Command },
        source: HooksConfigSource.User,
        sourceDisplay: 'User Settings',
        enabled: true,
      })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render empty state when no hooks', () => {
    const { lastFrame } = render(
      <HooksListStep hooks={[]} selectedIndex={0} />,
    );

    expect(lastFrame()).toContain('No hook events found');
  });

  it('should render list of hooks', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse),
      createMockHookInfo(HookEventName.PostToolUse),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('Hooks');
    expect(output).toContain(HookEventName.PreToolUse);
    expect(output).toContain(HookEventName.PostToolUse);
  });

  it('should show config count for hooks with configs', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse, 3),
      createMockHookInfo(HookEventName.PostToolUse, 0),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('(3)');
    expect(output).not.toContain('(0)');
  });

  it('should show total configured hooks count', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse, 2),
      createMockHookInfo(HookEventName.PostToolUse, 3),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('5 hooks configured');
  });

  it('should show singular form for single hook', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse, 1),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('1 hook configured');
  });

  it('should show read-only message', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('read-only');
    expect(output).toContain('settings.json');
  });

  it('should show keyboard hints', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('Enter to select');
    expect(output).toContain('Esc to cancel');
  });

  it('should show selection indicator for first item', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse),
      createMockHookInfo(HookEventName.PostToolUse),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('❯');
  });

  it('should display hook short descriptions', () => {
    const hooks: HookEventDisplayInfo[] = [
      createMockHookInfo(HookEventName.PreToolUse),
    ];

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain('Description for PreToolUse');
  });

  it('should pad index numbers based on total count', () => {
    const hooks: HookEventDisplayInfo[] = Array(10)
      .fill(null)
      .map((_, i) => createMockHookInfo(`${i}` as HookEventName));

    const { lastFrame } = render(
      <HooksListStep hooks={hooks} selectedIndex={0} />,
    );

    const output = lastFrame();
    expect(output).toContain(' 1.');
    expect(output).toContain('10.');
  });
});
