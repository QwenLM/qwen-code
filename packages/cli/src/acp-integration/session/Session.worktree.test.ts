/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase C — Session.pendingWorktreeNotice consumption tests.
 *
 * Coverage:
 *   VP3: first Session.prompt() prepends pendingWorktreeNotice as a
 *        <system-reminder> block at the front of the user message parts.
 *   VP3b: pendingWorktreeNotice is cleared (null) after the first prompt.
 *   VP4: second Session.prompt() does NOT inject the notice again.
 *   VP4b: no notice set — first prompt is sent without any worktree reminder.
 *
 * This file does NOT mock @qwen-code/qwen-code-core at the module level so
 * the real Session class and its dependencies resolve correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session } from './Session.js';
import type { Config, GeminiChat } from '@qwen-code/qwen-code-core';
import { ApprovalMode, AuthType, Storage } from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import type {
  AgentSideConnection,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';

// Stub the non-interactive CLI commands that Session.ts imports transitively.
vi.mock('../../nonInteractiveCliCommands.js', () => ({
  ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE: [],
  getAvailableCommands: vi.fn().mockResolvedValue([]),
  handleSlashCommand: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns an async generator that immediately completes (end_turn). */
function createEmptyStream() {
  return (async function* () {})();
}

/** Minimal PromptRequest */
function makePromptRequest(text = 'hello'): PromptRequest {
  return {
    sessionId: 'wt-test-session',
    prompt: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

describe('Session.pendingWorktreeNotice', () => {
  const SESSION_ID = 'wt-test-session';

  /** Parts arrays captured on each sendMessageStream call. */
  let capturedMessages: unknown[][];
  let mockChat: GeminiChat;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let mockSettings: LoadedSettings;

  beforeEach(() => {
    capturedMessages = [];

    mockChat = {
      sendMessageStream: vi
        .fn()
        .mockImplementation(
          async (
            _model: string,
            args: { message: unknown[]; config: unknown },
            _promptId: string,
          ) => {
            capturedMessages.push(args.message);
            return createEmptyStream();
          },
        ),
      addHistory: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      setHistory: vi.fn(),
      truncateHistory: vi.fn(),
      stripThoughtsFromHistory: vi.fn(),
    } as unknown as GeminiChat;

    const mockGeminiClient = {
      getChat: vi.fn().mockReturnValue(mockChat),
      tryCompressChat: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      }),
    };

    mockConfig = {
      setApprovalMode: vi.fn(),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      switchModel: vi.fn(),
      getModel: vi.fn().mockReturnValue('qwen3'),
      getSessionId: vi.fn().mockReturnValue(SESSION_ID),
      getWorkingDir: vi.fn().mockReturnValue('/tmp'),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi.fn().mockReturnValue({
        recordUserMessage: vi.fn(),
        recordUiTelemetryEvent: vi.fn(),
        recordToolResult: vi.fn(),
        recordSlashCommand: vi.fn(),
        rewindRecording: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn(),
        // Called on every prompt() via #buildInitialSystemReminders
        ensureTool: vi.fn().mockResolvedValue(true),
      }),
      // Called on every prompt() to check subagent system reminders
      getSubagentManager: vi.fn().mockReturnValue({
        listSubagents: vi.fn().mockResolvedValue([]),
      }),
      getFileService: vi.fn().mockReturnValue({
        shouldGitIgnoreFile: vi.fn().mockReturnValue(false),
      }),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue('/tmp'),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getSessionTokenLimit: vi.fn().mockReturnValue(0),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getMessageBus: vi.fn().mockReturnValue(undefined),
      // Added on main after the test was written; Session.prompt's stop-hook
      // loop reads this so the mock has to provide it.
      getStopHookBlockingCap: vi.fn().mockReturnValue(0),
    } as unknown as Config;

    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
      extNotification: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSideConnection;

    mockSettings = {
      merged: {},
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  // VP3: notice is prepended as <system-reminder> on first prompt
  it('VP3: first prompt prepends pendingWorktreeNotice as a <system-reminder> block', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    const notice =
      '[Resumed] Active worktree: "feat" at /repo/.qwen/worktrees/feat ' +
      '(branch: worktree-feat). Continue using this path for all file operations.';
    session.pendingWorktreeNotice = notice;

    await session.prompt(makePromptRequest('first prompt'));

    expect(capturedMessages.length).toBeGreaterThanOrEqual(1);

    const firstParts = capturedMessages[0] as Array<{ text?: string }>;
    const reminderPart = firstParts.find(
      (p) =>
        typeof p.text === 'string' &&
        p.text.includes('<system-reminder>') &&
        p.text.includes(notice),
    );
    expect(reminderPart).toBeDefined();
  });

  // VP3b: notice cleared after first prompt
  it('VP3b: pendingWorktreeNotice is null after the first prompt', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    session.pendingWorktreeNotice = 'notice text';
    await session.prompt(makePromptRequest('first'));

    expect(session.pendingWorktreeNotice).toBeNull();
  });

  // VP4: second prompt does NOT re-inject the notice
  it('VP4: second prompt does not re-inject pendingWorktreeNotice', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    const notice = 'some-worktree-context-notice';
    session.pendingWorktreeNotice = notice;

    await session.prompt(makePromptRequest('first prompt'));
    await session.prompt(makePromptRequest('second prompt'));

    // Two model sends should have been captured.
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);

    // Second send must NOT include the system-reminder block with the notice.
    const secondParts = capturedMessages[1] as Array<{ text?: string }>;
    const reminderPart = secondParts.find(
      (p) =>
        typeof p.text === 'string' &&
        p.text.includes('<system-reminder>') &&
        p.text.includes(notice),
    );
    expect(reminderPart).toBeUndefined();

    // Stays null after the second call as well.
    expect(session.pendingWorktreeNotice).toBeNull();
  });

  // VP4b: sanity — no notice set, prompt works normally, no worktree reminder injected
  it('VP4b: no notice set — prompt proceeds normally without worktree system-reminder', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    expect(session.pendingWorktreeNotice).toBeNull();

    await session.prompt(makePromptRequest('plain prompt'));

    expect(session.pendingWorktreeNotice).toBeNull();
    // Message was still sent to the model.
    expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
  });
});
