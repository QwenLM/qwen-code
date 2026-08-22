/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scheduler-level integration tests for `ask_user_question` (issue #9011).
 *
 * The unit-level story ("did the invocation keep the cancel reason?") cannot
 * answer the reported symptom, because the symptom is about *what the model
 * receives* after the confirmation pipeline has had its say. These tests drive
 * the real tool through a real `CoreToolScheduler` and assert on the
 * `functionResponse` the model actually gets on each path.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AnyDeclarativeTool, Config, ToolRegistry } from '../index.js';
import { ApprovalMode, ToolConfirmationOutcome } from '../index.js';
import type { ToolCall, WaitingToolCall } from '../core/coreToolScheduler.js';
import { CoreToolScheduler } from '../core/coreToolScheduler.js';
import { AskUserQuestionTool } from './askUserQuestion.js';
import { ToolNames } from './tool-names.js';

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

/** Counts execute() calls without altering the invocation's behaviour. */
class CountingAskUserQuestionTool extends AskUserQuestionTool {
  executeCalls = 0;
  override build(params: never) {
    const invocation = super.build(params);
    const original = invocation.execute.bind(invocation);
    invocation.execute = async (...args: Parameters<typeof original>) => {
      this.executeCalls++;
      return original(...args);
    };
    return invocation;
  }
}

function makeHarness(opts: {
  /** What the PermissionManager resolves the call to (L4). */
  pmDecision: 'allow' | 'ask';
  /** Whether a host capable of rendering the question form is present. */
  interactive: boolean;
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
    getInputFormat: () => undefined,
    getExperimentalZedIntegration: () => false,
  } as unknown as Config;

  const tool = new CountingAskUserQuestionTool(config);
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

  const seenCalls = () =>
    onToolCallsUpdate.mock.calls.flatMap((c) => c[0] as ToolCall[]);

  return {
    scheduler,
    tool,
    onAllToolCallsComplete,
    seenStatuses: () => seenCalls().map((c) => c.status),
    waitingCall: () =>
      seenCalls().find((c) => c.status === 'awaiting_approval') as
        | WaitingToolCall
        | undefined,
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
  it('still renders the form when a permission rule resolves the call to allow (#9011)', async () => {
    const h = makeHarness({ pmDecision: 'allow', interactive: true });

    await h.scheduler.schedule([REQUEST], new AbortController().signal);
    await vi.waitFor(() => expect(h.waitingCall()).toBeDefined());

    // Without `requiresUserInteraction()`, the L4 allow branch sends the call
    // straight to `scheduled`: the form is never shown and the model is told
    // the user declined a question it never saw.
    expect(h.seenStatuses()).toContain('awaiting_approval');
    expect(h.tool.executeCalls).toBe(0);
  });

  it('surfaces the pipeline cancel reason to the model instead of a fake decline', async () => {
    const h = makeHarness({ pmDecision: 'ask', interactive: true });

    await h.scheduler.schedule([REQUEST], new AbortController().signal);
    await vi.waitFor(() => expect(h.waitingCall()).toBeDefined());
    await h
      .waitingCall()!
      .confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel, {
        cancelMessage: 'The host could not present the approval surface.',
      });
    await vi.waitFor(() => expect(h.onAllToolCallsComplete).toHaveBeenCalled());

    expect(h.modelVisible()).toBe(
      '[Operation Cancelled] Reason: The host could not present the approval surface.',
    );
    // The reason is surfaced at the scheduler boundary; the tool's execute()
    // is never reached on this path, so the tool cannot be where it is fixed.
    expect(h.tool.executeCalls).toBe(0);
  });

  it('pins the remaining gap: a bare Cancel still reaches the model as generic text', async () => {
    const h = makeHarness({ pmDecision: 'ask', interactive: true });

    await h.scheduler.schedule([REQUEST], new AbortController().signal);
    await vi.waitFor(() => expect(h.waitingCall()).toBeDefined());
    // Shape of the headless teammate-approval fallback, which today responds
    // Cancel with no payload: the reason it printed to stderr never reaches
    // the model. Fixing that belongs at the producer, not in this tool.
    await h
      .waitingCall()!
      .confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel);
    await vi.waitFor(() => expect(h.onAllToolCallsComplete).toHaveBeenCalled());

    expect(h.modelVisible()).toBe(
      '[Operation Cancelled] Reason: User did not allow tool call',
    );
    expect(h.tool.executeCalls).toBe(0);
  });

  it('keeps its own actionable message where no host can present the form', async () => {
    const h = makeHarness({ pmDecision: 'allow', interactive: false });

    await h.scheduler.schedule([REQUEST], new AbortController().signal);
    await vi.waitFor(() => expect(h.onAllToolCallsComplete).toHaveBeenCalled());

    // `requiresUserInteraction()` must stay false here: forcing a confirmation
    // round would replace this with the generic non-interactive denial.
    expect(h.modelVisible()).toBe(
      'Cannot ask user questions in non-interactive mode without ACP support. ' +
        'Please run in interactive mode or enable ACP mode to use this tool.',
    );
    expect(h.seenStatuses()).not.toContain('awaiting_approval');
  });
});
