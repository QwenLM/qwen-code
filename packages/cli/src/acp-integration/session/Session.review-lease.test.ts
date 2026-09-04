/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * ACP prompt turns and the /review worktree lease.
 *
 * Coverage:
 *   RL1: the turn body runs inside promptIdContext, so shell subprocesses
 *        (via getShellContextEnvVars) see QWEN_CODE_PROMPT_ID and
 *        `qwen review fetch-pr` can record its worktree lease.
 *   RL2: a completed prompt sweeps this prompt's review-worktree leases
 *        (no-op when the review's own cleanup step already cleared them).
 *   RL3: the sweep still runs when the model stream throws — the
 *        interrupted-/review case the lease mechanism exists for.
 *   RL4: consecutive prompts sweep under their own prompt IDs.
 *
 * Mirrors the harness in Session.worktree.test.ts: real Session, no
 * module-level mock of @qwen-code/qwen-code-core.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session } from './Session.js';
import type { Config, LlmChat } from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  AuthType,
  GoalPersistenceUnavailableError,
  Storage,
  promptIdContext,
} from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import type {
  AgentSideConnection,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('../../nonInteractiveCliCommands.js', () => ({
  ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE: [],
  getAvailableCommands: vi.fn().mockResolvedValue([]),
  handleSlashCommand: vi.fn(),
}));

const cleanupReviewWorktreeLeases = vi.hoisted(() => vi.fn());
vi.mock('../../services/review-worktree-lease.js', () => ({
  cleanupReviewWorktreeLeases,
}));

function createEmptyStream() {
  return (async function* () {})();
}

function makePromptRequest(text = 'hello'): PromptRequest {
  return {
    sessionId: 'lease-test-session',
    prompt: [{ type: 'text', text }],
  };
}

describe('Session review-worktree lease sweep', () => {
  const SESSION_ID = 'lease-test-session';
  const PROJECT_ROOT = '/repo';

  /** promptIdContext store observed inside each model send. */
  let observedPromptIds: Array<string | undefined>;
  let mockChat: LlmChat;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let mockSettings: LoadedSettings;

  beforeEach(() => {
    cleanupReviewWorktreeLeases.mockClear();
    observedPromptIds = [];

    mockChat = {
      sendMessageStream: vi.fn().mockImplementation(async () => {
        observedPromptIds.push(promptIdContext.getStore());
        return createEmptyStream();
      }),
      addHistory: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      setHistory: vi.fn(),
      truncateHistory: vi.fn(),
      stripThoughtsFromHistory: vi.fn(),
    } as unknown as LlmChat;

    const mockLlmClient = {
      getChat: vi.fn().mockReturnValue(mockChat),
      tryCompressChat: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      }),
      beginManagedAutoMemoryRecall: vi.fn(),
      consumeManagedAutoMemoryRecall: vi.fn().mockResolvedValue(null),
      finishManagedAutoMemoryRecall: vi.fn(),
      recordCompletedToolCall: vi.fn(),
    };

    mockConfig = {
      storage: {
        getRuntimeBaseDir: vi.fn(() => Storage.getRuntimeBaseDir()),
      },
      setApprovalMode: vi.fn(),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      switchModel: vi.fn(),
      getModel: vi.fn().mockReturnValue('qwen3'),
      getSessionId: vi.fn().mockReturnValue(SESSION_ID),
      takeActiveTodoReminder: vi.fn().mockReturnValue(undefined),
      getActiveTodoWorkChainOwner: vi.fn((promptId: string) => promptId),
      setActiveTodoReminder: vi.fn(),
      startActiveTodoWorkChain: vi.fn(),
      startAutomaticActiveTodoWorkChain: vi.fn(),
      endAutomaticActiveTodoWorkChain: vi.fn(),
      assertCanStartTurn: vi.fn().mockResolvedValue(undefined),
      getWorkingDir: vi.fn().mockReturnValue('/tmp'),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi.fn().mockReturnValue({
        getBranchCheckpointCursor: vi.fn().mockReturnValue({
          recordId: null,
          activeRecordCount: 0,
          pendingToolCalls: [],
        }),
        recordBranchCheckpointTransaction: vi.fn().mockResolvedValue(undefined),
        recordUserMessage: vi.fn(),
        recordUiTelemetryEvent: vi.fn(),
        recordToolResult: vi.fn(),
        recordSlashCommand: vi.fn(),
        rewindRecording: vi.fn(),
        setTitleRecordedCallback: vi.fn(),
      }),
      getSessionService: vi.fn().mockReturnValue({
        setSessionPrBoundCallback: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn(),
        ensureTool: vi.fn().mockResolvedValue(true),
      }),
      getFileService: vi.fn().mockReturnValue({
        shouldGitIgnoreFile: vi.fn().mockReturnValue(false),
      }),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue('/tmp'),
      getProjectRoot: vi.fn().mockReturnValue(PROJECT_ROOT),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockReturnValue(AuthType.USE_OPENAI),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getSessionTokenLimit: vi.fn().mockReturnValue(0),
      getLlmClient: vi.fn().mockReturnValue(mockLlmClient),
      getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(false),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getStopHookBlockingCap: vi.fn().mockReturnValue(0),
      getBackgroundTaskRegistry: vi.fn().mockReturnValue({
        setNotificationCallback: vi.fn(),
        setStatusChangeCallback: vi.fn(),
        clearStatusChangeCallback: vi.fn(),
        listUnfinalizedBackgroundAgentIds: vi.fn().mockReturnValue([]),
      }),
      getMonitorRegistry: vi.fn().mockReturnValue({
        setNotificationCallback: vi.fn(),
      }),
      getBackgroundShellRegistry: vi.fn().mockReturnValue({
        setNotificationCallback: vi.fn(),
        setStatusChangeCallback: vi.fn(),
        clearStatusChangeCallback: vi.fn(),
        hasRunningEntries: vi.fn().mockReturnValue(false),
      }),
      getWorkflowRunRegistry: vi.fn().mockReturnValue({
        setStatusChangeCallback: vi.fn(),
        clearStatusChangeCallback: vi.fn(),
        setCompletionCallback: vi.fn(),
        setSnapshotPersistedCallback: vi.fn(),
        setApprovalRequestCallback: vi.fn(),
      }),
      setSubSessionSpawner: vi.fn(),
      getSubSessionSpawner: vi.fn(),
      // The Session constructor and Session.prompt both reach for the
      // canonical Goal runtime. A real Config throws this exact error when
      // Goal persistence is off, and both call sites are written to fall
      // through on it — which is the shape these lease-sweep tests want.
      getGoalRuntime: vi.fn(() => {
        throw new GoalPersistenceUnavailableError();
      }),
      getGoalRuntimeReady: vi
        .fn()
        .mockRejectedValue(new GoalPersistenceUnavailableError()),
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

  it('RL1: the turn body observes this prompt in promptIdContext', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    await session.prompt(makePromptRequest());

    expect(observedPromptIds).toEqual([`${SESSION_ID}########1`]);
  });

  it('RL2: a completed prompt sweeps its review-worktree leases', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    await session.prompt(makePromptRequest());

    expect(cleanupReviewWorktreeLeases).toHaveBeenCalledTimes(1);
    expect(cleanupReviewWorktreeLeases).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      promptId: `${SESSION_ID}########1`,
      repositoryRoot: PROJECT_ROOT,
    });
  });

  it('RL3: the sweep still runs when the model stream throws', async () => {
    (
      mockChat.sendMessageStream as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('stream exploded'));
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    await session.prompt(makePromptRequest()).catch(() => {});

    expect(cleanupReviewWorktreeLeases).toHaveBeenCalledTimes(1);
    expect(cleanupReviewWorktreeLeases).toHaveBeenCalledWith(
      expect.objectContaining({ promptId: `${SESSION_ID}########1` }),
    );
  });

  it('RL4: consecutive prompts sweep under their own prompt IDs', async () => {
    const session = new Session(
      SESSION_ID,
      mockConfig,
      mockClient,
      mockSettings,
    );

    await session.prompt(makePromptRequest('first'));
    await session.prompt(makePromptRequest('second'));

    expect(cleanupReviewWorktreeLeases).toHaveBeenCalledTimes(2);
    expect(cleanupReviewWorktreeLeases).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ promptId: `${SESSION_ID}########1` }),
    );
    expect(cleanupReviewWorktreeLeases).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ promptId: `${SESSION_ID}########2` }),
    );
  });
});
