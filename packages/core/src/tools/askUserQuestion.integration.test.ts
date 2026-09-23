/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scheduler-level integration test for `ask_user_question`.
 *
 * The unit test can only ask "does the predicate return false?". It cannot
 * show what that costs, because the cost is a turn that never ends: with the
 * predicate true, `evaluatePermissionFlow` rewrites the decision to `ask`, the
 * call parks in `awaiting_approval`, and in stream-json direct mode there is
 * no control system to answer it. This drives the real tool through a real
 * `CoreToolScheduler` and asserts the call never parks.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AnyDeclarativeTool, Config, ToolRegistry } from '../index.js';
import { ApprovalMode } from '../index.js';
import type { ToolCall } from '../core/coreToolScheduler.js';
import { CoreToolScheduler } from '../core/coreToolScheduler.js';
import { AskUserQuestionTool } from './askUserQuestion.js';
import { ToolNames } from './tool-names.js';
import { InputFormat } from '../output/types.js';

const REQUEST = {
  callId: 'ask-user-question-call',
  name: ToolNames.ASK_USER_QUESTION,
  args: {
    questions: [
      {
        question: 'Which database should I use?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'postgres', description: 'relational' },
          { label: 'sqlite', description: 'embedded' },
        ],
      },
    ],
  },
  isClientInitiated: false,
  prompt_id: 'ask-user-question-prompt',
};

function makeHarness(opts: {
  /** What the PermissionManager resolves the call to (L4). */
  pmDecision: 'allow' | 'ask';
  interactive: boolean;
  /** ACP modality under test: `undefined` = plain text stdin. */
  inputFormat?: InputFormat;
  /**
   * Whether the SDK control system was initialized. Only true after a
   * `control_request: initialize`, i.e. never in stream-json direct mode --
   * which is exactly the session with no responder for a confirmation round.
   */
  sdkMode?: boolean;
}) {
  const permissionManager = {
    isToolEnabled: () => true,
    findMatchingDenyRule: () => undefined,
    hasRelevantRules: () => true,
    evaluate: async () => opts.pmDecision,
    hasMatchingAskRule: () => opts.pmDecision === 'ask',
  };

  const config = {
    getSessionId: () => 'ask-user-question-session',
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getApprovalMode: () => ApprovalMode.DEFAULT,
    setApprovalMode: vi.fn(),
    getPermissionsAllow: () => [],
    getPermissionsDeny: () => undefined,
    getPermissionManager: () => permissionManager,
    getTargetDir: () => '/repo',
    getContentGeneratorConfig: () => ({
      model: 'test-model',
      authType: 'gemini',
    }),
    getEffectiveInputModalities: () => ({ image: true }),
    getDefaultVisionBridgeModel: () => undefined,
    getModel: () => 'test-model',
    getShellExecutionConfig: () => ({ terminalWidth: 90, terminalHeight: 30 }),
    storage: {
      getProjectTempDir: () => '/tmp',
      getToolResultsDir: () => '/tmp/tool-results',
    },
    getToolResultBytesWritten: () => 0,
    trackToolResultBytes: vi.fn(),
    getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
    getTruncateToolOutputLines: () => Number.POSITIVE_INFINITY,
    getToolOutputBatchBudget: () => Number.POSITIVE_INFINITY,
    getCwd: () => '/repo',
    getUseModelRouter: () => false,
    getGeminiClient: () => null,
    getPlanFilePath: () => '/tmp/plans/ask-user-question.md',
    getChatRecordingService: () => undefined,
    getMemoryPressureMonitor: () => undefined,
    getMessageBus: vi.fn().mockReturnValue(undefined),
    hasHooksForEvent: vi.fn(() => false),
    getHookSystem: vi.fn().mockReturnValue(undefined),
    getDisableAllHooks: vi.fn(() => true),
    getAutoModeDenialState: () => ({
      consecutiveBlock: 0,
      consecutiveUnavailable: 0,
      totalBlock: 0,
      totalUnavailable: 0,
    }),
    setAutoModeDenialState: vi.fn(),
    getAutoModeSettings: () => ({}),
    getWorkspaceContext: () => ({ isPathWithinWorkspace: () => false }),
    isInteractive: () => opts.interactive,
    getInputFormat: () => opts.inputFormat,
    getExperimentalZedIntegration: () => false,
    getSdkMode: () => opts.sdkMode ?? false,
  } as unknown as Config;

  const tool = new AskUserQuestionTool(config);
  const toolsByName = new Map<string, AnyDeclarativeTool>([
    [ToolNames.ASK_USER_QUESTION, tool],
  ]);
  (
    config as unknown as { getToolRegistry: () => ToolRegistry }
  ).getToolRegistry = () =>
    ({
      getTool: (n: string) => toolsByName.get(n),
      ensureTool: vi.fn(async (n: string) => toolsByName.get(n)),
      getFunctionDeclarations: () => [],
      tools: toolsByName,
      registerTool: () => {},
      getToolByName: (n: string) => toolsByName.get(n),
      getToolByDisplayName: () => undefined,
      getTools: () => [...toolsByName.values()],
      discoverTools: async () => {},
      getAllTools: () => [...toolsByName.values()],
      getToolsByServer: () => [],
      getAllToolNames: () => [...toolsByName.keys()],
    }) as unknown as ToolRegistry;

  const onAllToolCallsComplete = vi.fn();
  const onToolCallsUpdate = vi.fn();
  const scheduler = new CoreToolScheduler({
    config,
    onAllToolCallsComplete,
    onToolCallsUpdate,
    getPreferredEditor: () => 'vscode',
    onEditorClose: vi.fn(),
  });

  return {
    scheduler,
    onAllToolCallsComplete,
    seenStatuses: () =>
      onToolCallsUpdate.mock.calls
        .flatMap((c) => c[0] as ToolCall[])
        .map((c) => c.status),
    modelVisible: () => {
      const completed = onAllToolCallsComplete.mock.calls[0]?.[0]?.[0] as {
        response: {
          responseParts: Array<{
            functionResponse?: { response?: Record<string, unknown> };
          }>;
        };
      };
      const response =
        completed.response.responseParts[0]?.functionResponse?.response;
      return String(response?.['error'] ?? response?.['output'] ?? '');
    },
  };
}

describe('ask_user_question through CoreToolScheduler', () => {
  it('does not park a stream-json direct-mode turn that has no responder', async () => {
    // Direct mode (first stdin frame is a plain user message): the control
    // system is never built, so nothing would ever answer `awaiting_approval`
    // and the process could not exit. The scheduler's non-interactive
    // auto-deny does not cover it either -- `isNonInteractiveDeny` carries
    // `getInputFormat() !== STREAM_JSON` as a required conjunct.
    const h = makeHarness({
      pmDecision: 'allow',
      interactive: false,
      inputFormat: InputFormat.STREAM_JSON,
      sdkMode: false,
    });

    await h.scheduler.schedule([REQUEST], new AbortController().signal);
    await vi.waitFor(() => expect(h.onAllToolCallsComplete).toHaveBeenCalled());

    expect(h.seenStatuses()).not.toContain('awaiting_approval');
    expect(h.modelVisible()).toBe(
      'Cannot ask user questions in non-interactive mode without ACP support. ' +
        'Please run in interactive mode or enable ACP mode to use this tool.',
    );
  });
});
