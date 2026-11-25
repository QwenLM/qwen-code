/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders as baseRender } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { makeFakeConfig, ExitCodes } from '@qwen-code/core';
import { waitFor } from '../../test-utils/async.js';
import { act } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FolderTrustDialog } from './FolderTrustDialog.js';
import { SettingScope } from '../../config/settings.js';

const mockedGracefulExit = vi.hoisted(() => vi.fn());
const mockedCwd = vi.hoisted(() => vi.fn().mockReturnValue('/mock/cwd'));
const mockedRows = vi.hoisted(() => ({ current: 24 }));

const renderWithProviders: typeof baseRender = (tree, options = {}) => {
  const config = options.config ?? makeFakeConfig();
  vi.spyOn(config.storage, 'getProjectRoot').mockReturnValue(
    '/home/user/project',
  );
  return baseRender(tree, { ...options, config });
};

vi.mock('node:process', async () => {
  const actual =
    await vi.importActual<typeof import('node:process')>('node:process');
  return {
    ...actual,
    cwd: mockedCwd,
  };
});

vi.mock('../../utils/cleanup.js', () => ({
  gracefulExit: mockedGracefulExit,
}));

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, terminalHeight: mockedRows.current }),
}));

describe('FolderTrustDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedCwd.mockReturnValue('/home/user/project');
    mockedRows.current = 24;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render the dialog with title and current directory path', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <FolderTrustDialog onSelect={vi.fn()} />,
    );

    expect(lastFrame()).toContain('Do you trust the files in this folder?');
    expect(lastFrame()).toContain('/home/user/project');
    expect(lastFrame()).toContain(
      'Please confirm this is your own project or from a trusted source',
    );
    unmount();
  });

  it('shows the original project being trusted while cwd is a worktree', async () => {
    mockedCwd.mockReturnValue('/home/user/project/.qwen/worktrees/resumed');
    const { lastFrame, unmount } = await renderWithProviders(
      <FolderTrustDialog onSelect={vi.fn()} />,
    );

    expect(lastFrame()).toContain('/home/user/project');
    expect(lastFrame()).not.toContain('.qwen/worktrees/resumed');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('keeps constrained normal-buffer content in the static trust layout', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <FolderTrustDialog onSelect={vi.fn()} />,
      {
        width: 120,
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true, terminalHeight: 36 },
      },
    );

    expect(lastFrame()).toContain(
      'Please confirm this is your own project or from a trusted source',
    );
    expect(lastFrame()).toContain('/home/user/project');
    expect(lastFrame()).not.toContain(
      'Press Ctrl+O to view detailed transcript',
    );
    unmount();
  });

  it('retranslates without losing the raw path or discovery content', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'en' } },
        originalSettings: { ui: { language: 'en' } },
        readOnly: true,
      },
    });
    const result = await renderWithProviders(
      <FolderTrustDialog
        onSelect={vi.fn()}
        discoveryResults={{
          commands: ['raw-command'],
          mcps: [],
          hooks: [],
          skills: [],
          agents: [],
          settings: [],
          discoveryErrors: [],
          securityWarnings: [],
        }}
      />,
      { settings, width: 120 },
    );

    act(() => {
      settings.setValue(SettingScope.User, 'ui.language', 'zh-CN');
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).toContain('你信任此文件夹中的文件吗');
    expect(result.lastFrame()).toContain('/home/user/project');
    expect(result.lastFrame()).toContain('raw-command');
    result.unmount();
  });

  it('keeps discovery results in native scrollback in normal-buffer mode', async () => {
    const discoveryResults = {
      commands: Array.from({ length: 10 }, (_, i) => `cmd${i}`),
      mcps: Array.from({ length: 10 }, (_, i) => `mcp${i}`),
      hooks: Array.from({ length: 10 }, (_, i) => `hook${i}`),
      skills: Array.from({ length: 10 }, (_, i) => `skill${i}`),
      agents: [],
      settings: Array.from({ length: 10 }, (_, i) => `setting${i}`),
      discoveryErrors: [],
      securityWarnings: [],
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <FolderTrustDialog
        onSelect={vi.fn()}
        discoveryResults={discoveryResults}
      />,
      {
        width: 120,
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true, terminalHeight: 24 },
      },
    );

    expect(lastFrame()).toContain('Do you trust the files in this folder?');
    expect(lastFrame()).toContain('- cmd9');
    expect(lastFrame()).toContain('- setting9');
    expect(lastFrame()).not.toContain(
      'Press Ctrl+O to view detailed transcript',
    );
    unmount();
  });

  it('should display exit message and exit gracefully without calling onSelect when escape is pressed', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<FolderTrustDialog onSelect={onSelect} />);

    await act(async () => {
      stdin.write('\u001b[27u'); // Press kitty escape key
    });
    // Escape key has a 50ms timeout in KeypressContext, so we need to wrap waitUntilReady in act
    await act(async () => {
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'The current folder is not trusted. Exiting.',
      );
    });
    await waitFor(() => {
      expect(mockedGracefulExit).toHaveBeenCalledWith(
        ExitCodes.FATAL_CANCELLATION_ERROR,
        { exitReason: 'user_quit' },
      );
    });
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  describe('directory display', () => {
    it('should correctly display the folder name for a nested directory', async () => {
      mockedCwd.mockReturnValue('/home/user/project');
      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog onSelect={vi.fn()} />,
      );
      expect(lastFrame()).toContain('Trust folder');
      unmount();
    });

    it('should display discovery results when provided', async () => {
      mockedRows.current = 40; // Increase height to show all results
      const discoveryResults = {
        commands: ['cmd1', 'cmd2'],
        mcps: ['mcp1'],
        hooks: ['hook1'],
        skills: ['skill1'],
        agents: ['agent1'],
        settings: ['general', 'ui'],
        discoveryErrors: [],
        securityWarnings: [],
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog
          onSelect={vi.fn()}
          discoveryResults={discoveryResults}
        />,
        { width: 80 },
      );

      expect(lastFrame()).toContain('This folder contains:');
      expect(lastFrame()).toContain('• Commands (2):');
      expect(lastFrame()).toContain('- cmd1');
      expect(lastFrame()).toContain('- cmd2');
      expect(lastFrame()).toContain('• MCP Servers (1):');
      expect(lastFrame()).toContain('- mcp1');
      expect(lastFrame()).toContain('• Hooks (1):');
      expect(lastFrame()).toContain('- hook1');
      expect(lastFrame()).toContain('• Skills (1):');
      expect(lastFrame()).toContain('- skill1');
      expect(lastFrame()).toContain('• Agents (1):');
      expect(lastFrame()).toContain('- agent1');
      expect(lastFrame()).toContain('• Setting overrides (2):');
      expect(lastFrame()).toContain('- general');
      expect(lastFrame()).toContain('- ui');
      unmount();
    });

    it('should display security warnings when provided', async () => {
      const discoveryResults = {
        commands: [],
        mcps: [],
        hooks: [],
        skills: [],
        agents: [],
        settings: [],
        discoveryErrors: [],
        securityWarnings: ['Dangerous setting detected!'],
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog
          onSelect={vi.fn()}
          discoveryResults={discoveryResults}
        />,
      );

      expect(lastFrame()).toContain('Security Warnings:');
      expect(lastFrame()).toContain('Dangerous setting detected!');
      unmount();
    });

    it('should display discovery errors when provided', async () => {
      const discoveryResults = {
        commands: [],
        mcps: [],
        hooks: [],
        skills: [],
        agents: [],
        settings: [],
        discoveryErrors: ['Failed to load custom commands'],
        securityWarnings: [],
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog
          onSelect={vi.fn()}
          discoveryResults={discoveryResults}
        />,
      );

      expect(lastFrame()).toContain('Discovery Errors:');
      expect(lastFrame()).toContain('Failed to load custom commands');
      unmount();
    });

    it('should use scrolling instead of truncation when alternate buffer is enabled and expanded', async () => {
      const discoveryResults = {
        commands: Array.from({ length: 20 }, (_, i) => `cmd${i}`),
        mcps: [],
        hooks: [],
        skills: [],
        agents: [],
        settings: [],
        discoveryErrors: [],
        securityWarnings: [],
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog
          onSelect={vi.fn()}
          discoveryResults={discoveryResults}
        />,
        {
          width: 80,
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          uiState: { constrainHeight: false, terminalHeight: 15 },
        },
      );

      // In alternate buffer + expanded, the title should be visible (StickyHeader)
      expect(lastFrame()).toContain('Do you trust the files in this folder?');
      // And it should NOT use MaxSizedBox truncation
      expect(lastFrame()).not.toContain('hidden');
      unmount();
    });

    it('should strip ANSI codes from discovery results', async () => {
      const ansiRed = '\u001b[31m';
      const ansiReset = '\u001b[39m';

      const discoveryResults = {
        commands: [`${ansiRed}cmd-with-ansi${ansiReset}`],
        mcps: [`${ansiRed}mcp-with-ansi${ansiReset}`],
        hooks: [`${ansiRed}hook-with-ansi${ansiReset}`],
        skills: [`${ansiRed}skill-with-ansi${ansiReset}`],
        agents: [],
        settings: [`${ansiRed}setting-with-ansi${ansiReset}`],
        discoveryErrors: [`${ansiRed}error-with-ansi${ansiReset}`],
        securityWarnings: [`${ansiRed}warning-with-ansi${ansiReset}`],
      };

      const { lastFrame, unmount } = await renderWithProviders(
        <FolderTrustDialog
          onSelect={vi.fn()}
          discoveryResults={discoveryResults}
        />,
        { width: 100, uiState: { terminalHeight: 40 } },
      );

      const output = lastFrame();

      expect(output).toContain('cmd-with-ansi');
      expect(output).toContain('mcp-with-ansi');
      expect(output).toContain('hook-with-ansi');
      expect(output).toContain('skill-with-ansi');
      expect(output).toContain('setting-with-ansi');
      expect(output).toContain('error-with-ansi');
      expect(output).toContain('warning-with-ansi');

      unmount();
    });
  });
});
