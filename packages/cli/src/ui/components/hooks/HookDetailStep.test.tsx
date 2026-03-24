/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import {
  HookEventName,
  HooksConfigSource,
  HookType,
} from '@qwen-code/qwen-code-core';
import { HookDetailStep } from './HookDetailStep.js';
import type { HookEventDisplayInfo } from './types.js';

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

// Mock useKeypress
vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

// Mock useTerminalSize
vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 100, rows: 24 })),
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

describe('HookDetailStep', () => {
  const mockOnBack = vi.fn();

  const createMockHookInfo = (
    event: HookEventName,
    configCount = 0,
    hasDescription = true,
  ): HookEventDisplayInfo => ({
    event,
    shortDescription: `Short description for ${event}`,
    description: hasDescription ? `Detailed description for ${event}` : '',
    exitCodes: [
      { code: 0, description: 'Success' },
      { code: 2, description: 'Block' },
    ],
    configs: Array(configCount)
      .fill(null)
      .map((_, i) => ({
        config: { command: `hook-command-${i}`, type: HookType.Command },
        source:
          i % 2 === 0 ? HooksConfigSource.User : HooksConfigSource.Project,
        sourceDisplay: i % 2 === 0 ? 'User Settings' : 'Local Settings',
        enabled: true,
      })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render hook event name as title', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    expect(lastFrame()).toContain(HookEventName.PreToolUse);
  });

  it('should render description when present', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse, 0, true);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    expect(lastFrame()).toContain('Detailed description for PreToolUse');
  });

  it('should not render description section when empty', () => {
    const hook = createMockHookInfo(HookEventName.Stop, 0, false);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    // Stop event has empty description
    const output = lastFrame();
    expect(output).toContain(HookEventName.Stop);
  });

  it('should render exit codes', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('Exit codes');
    expect(output).toContain('0');
    expect(output).toContain('Success');
    expect(output).toContain('2');
    expect(output).toContain('Block');
  });

  it('should show empty state when no configs', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse, 0);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('No hooks configured for this event');
    expect(output).toContain('To add hooks, edit settings.json');
  });

  it('should show configured hooks list when configs exist', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse, 2);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('Configured hooks');
    expect(output).toContain('[command]');
    expect(output).toContain('hook-command-0');
    expect(output).toContain('hook-command-1');
  });

  it('should show source display for each config', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse, 2);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('User Settings');
    expect(output).toContain('Local Settings');
  });

  it('should show selection indicator for first config', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse, 3);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('❯');
  });

  it('should show keyboard hint for going back', () => {
    const hook = createMockHookInfo(HookEventName.PreToolUse);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    expect(lastFrame()).toContain('Esc to go back');
  });

  it('should render with multiple configs', () => {
    const hook = createMockHookInfo(HookEventName.PostToolUse, 5);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('3.');
    expect(output).toContain('4.');
    expect(output).toContain('5.');
  });

  it('should handle hook with no exit codes', () => {
    const hook: HookEventDisplayInfo = {
      event: HookEventName.PreToolUse,
      shortDescription: 'Test',
      description: 'Test description',
      exitCodes: [],
      configs: [],
    };

    const { lastFrame } = render(
      <HookDetailStep hook={hook} onBack={mockOnBack} />,
    );

    const output = lastFrame();
    expect(output).not.toContain('Exit codes');
  });

  it('should handle different hook event types', () => {
    const events = [
      HookEventName.Stop,
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.UserPromptSubmit,
      HookEventName.SessionStart,
      HookEventName.SessionEnd,
    ];

    for (const event of events) {
      const hook = createMockHookInfo(event, 1);

      const { lastFrame } = render(
        <HookDetailStep hook={hook} onBack={mockOnBack} />,
      );

      expect(lastFrame()).toContain(event);
    }
  });
});
