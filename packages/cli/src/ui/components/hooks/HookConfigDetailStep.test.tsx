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
import { HookConfigDetailStep } from './HookConfigDetailStep.js';
import type { HookEventDisplayInfo, HookConfigDisplayInfo } from './types.js';

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
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
    border: {
      default: 'gray',
    },
  },
}));

describe('HookConfigDetailStep', () => {
  const createMockHookEvent = (): HookEventDisplayInfo => ({
    event: HookEventName.Stop,
    shortDescription: 'Right before proto concludes its response',
    description: '',
    exitCodes: [
      { code: 0, description: 'stdout/stderr not shown' },
      {
        code: 2,
        description: 'show stderr to model and continue conversation',
      },
      { code: 'Other', description: 'show stderr to user only' },
    ],
    configs: [],
  });

  const createMockHookConfig = (
    source: HooksConfigSource = HooksConfigSource.User,
    sourceDisplay = 'User Settings',
    sourcePath?: string,
  ): HookConfigDisplayInfo => ({
    config: {
      type: HookType.Command,
      command: '/path/to/hook.sh',
    },
    source,
    sourceDisplay,
    sourcePath,
    enabled: true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render hook details title', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Hook details');
  });

  it('should render event name', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Event:');
    expect(lastFrame()).toContain(HookEventName.Stop);
  });

  it('should render hook type', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Type:');
    expect(lastFrame()).toContain('command');
  });

  it('should render source for User Settings', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig(HooksConfigSource.User);

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Source:');
    expect(lastFrame()).toContain('User Settings');
  });

  it('should render source for Local Settings', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig(HooksConfigSource.Project);

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Local Settings');
  });

  it('should render source for Extensions with path', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig(
      HooksConfigSource.Extensions,
      'ralph-wiggum',
      '/Users/test/.qwen/extensions/ralph-wiggum',
    );

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Extensions');
    expect(lastFrame()).toContain('/Users/test/.qwen/extensions/ralph-wiggum');
  });

  it('should render Extension field for extensions', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig(
      HooksConfigSource.Extensions,
      'ralph-wiggum',
    );

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Extension:');
    expect(lastFrame()).toContain('ralph-wiggum');
  });

  it('should not render Extension field for non-extensions', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig(HooksConfigSource.User);

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    // Should not have Extension label for User Settings
    const output = lastFrame();
    const extensionMatch = output?.match(/Extension:/g);
    expect(extensionMatch).toBeNull();
  });

  it('should render command', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Command:');
    expect(lastFrame()).toContain('/path/to/hook.sh');
  });

  it('should render hook name if present', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig: HookConfigDisplayInfo = {
      config: {
        type: HookType.Command,
        command: '/path/to/hook.sh',
        name: 'My Hook',
      },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    };

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Name:');
    expect(lastFrame()).toContain('My Hook');
  });

  it('should render hook description if present', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig: HookConfigDisplayInfo = {
      config: {
        type: HookType.Command,
        command: '/path/to/hook.sh',
        description: 'A test hook',
      },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    };

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Desc:');
    expect(lastFrame()).toContain('A test hook');
  });

  it('should render help text', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('To modify or remove this hook');
  });

  it('should render Esc hint', () => {
    const hookEvent = createMockHookEvent();
    const hookConfig = createMockHookConfig();

    const { lastFrame } = render(
      <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
    );

    expect(lastFrame()).toContain('Esc to go back');
  });

  it('should handle different event types', () => {
    const events = [
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.UserPromptSubmit,
      HookEventName.SessionStart,
    ];

    for (const event of events) {
      const hookEvent: HookEventDisplayInfo = {
        event,
        shortDescription: 'Test',
        description: '',
        exitCodes: [],
        configs: [],
      };
      const hookConfig = createMockHookConfig();

      const { lastFrame } = render(
        <HookConfigDetailStep hookEvent={hookEvent} hookConfig={hookConfig} />,
      );

      expect(lastFrame()).toContain(event);
    }
  });
});
