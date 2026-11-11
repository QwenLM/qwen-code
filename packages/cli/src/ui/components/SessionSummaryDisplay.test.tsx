/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionSummaryDisplay } from './SessionSummaryDisplay.js';
import * as SessionContext from '../contexts/SessionContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { type SessionMetrics } from '../contexts/SessionContext.js';
import {
  ToolCallDecision,
  getShellConfiguration,
  createUserMessage,
  createSystemMessage,
  type Message,
  type PermissionMode,
  type WorktreeSettings,
} from '@qwen-code/core';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getShellConfiguration: vi.fn(),
    ownsWorktreeLifecycle: (settings: WorktreeSettings) =>
      settings.lifecycle === 'owner',
  };
});

vi.mock('../contexts/SessionContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/SessionContext.js')>();
  return {
    ...actual,
    useSessionStats: vi.fn(),
  };
});

vi.mock('../contexts/ConfigContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ConfigContext.js')>();
  return {
    ...actual,
    useConfig: vi.fn(),
  };
});

const getShellConfigurationMock = vi.mocked(getShellConfiguration);
const useSessionStatsMock = vi.mocked(SessionContext.useSessionStats);

const renderWithMockedStats = async (
  metrics: SessionMetrics,
  sessionId = 'test-session',
  worktreeSettings?: WorktreeSettings,
  permissionMode: PermissionMode = 'default',
  sessionBaseMode?: PermissionMode,
  {
    messages = [createUserMessage('Hello')],
    promptCount = 5,
  }: { messages?: readonly Message[]; promptCount?: number } = {},
) => {
  useSessionStatsMock.mockReturnValue({
    stats: {
      sessionId,
      sessionStartTime: new Date(),
      metrics,
      lastPromptTokenCount: 0,
      promptCount,
    },

    getPromptCount: () => promptCount,
    startNewPrompt: vi.fn(),
  } as unknown as ReturnType<typeof SessionContext.useSessionStats>);

  vi.mocked(useConfig).mockReturnValue({
    getWorktreeSettings: () => worktreeSettings,
    getPermissionMode: () => permissionMode,
    getConversationMessages: () => messages,
    toolPermissionContext:
      sessionBaseMode === undefined ? undefined : { sessionBaseMode },
  } as never);

  const result = await renderWithProviders(
    <SessionSummaryDisplay duration="1h 23m 45s" />,
    {
      width: 100,
    },
  );
  await result.waitUntilReady();
  return result;
};

describe('<SessionSummaryDisplay />', () => {
  const emptyMetrics: SessionMetrics = {
    models: {},
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      totalDecisions: {
        accept: 0,
        reject: 0,
        modify: 0,
        [ToolCallDecision.AUTO_ACCEPT]: 0,
      },
      byName: {},
    },
    files: {
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    },
  };

  beforeEach(() => {
    getShellConfigurationMock.mockReturnValue({
      executable: 'bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    });
  });

  it('renders the summary display with a title', async () => {
    const metrics: SessionMetrics = {
      ...emptyMetrics,
      models: {
        'gemini-2.5-pro': {
          api: { totalRequests: 10, totalErrors: 1, totalLatencyMs: 50234 },
          tokens: {
            input: 500,
            prompt: 1000,
            candidates: 2000,
            total: 3500,
            cached: 500,
            thoughts: 300,
            tool: 200,
          },
          roles: {},
        },
      },
      files: {
        totalLinesAdded: 42,
        totalLinesRemoved: 15,
      },
    };

    const { lastFrame, unmount } = await renderWithMockedStats(metrics);
    const output = lastFrame();

    expect(output).toContain('Agent powering down. Goodbye!');
    expect(output).toMatchSnapshot();
    unmount();
  });

  describe('Empty sessions', () => {
    it('omits the resume hint when exiting a fresh session without messages', async () => {
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'empty-session',
        undefined,
        'default',
        undefined,
        { messages: [], promptCount: 0 },
      );

      expect(lastFrame()).toContain('Agent powering down. Goodbye!');
      expect(lastFrame()).not.toContain('To resume');
      expect(lastFrame()).not.toContain('--resume');
      unmount();
    });

    it('omits the new session resume hint after /clear removes existing messages', async () => {
      const messages: Message[] = [createUserMessage('Previous conversation')];
      const previous = await renderWithMockedStats(
        emptyMetrics,
        'previous-session',
        undefined,
        'default',
        undefined,
        { messages },
      );
      expect(previous.lastFrame()).toContain('--resume previous-session');
      previous.unmount();

      // /clear replaces the current history and publishes a fresh session ID.
      messages.length = 0;
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'cleared-session',
        undefined,
        'default',
        undefined,
        { messages, promptCount: 0 },
      );

      expect(lastFrame()).toContain('Agent powering down. Goodbye!');
      expect(lastFrame()).not.toContain('--resume');
      unmount();
    });

    it('does not treat local command and system messages as resumable history', async () => {
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'local-only-session',
        undefined,
        'default',
        undefined,
        {
          messages: [
            createSystemMessage('informational', 'Session initialized'),
            createUserMessage('<command-name>/quit</command-name>'),
          ],
        },
      );

      expect(lastFrame()).not.toContain('--resume');
      unmount();
    });

    it('keeps the resume hint for restored history without new prompts', async () => {
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'restored-session',
        undefined,
        'default',
        undefined,
        { messages: [createUserMessage('Saved conversation')], promptCount: 0 },
      );

      expect(lastFrame()).toContain('--resume restored-session');
      unmount();
    });

    it('keeps worktree cleanup instructions without an empty-session resume hint', async () => {
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'empty-worktree-session',
        {
          name: 'foo-bar',
          path: '/path/to/foo-bar',
          worktreeCwd: '/path/to/foo-bar',
          baseSha: 'base-sha',
          lifecycle: 'owner',
        },
        'default',
        undefined,
        { messages: [], promptCount: 0 },
      );

      expect(lastFrame()).not.toContain('To resume');
      expect(lastFrame()).not.toContain('--resume');
      expect(lastFrame()).toContain(
        'To remove manually: git worktree remove /path/to/foo-bar',
      );
      unmount();
    });
  });

  describe('Session ID escaping', () => {
    it.each(['bash', 'powershell', 'cmd'] as const)(
      'renders an unquoted UUID in the footer regardless of the tool shell (%s)',
      async (shell) => {
        getShellConfigurationMock.mockReturnValue({
          executable: shell,
          argsPrefix: [],
          shell,
        });

        const uuidSessionId = '12345678-abcd-1234-abcd-123456789abc';
        const { lastFrame, unmount } = await renderWithMockedStats(
          emptyMetrics,
          uuidSessionId,
        );

        expect(lastFrame()).toContain(`qwen --resume ${uuidSessionId}`);
        unmount();
      },
    );

    it('sanitizes a malicious session ID in the footer (bash)', async () => {
      const maliciousSessionId = "'; rm -rf / #";
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        maliciousSessionId,
      );
      const output = lastFrame();

      // escapeShellArg (using shell-quote for bash) will wrap special characters in double quotes.
      expect(output).toContain('qwen --resume "\'; rm -rf / #"');
      unmount();
    });

    it('sanitizes a malicious session ID in the footer (powershell)', async () => {
      getShellConfigurationMock.mockReturnValue({
        executable: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-Command'],
        shell: 'powershell',
      });

      const maliciousSessionId = "'; rm -rf / #";
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        maliciousSessionId,
      );
      const output = lastFrame();

      // PowerShell wraps in single quotes and escapes internal single quotes by doubling them
      expect(output).toContain("qwen --resume '''; rm -rf / #'");
      unmount();
    });

    it('omits --yolo when the session started in bypassPermissions mode but exits in default', async () => {
      const uuidSessionId = '1234-abcd-5678-efgh';
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        uuidSessionId,
        undefined,
        'default',
        'yolo',
      );
      const output = lastFrame();

      expect(output).toContain('qwen --resume 1234-abcd-5678-efgh');
      expect(output).not.toContain(
        'qwen --resume 1234-abcd-5678-efgh --yolo',
      );
      unmount();
    });

    it('falls back to current bypassPermissions mode when the session base mode is unavailable', async () => {
      const uuidSessionId = '1234-abcd-5678-efgh';
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        uuidSessionId,
        undefined,
        'yolo',
      );
      const output = lastFrame();

      expect(output).toContain(
        'qwen --resume 1234-abcd-5678-efgh --yolo',
      );
      unmount();
    });

    it('includes --yolo when the session switches to bypassPermissions before exit', async () => {
      const uuidSessionId = '1234-abcd-5678-efgh';
      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        uuidSessionId,
        undefined,
        'yolo',
        'default',
      );
      const output = lastFrame();

      expect(output).toContain(
        'qwen --resume 1234-abcd-5678-efgh --yolo',
      );
      unmount();
    });
  });

  describe('Worktree status', () => {
    it('renders worktree instructions when worktreeSettings are present', async () => {
      const worktreeSettings: WorktreeSettings = {
        name: 'foo-bar',
        path: '/path/to/foo-bar',
        worktreeCwd: '/path/to/foo-bar/apps/desktop',
        originalCwd: '/path/to/project/apps/desktop',
        baseSha: 'base-sha',
        lifecycle: 'owner',
      };

      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'test-session',
        worktreeSettings,
      );
      const output = lastFrame();

      expect(output).toContain('To resume work in this worktree:');
      expect(output).toContain('cd /path/to/project/apps/desktop');
      expect(output).toContain('qwen --resume');
      expect(output).toContain('test-session');
      expect(output).toContain(
        'To remove manually: git worktree remove /path/to/foo-bar',
      );
      unmount();
    });

    it('includes --yolo in worktree resume instructions for bypassPermissions sessions', async () => {
      const worktreeSettings: WorktreeSettings = {
        name: 'foo-bar',
        path: '/path/to/foo-bar',
        worktreeCwd: '/path/to/foo-bar/apps/desktop',
        originalCwd: '/path/to/project/apps/desktop',
        baseSha: 'base-sha',
        lifecycle: 'owner',
      };

      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'test-session',
        worktreeSettings,
        'yolo',
      );
      const output = lastFrame();

      expect(output).toContain('cd /path/to/project/apps/desktop');
      expect(output.replace(/\s+/g, ' ')).toContain('test-session --yolo');
      unmount();
    });

    it('does not suggest managing an attached worktree', async () => {
      const worktreeSettings: WorktreeSettings = {
        name: 'foo-bar',
        path: '/path/to/foo-bar',
        worktreeCwd: '/path/to/foo-bar',
        baseSha: 'base-sha',
        lifecycle: 'attached',
      };

      const { lastFrame, unmount } = await renderWithMockedStats(
        emptyMetrics,
        'test-session',
        worktreeSettings,
      );
      const output = lastFrame();

      expect(output).toContain('To resume this session:');
      expect(output).not.toContain('To remove manually:');
      unmount();
    });
  });
});
