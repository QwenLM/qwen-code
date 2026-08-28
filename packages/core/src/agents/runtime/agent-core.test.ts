/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FunctionDeclaration, GenerateContentConfig } from '@google/genai';
import {
  AgentCore,
  extractParentToolNames,
  type ReasoningLoopResult,
} from './agent-core.js';
import { attachJsonlTranscriptWriter } from '../agent-transcript.js';
import {
  getCurrentAgentDeclaredToolNames,
  getCurrentAgentDepth,
  getCurrentAgentId,
  getRuntimeContentGenerator,
  recordCurrentAgentDeclaredToolNames,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import {
  subagentIdentityContext,
  subagentNameContext,
} from '../../utils/subagentNameContext.js';
import { runInForkContext } from '../../tools/agent/fork-subagent.js';
import { ToolNames } from '../../tools/tool-names.js';
import {
  getAgentName,
  getTeammateContext,
  isTeammate,
  runWithTeammateIdentity,
} from '../team/identity.js';
import type { TeammateIdentity } from '../team/types.js';
import type { Config } from '../../config/config.js';
import type {
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../../core/contentGenerator.js';
import {
  getInvocationContext,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../../utils/invocation-context.js';
import { LlmChat } from '../../core/llm-chat.js';
import { ContextState } from './agent-headless.js';
import type { ToolResultBoundaryObservation } from '../../tools/tool-result-boundary-diagnostics.js';
import {
  CoreToolScheduler,
  type ToolCall,
  type WaitingToolCall,
} from '../../core/coreToolScheduler.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import {
  AgentEventType,
  type AgentApprovalRequestEvent,
} from './agent-events.js';

const boundaryObserveMock = vi.hoisted(() =>
  vi.fn((_observation: ToolResultBoundaryObservation) => false),
);
vi.mock(
  '../../tools/tool-result-boundary-diagnostics.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../tools/tool-result-boundary-diagnostics.js')
    >()),
    observeToolResultBoundary: boundaryObserveMock,
  }),
);

describe('AgentCore.createChat manual plan-exit notice ownership', () => {
  it('enables notices only for interactive agent chats', async () => {
    const core = new AgentCore(
      'notice-agent',
      {} as Config,
      { renderedSystemPrompt: 'system', initialMessages: [] },
      { model: 'test-model' },
      { max_turns: 1 },
    );
    const enableSpy = vi.spyOn(
      LlmChat.prototype,
      'enableManualPlanExitNotices',
    );

    const interactiveChat = await core.createChat(new ContextState(), {
      interactive: true,
    });
    expect(interactiveChat).toBeDefined();
    expect(enableSpy).toHaveBeenCalledTimes(1);

    const headlessChat = await core.createChat(new ContextState());
    expect(headlessChat).toBeDefined();
    expect(enableSpy).toHaveBeenCalledTimes(1);

    enableSpy.mockRestore();
  });
});

describe('AgentCore.runInAgentFrames', () => {
  // The deferred-approval `respond` callback that AgentCore hands to the
  // UI must restore both ALS frames the agent normally runs under, so any
  // tool body resumed via approval — including ones that trigger LLM
  // calls — sees the agent's ContentGenerator (modalities, auth) and is
  // attributed to the agent in token stats.
  //
  // The reasoning loop uses the same wrap, so anything that breaks here
  // also breaks the synchronous path. These tests pin the contract.

  function makeCore(
    name: string,
    runtimeView?: RuntimeContentGeneratorView,
    taskName?: string,
    subagentId?: string,
  ) {
    const promptConfig: PromptConfig = { systemPrompt: '' };
    const modelConfig: ModelConfig = { model: 'test-model' };
    const runConfig: RunConfig = { max_turns: 1 };
    return new AgentCore(
      name,
      {} as unknown as Config,
      promptConfig,
      modelConfig,
      runConfig,
      undefined,
      undefined,
      undefined,
      runtimeView,
      taskName,
      subagentId,
    );
  }

  it('keeps the stable telemetry name and exposes task identity locally', async () => {
    const core = makeCore(
      'general-purpose',
      undefined,
      'fix token panel bug',
      'general-purpose-stable',
    );

    let observedName: string | undefined;
    let observedIdentity:
      | { type: string; id: string; taskName?: string }
      | undefined;
    await core.runInAgentFrames(async () => {
      observedName = subagentNameContext.getStore();
      observedIdentity = subagentIdentityContext.getStore();
    });

    expect(observedName).toBe('general-purpose');
    expect(observedIdentity).toMatchObject({
      type: 'general-purpose',
      taskName: 'fix token panel bug',
    });
    expect(observedIdentity?.id).toBe('general-purpose-stable');
  });

  it('publishes both the runtime view and the agent name when invoked from outside any frame', async () => {
    const view: RuntimeContentGeneratorView = {
      contentGenerator: {
        generateContentStream: () => Promise.resolve(),
      } as unknown as ContentGenerator,
      contentGeneratorConfig: {
        model: 'agent-model',
        authType: 'anthropic',
      } as ContentGeneratorConfig,
    };
    const core = makeCore('image-agent', view);

    let observedView: RuntimeContentGeneratorView | undefined;
    let observedName: string | undefined;
    await core.runInAgentFrames(async () => {
      observedView = getRuntimeContentGenerator();
      observedName = subagentNameContext.getStore();
    });

    expect(observedView).toBe(view);
    expect(observedName).toBe('image-agent');
  });

  it('restores frames even when called from a fresh async chain (deferred-approval path)', async () => {
    // Simulates the UI's async-input handler invoking the captured
    // `respond` callback after the reasoning-loop frame has unwound.
    // Without `runInAgentFrames` re-entering, the body would see the
    // top-level (parent) view.
    const view: RuntimeContentGeneratorView = {
      contentGenerator: {
        generateContentStream: () => Promise.resolve(),
      } as unknown as ContentGenerator,
      contentGeneratorConfig: {
        model: 'agent-model',
        authType: 'anthropic',
      } as ContentGeneratorConfig,
    };
    const core = makeCore('approval-agent', view);

    // Capture a thunk equivalent to the `respond` closure that AgentCore
    // emits with TOOL_WAITING_APPROVAL — the wrap is identical.
    let capturedRespond: (() => Promise<void>) | undefined;
    const onConfirmInvocations: Array<{
      view: RuntimeContentGeneratorView | undefined;
      name: string | undefined;
    }> = [];
    const onConfirm = async () => {
      onConfirmInvocations.push({
        view: getRuntimeContentGenerator(),
        name: subagentNameContext.getStore(),
      });
    };

    await core.runInAgentFrames(async () => {
      // Inside the reasoning-loop frame the agent would build the
      // closure that the UI later invokes — same shape as line 938 of
      // agent-core.ts.
      capturedRespond = () => core.runInAgentFrames(onConfirm);
    });

    // After the loop frame has unwound, neither frame is active.
    expect(getRuntimeContentGenerator()).toBeUndefined();
    expect(subagentNameContext.getStore()).toBeUndefined();

    // Hop to a brand-new microtask chain to be sure no parent ALS frame
    // is in scope, then invoke the captured callback.
    await new Promise((resolve) => setImmediate(resolve));
    await capturedRespond!();

    expect(onConfirmInvocations).toHaveLength(1);
    expect(onConfirmInvocations[0]!.view).toBe(view);
    expect(onConfirmInvocations[0]!.name).toBe('approval-agent');
  });

  it('still publishes the agent name when no runtime view is set (inheriting agent)', async () => {
    const core = makeCore('inherit-agent');

    let observedView: RuntimeContentGeneratorView | undefined;
    let observedName: string | undefined;
    await core.runInAgentFrames(async () => {
      observedView = getRuntimeContentGenerator();
      observedName = subagentNameContext.getStore();
    });

    expect(observedView).toBeUndefined();
    expect(observedName).toBe('inherit-agent');
  });

  it('clears the parent invocation context before running the reasoning loop', async () => {
    const core = makeCore('isolated-agent');
    const parentContext: InvocationContextV1 = {
      version: 1,
      sessionId: 'parent-session',
      promptId: 'parent-prompt',
    };
    let observed: InvocationContextV1 | undefined;
    vi.spyOn(
      core as unknown as {
        _runReasoningLoopInner: () => Promise<ReasoningLoopResult>;
      },
      '_runReasoningLoopInner',
    ).mockImplementation(async () => {
      observed = getInvocationContext();
      return { text: '', terminateMode: null, turnsUsed: 0 };
    });

    await runWithInvocationContext(parentContext, () =>
      core.runReasoningLoop({} as never, [], [], new AbortController()),
    );

    expect(observed).toBeUndefined();
  });

  it('uses inheritedView for deferred-approval continuation when the agent owns no view', async () => {
    // A nested `model: inherit` child under a runtime-view-bearing parent
    // owns no view of its own, but its tool bodies (e.g. `read_file`
    // checking modalities) need the parent's view. The reasoning loop
    // sees it via ALS, but the deferred-approval `respond` callback runs
    // from a fresh async chain where that frame is gone — so the agent
    // must capture it at emit time and pass it back through.
    const parentView: RuntimeContentGeneratorView = {
      contentGenerator: {
        generateContentStream: () => Promise.resolve(),
      } as unknown as ContentGenerator,
      contentGeneratorConfig: {
        model: 'parent-model',
        authType: 'anthropic',
      } as ContentGeneratorConfig,
    };
    const inheritingCore = makeCore('inherit-agent');

    let respondClosure: (() => Promise<void>) | undefined;
    let observedView: RuntimeContentGeneratorView | undefined;
    let observedName: string | undefined;
    const onConfirm = async () => {
      observedView = getRuntimeContentGenerator();
      observedName = subagentNameContext.getStore();
    };

    // Simulate the parent's loop frame being live at emit time.
    await runWithRuntimeContentGenerator(parentView, async () => {
      const inheritedView = getRuntimeContentGenerator();
      respondClosure = () =>
        inheritingCore.runInAgentFrames(onConfirm, inheritedView);
    });

    // Parent frame is gone; jump to a fresh microtask chain to be sure.
    expect(getRuntimeContentGenerator()).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    await respondClosure!();

    expect(observedView).toBe(parentView);
    expect(observedName).toBe('inherit-agent');
  });

  it('restores the logical agent id for deferred-approval continuations', async () => {
    const core = makeCore('approval-agent');

    let respondClosure: (() => Promise<void>) | undefined;
    let inheritedAgentId: string | null = null;
    let observedAgentId: string | null = null;
    const onConfirm = async () => {
      observedAgentId = getCurrentAgentId();
    };

    await runWithAgentContext('agent-123', async () => {
      inheritedAgentId = getCurrentAgentId();
      respondClosure = () =>
        core.runInAgentFrames(
          onConfirm,
          undefined,
          inheritedAgentId ?? undefined,
        );
    });

    expect(getCurrentAgentId()).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));

    await respondClosure!();

    expect(observedAgentId).toBe('agent-123');
  });

  it('restores the nesting depth for deferred-approval continuations', async () => {
    // Regression (codex review): the respond closure captured only the agent
    // id, so runWithAgentContext recomputed depth 0 from the UI's frame-less
    // chain — a deferred-approved `agent` tool call from a leaf-depth
    // sub-agent would then bypass maxSubagentDepth. The closure must carry
    // the depth captured at emit time.
    const core = makeCore('approval-agent');

    let respondClosure: (() => Promise<void>) | undefined;
    let observedDepth: number | null = null;
    const onConfirm = async () => {
      observedDepth = getCurrentAgentDepth();
    };

    // Emit from a nested frame (depth 2), mirroring a sub-agent of a
    // sub-agent whose tool call parks for approval.
    await runWithAgentContext('lvl1', () =>
      runWithAgentContext('lvl2', () =>
        runWithAgentContext('lvl3', async () => {
          const inheritedAgentId = getCurrentAgentId();
          const inheritedAgentDepth = getCurrentAgentDepth();
          expect(inheritedAgentDepth).toBe(2);
          respondClosure = () =>
            core.runInAgentFrames(
              onConfirm,
              undefined,
              inheritedAgentId ?? undefined,
              undefined,
              inheritedAgentDepth,
            );
        }),
      ),
    );

    // The frames are gone; respond fires from a fresh chain like the UI.
    expect(getCurrentAgentId()).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));

    await respondClosure!();

    expect(observedDepth).toBe(2);
  });

  it('restores the teammate identity for deferred-approval continuations', async () => {
    // Regression: a teammate's `send_message`/`task_update` that requires
    // confirmation resumes from the UI's async chain, outside the
    // teammate identity frame TeamManager established. Before the fix,
    // `getAgentName()` returned undefined there and send_message fell back
    // to the leader — forging a `from="leader"` envelope and slipping past
    // the leader-only `isTeammate()` guard. The respond closure must carry
    // the identity captured at emit time back into the resumed tool body.
    const core = makeCore('approval-agent');
    const teammateIdentity: TeammateIdentity = {
      agentId: 'scribe@demo',
      agentName: 'scribe',
      teamName: 'demo',
      isTeamLead: false,
    };

    let respondClosure: (() => Promise<void>) | undefined;
    let observedAgentName: string | undefined;
    let observedIsTeammate: boolean | undefined;
    const onConfirm = async () => {
      observedAgentName = getAgentName();
      observedIsTeammate = isTeammate();
    };

    // Simulate the teammate's loop frame being live at emit time.
    await runWithTeammateIdentity(teammateIdentity, async () => {
      const inherited = getTeammateContext();
      respondClosure = () =>
        core.runInAgentFrames(onConfirm, undefined, undefined, inherited);
    });

    // Teammate frame is gone; jump to a fresh microtask chain to be sure.
    expect(getAgentName()).toBeUndefined();
    expect(isTeammate()).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    await respondClosure!();

    expect(observedAgentName).toBe('scribe');
    expect(observedIsTeammate).toBe(true);
  });

  it("prefers the agent's own view over inheritedView when both are present", async () => {
    // Defensive: if a future caller wires both, the agent's explicit view
    // wins — we never want a captured snapshot to override the agent's
    // declared view.
    const ownView: RuntimeContentGeneratorView = {
      contentGenerator: {
        generateContentStream: () => Promise.resolve(),
      } as unknown as ContentGenerator,
      contentGeneratorConfig: {
        model: 'own-model',
        authType: 'anthropic',
      } as ContentGeneratorConfig,
    };
    const otherView: RuntimeContentGeneratorView = {
      contentGenerator: {
        generateContentStream: () => Promise.resolve(),
      } as unknown as ContentGenerator,
      contentGeneratorConfig: {
        model: 'other-model',
        authType: 'openai',
      } as ContentGeneratorConfig,
    };
    const core = makeCore('own-view-agent', ownView);

    let observed: RuntimeContentGeneratorView | undefined;
    await core.runInAgentFrames(async () => {
      observed = getRuntimeContentGenerator();
    }, otherView);

    expect(observed).toBe(ownView);
  });
});

describe('AgentCore approval response deduplication', () => {
  function buildApprovalCore(): {
    core: AgentCore;
    errorSpy: ReturnType<typeof vi.fn>;
  } {
    const errorSpy = vi.fn();
    const config = {
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn(),
      }),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), error: errorSpy }),
      getToolOutputBatchBudget: vi
        .fn()
        .mockReturnValue(Number.POSITIVE_INFINITY),
      getToolResultBytesWritten: vi.fn().mockReturnValue(0),
      getSessionId: vi.fn().mockReturnValue('approval-session'),
    } as unknown as Config;
    const core = new AgentCore(
      'approval-agent',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
    );
    return { core, errorSpy };
  }

  it('retries only a transiently failed listener', async () => {
    const { core, errorSpy } = buildApprovalCore();
    const deliveryError = new Error('approval listener failed');
    let shouldThrow = true;
    const transientListener = vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw deliveryError;
      }
    });
    core
      .getEventEmitter()
      .on(AgentEventType.TOOL_WAITING_APPROVAL, transientListener);
    const approvalEvents: AgentApprovalRequestEvent[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      approvalEvents.push(event);
    });

    const request = {
      callId: 'call-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.waitFor(() =>
        expect(transientListener).toHaveBeenCalledTimes(2),
      );
      expect(approvalEvents).toHaveLength(1);
      expect(transientListener).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Approval event delivery failed for call-retry',
        ),
        deliveryError,
      );
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });

  it('continues past a thrower before a healthy listener', async () => {
    const { core } = buildApprovalCore();
    const deliveryError = new Error('approval listener always fails');
    const thrower = vi.fn(() => {
      throw deliveryError;
    });
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, thrower);
    const healthyListener = vi.fn();
    core
      .getEventEmitter()
      .on(AgentEventType.TOOL_WAITING_APPROVAL, healthyListener);

    const request = {
      callId: 'call-bounded-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-bounded-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      expect(thrower).toHaveBeenCalledOnce();
      expect(healthyListener).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });

  it('bounds persistent listener retries and reports exhaustion', async () => {
    vi.useFakeTimers();
    const { core, errorSpy } = buildApprovalCore();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const deliveryError = new Error('approval listener always fails');
    const thrower = vi.fn(() => {
      throw deliveryError;
    });
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, thrower);

    const request = {
      callId: 'call-bounded-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-bounded-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.runAllTimersAsync();
      expect(thrower).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Approval event delivery for call-bounded-retry exhausted 3 attempts for 1 listener',
        ),
      );
      const scheduler = scheduleSpy.mock.instances[0] as unknown as {
        onToolCallsUpdate?: (calls: ToolCall[]) => void;
      };
      const siblingRequest = {
        callId: 'call-sibling',
        name: 'Shell',
        args: { command: 'pwd' },
        isClientInitiated: true,
        prompt_id: 'prompt-bounded-retry',
      };
      scheduler.onToolCallsUpdate?.([
        waiting,
        {
          status: 'scheduled',
          request: siblingRequest,
        } as unknown as ToolCall,
      ]);
      scheduler.onToolCallsUpdate?.([
        waiting,
        {
          status: 'executing',
          request: siblingRequest,
        } as unknown as ToolCall,
      ]);
      expect(thrower).toHaveBeenCalledTimes(3);
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels a pending delivery retry when the approval settles', async () => {
    vi.useFakeTimers();
    const { core } = buildApprovalCore();
    let attempts = 0;
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, () => {
      attempts++;
      throw new Error('approval listener failed');
    });

    const request = {
      callId: 'call-settled-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-settled-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
        scheduler.onToolCallsUpdate?.([]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.runAllTimersAsync();
      expect(attempts).toBe(1);
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not duplicate a healthy listener before a failed listener', async () => {
    const { core } = buildApprovalCore();
    const retainedEvents: AgentApprovalRequestEvent[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      retainedEvents.push(event);
    });
    let shouldThrow = true;
    const transientListener = vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('later listener failed');
      }
    });
    core
      .getEventEmitter()
      .on(AgentEventType.TOOL_WAITING_APPROVAL, transientListener);
    let retryEvent: AgentApprovalRequestEvent | undefined;
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      retryEvent = event;
    });

    const onConfirm = vi.fn(async () => {});
    const request = {
      callId: 'call-partial-delivery',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-partial-delivery',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm,
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.waitFor(() =>
        expect(transientListener).toHaveBeenCalledTimes(2),
      );
      expect(retryEvent).toBeDefined();
      expect(retainedEvents).toHaveLength(1);
      expect(transientListener).toHaveBeenCalledTimes(2);
      await Promise.all([
        retainedEvents[0].respond(ToolConfirmationOutcome.ProceedOnce),
        retryEvent!.respond(ToolConfirmationOutcome.ProceedOnce),
      ]);
      expect(onConfirm).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });

  it('cancels a pending delivery retry on abort', async () => {
    vi.useFakeTimers();
    const { core } = buildApprovalCore();
    const thrower = vi.fn(() => {
      throw new Error('approval listener failed');
    });
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, thrower);

    const request = {
      callId: 'call-aborted-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-aborted-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      expect(thrower).toHaveBeenCalledOnce();
      abortController.abort();
      await processing;
      await vi.runAllTimersAsync();
      expect(thrower).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels a pending delivery retry when all tool calls complete', async () => {
    vi.useFakeTimers();
    const { core } = buildApprovalCore();
    const thrower = vi.fn(() => {
      throw new Error('approval listener failed');
    });
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, thrower);

    const request = {
      callId: 'call-completed-retry',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-completed-retry',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {}),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      expect(thrower).toHaveBeenCalledOnce();
      const scheduler = scheduleSpy.mock.instances[0] as unknown as {
        onAllToolCallsComplete?: (calls: ToolCall[]) => Promise<void>;
      };
      await scheduler.onAllToolCallsComplete?.([]);
      await processing;
      await vi.runAllTimersAsync();
      expect(thrower).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects an old approval after the call bounces to a new incarnation', async () => {
    const { core } = buildApprovalCore();
    const approvalEvents: AgentApprovalRequestEvent[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      approvalEvents.push(event);
    });

    const firstOnConfirm = vi.fn(async () => {});
    const secondOnConfirm = vi.fn(async () => {});
    const request = {
      callId: 'call-stale-approval',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-stale-approval',
    };
    const firstWaiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: firstOnConfirm,
      },
    } as unknown as WaitingToolCall;
    const secondWaiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'info',
        title: 'Hook confirmation',
        prompt: 'Approve bounced execution?',
        onConfirm: secondOnConfirm,
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([firstWaiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.waitFor(() => expect(approvalEvents).toHaveLength(1));
      const scheduler = scheduleSpy.mock.instances[0] as unknown as {
        onToolCallsUpdate?: (calls: ToolCall[]) => void;
      };
      scheduler.onToolCallsUpdate?.([secondWaiting]);
      await vi.waitFor(() => expect(approvalEvents).toHaveLength(2));

      await approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce);
      await approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce);

      expect(firstOnConfirm).not.toHaveBeenCalled();
      expect(secondOnConfirm).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });

  it('creates a new approval when the same details become active again', async () => {
    const { core } = buildApprovalCore();
    const approvalEvents: AgentApprovalRequestEvent[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      approvalEvents.push(event);
    });

    const onConfirm = vi.fn(async () => {});
    const request = {
      callId: 'call-reused-details',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-reused-details',
    };
    const waiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm,
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([waiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      expect(approvalEvents).toHaveLength(1);
      const scheduler = scheduleSpy.mock.instances[0] as unknown as {
        onToolCallsUpdate?: (calls: ToolCall[]) => void;
      };
      scheduler.onToolCallsUpdate?.([]);
      scheduler.onToolCallsUpdate?.([waiting]);
      expect(approvalEvents).toHaveLength(2);

      await approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce);
      await approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce);

      expect(onConfirm).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });

  it('emits once per approval incarnation and allows each response', async () => {
    const { core } = buildApprovalCore();
    const approvalEvents: AgentApprovalRequestEvent[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, (event) => {
      approvalEvents.push(event);
    });

    const firstOnConfirm = vi.fn(async () => {});
    const secondOnConfirm = vi.fn(async () => {});
    const request = {
      callId: 'call-1',
      name: 'Shell',
      args: { command: 'git status' },
      isClientInitiated: true,
      prompt_id: 'prompt-1',
    };
    const secondWaiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'info',
        title: 'Hook confirmation',
        prompt: 'Approve bounced execution?',
        onConfirm: secondOnConfirm,
      },
    } as unknown as WaitingToolCall;
    const firstWaiting = {
      status: 'awaiting_approval',
      request,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm: vi.fn(async () => {
          await firstOnConfirm();
          const scheduler = scheduleSpy.mock.instances[0] as unknown as {
            onToolCallsUpdate?: (calls: ToolCall[]) => void;
          };
          scheduler.onToolCallsUpdate?.([secondWaiting]);
        }),
      },
    } as unknown as WaitingToolCall;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        const scheduler = this as unknown as {
          onToolCallsUpdate?: (calls: ToolCall[]) => void;
        };
        scheduler.onToolCallsUpdate?.([firstWaiting]);
        scheduler.onToolCallsUpdate?.([firstWaiting]);
      });
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [{ id: request.callId, name: request.name, args: request.args }],
      abortController,
      request.prompt_id,
      1,
      [{ name: request.name } as FunctionDeclaration],
    );
    try {
      await vi.waitFor(() => expect(approvalEvents).toHaveLength(1));
      await Promise.all([
        approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce),
        approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce),
      ]);
      await vi.waitFor(() => expect(approvalEvents).toHaveLength(2));
      await Promise.all([
        approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce),
        approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce),
      ]);

      expect(firstOnConfirm).toHaveBeenCalledOnce();
      expect(secondOnConfirm).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });
});

describe('AgentCore.prepareTools', () => {
  // Subagents that opt into the wildcard (`tools: ['*']`) — or omit
  // toolConfig entirely — must inherit DEFERRED tools too. Otherwise a
  // subagent configured with `tools: ['*']` against a registry that
  // includes MCP / lsp / cron_* tools would silently lose them once
  // ToolSearch was introduced.
  function buildAgentForTools(
    toolConfig: ToolConfig | undefined,
    fnDeclarations: FunctionDeclaration[],
    maxSubagentDepth = 5,
    toolOutputBatchBudget = Number.POSITIVE_INFINITY,
  ): {
    core: AgentCore;
    debugSpy: ReturnType<typeof vi.fn>;
    getFunctionDeclarationsSpy: ReturnType<typeof vi.fn>;
    getFunctionDeclarationsFilteredSpy: ReturnType<typeof vi.fn>;
    isPermissionDeferredSpy: ReturnType<typeof vi.fn>;
    isDeferredAndHiddenSpy: ReturnType<typeof vi.fn>;
  } {
    const debugSpy = vi.fn();
    const getFunctionDeclarationsSpy = vi.fn().mockReturnValue(fnDeclarations);
    const getFunctionDeclarationsFilteredSpy = vi.fn((names: string[]) =>
      fnDeclarations.filter((d) => d.name && names.includes(d.name)),
    );
    const isPermissionDeferredSpy = vi.fn().mockReturnValue(false);
    const isDeferredAndHiddenSpy = vi.fn().mockReturnValue(false);
    const config = {
      getDebugLogger: vi.fn().mockReturnValue({ debug: debugSpy }),
      getToolRegistry: vi.fn().mockReturnValue({
        warmAll: vi.fn().mockResolvedValue(undefined),
        getFunctionDeclarations: getFunctionDeclarationsSpy,
        getFunctionDeclarationsFiltered: getFunctionDeclarationsFilteredSpy,
        isPermissionDeferred: isPermissionDeferredSpy,
        isDeferredAndHidden: isDeferredAndHiddenSpy,
      }),
      getMaxSubagentDepth: vi.fn().mockReturnValue(maxSubagentDepth),
      getToolOutputBatchBudget: vi.fn().mockReturnValue(toolOutputBatchBudget),
      getToolResultBytesWritten: vi.fn().mockReturnValue(500 * 1024 * 1024),
    } as unknown as Config;

    const core = new AgentCore(
      'test-subagent',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      toolConfig,
    );
    return {
      core,
      debugSpy,
      getFunctionDeclarationsSpy,
      getFunctionDeclarationsFilteredSpy,
      isPermissionDeferredSpy,
      isDeferredAndHiddenSpy,
    };
  }

  it('wildcard tools:["*"] inherits deferred tools (passes includeDeferred: true)', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: 'core_tool', description: 'core' } as FunctionDeclaration,
      {
        name: 'mcp__github__create_issue',
        description: 'mcp deferred',
      } as FunctionDeclaration,
    ];
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      { tools: ['*'] },
      fnDecls,
    );

    const tools = await core.prepareTools();

    // The critical assertion: includeDeferred: true was used. Without it
    // a refactor could silently downgrade to the default which excludes
    // deferred tools, breaking subagent configs that depend on MCP.
    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
    });
    // Sanity: declared MCP tool is present in the agent's tool list.
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['core_tool', 'mcp__github__create_issue']),
    );
  });

  it('absent toolConfig also inherits deferred tools (default = wildcard)', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: 'lsp', description: 'language server' } as FunctionDeclaration,
      {
        name: ToolNames.ENTER_PLAN_MODE,
        description: 'enter plan mode',
      } as FunctionDeclaration,
      {
        name: ToolNames.EXIT_PLAN_MODE,
        description: 'exit plan mode',
      } as FunctionDeclaration,
    ];
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      undefined,
      fnDecls,
    );

    const tools = await core.prepareTools();

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
    });
    expect(tools.map((t) => t.name)).toEqual(['lsp']);
  });

  it('records the prepared declaration names on the agent context frame (R24-3)', async () => {
    // tool_search's `select:` consults the recorded set to tell whether a
    // registry-hidden deferred tool is nonetheless declared — and directly
    // callable — for the current subagent. Wildcard agents declare the
    // deferred tools, so the recorded set must include them.
    const fnDecls: FunctionDeclaration[] = [
      { name: 'core_tool', description: 'core' } as FunctionDeclaration,
      {
        name: 'mcp__github__create_issue',
        description: 'mcp deferred',
      } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls);

    await runWithAgentContext('agent-record', async () => {
      expect(getCurrentAgentDeclaredToolNames()).toBeUndefined();
      await core.prepareTools();
      expect(getCurrentAgentDeclaredToolNames()).toEqual(
        new Set(['core_tool', 'mcp__github__create_issue']),
      );
    });
    // The recording must not leak past the frame.
    expect(getCurrentAgentDeclaredToolNames()).toBeUndefined();
  });

  it('records only the listed names for explicit-tool-list subagents (R24-3)', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: 'read_file', description: 'read' } as FunctionDeclaration,
      {
        name: 'mcp__github__create_issue',
        description: 'mcp deferred',
      } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['read_file'] }, fnDecls);

    await runWithAgentContext('agent-record', async () => {
      await core.prepareTools();
      // The explicit list omits the deferred tool, so the recorded set
      // must NOT contain it — select: stays fail-closed for it.
      expect(getCurrentAgentDeclaredToolNames()).toEqual(
        new Set(['read_file']),
      );
    });
  });

  it('explicit tools list does NOT use the wildcard inherit path', async () => {
    // When the subagent enumerates tools by name, deferred-tool inclusion
    // is not the wildcard branch's responsibility — getFunctionDeclarationsFiltered
    // is used instead. This pins that the wildcard arm and the explicit
    // arm don't get crossed up by future refactors.
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      { tools: ['read_file', 'edit'] },
      [],
    );

    await core.prepareTools();

    expect(getFunctionDeclarationsSpy).not.toHaveBeenCalled();
  });

  it.each([{ tools: ['*'] }, { tools: ['visible', 'hidden_by_allowlist'] }])(
    'keeps hidden permission-deferred tools out of subagent declarations: $tools',
    async (toolConfig) => {
      const fnDecls: FunctionDeclaration[] = [
        { name: 'visible' } as FunctionDeclaration,
        { name: 'hidden_by_allowlist' } as FunctionDeclaration,
      ];
      const { core, isPermissionDeferredSpy, isDeferredAndHiddenSpy } =
        buildAgentForTools(toolConfig, fnDecls);
      isPermissionDeferredSpy.mockImplementation(
        (name) => name === 'hidden_by_allowlist',
      );
      isDeferredAndHiddenSpy.mockImplementation(
        (name) => name === 'hidden_by_allowlist',
      );

      const tools = await core.prepareTools();

      expect(tools.map((tool) => tool.name)).toEqual(['visible']);
    },
  );

  it('excludes plan lifecycle tools from wildcard/default subagent tools', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: 'core_tool', description: 'core' } as FunctionDeclaration,
      {
        name: ToolNames.ENTER_PLAN_MODE,
        description: 'enter plan mode',
      } as FunctionDeclaration,
      {
        name: ToolNames.EXIT_PLAN_MODE,
        description: 'exit plan mode',
      } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls);

    const tools = await core.prepareTools();

    expect(tools.map((t) => t.name)).toEqual(['core_tool']);
  });

  it('does not re-enable plan lifecycle tools via explicit tool names', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: ToolNames.READ_FILE, description: 'read' } as FunctionDeclaration,
      {
        name: ToolNames.ENTER_PLAN_MODE,
        description: 'enter plan mode',
      } as FunctionDeclaration,
      {
        name: ToolNames.EXIT_PLAN_MODE,
        description: 'exit plan mode',
      } as FunctionDeclaration,
    ];
    const { core, debugSpy, getFunctionDeclarationsFilteredSpy } =
      buildAgentForTools(
        {
          tools: [
            ToolNames.READ_FILE,
            ToolNames.ENTER_PLAN_MODE,
            ToolNames.EXIT_PLAN_MODE,
          ],
        },
        fnDecls,
      );

    const tools = await core.prepareTools();

    expect(getFunctionDeclarationsFilteredSpy).toHaveBeenCalledWith([
      ToolNames.READ_FILE,
    ]);
    expect(tools.map((t) => t.name)).toEqual([ToolNames.READ_FILE]);
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered "${ToolNames.ENTER_PLAN_MODE}" from explicit subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered "${ToolNames.EXIT_PLAN_MODE}" from explicit subagent tool list`,
    );
  });

  it('filters inline declarations using the full subagent exclusion floor', async () => {
    const inlineSafe = {
      name: 'inline_safe',
      description: 'safe inline tool',
    } as FunctionDeclaration;
    const inlinePermissionDeferred = {
      name: 'hidden_by_allowlist',
      description: 'hidden',
    } as FunctionDeclaration;
    const { core, debugSpy, isPermissionDeferredSpy, isDeferredAndHiddenSpy } =
      buildAgentForTools(
        {
          tools: [
            { name: ToolNames.SEND_MESSAGE } as FunctionDeclaration,
            { name: ToolNames.TASK_UPDATE } as FunctionDeclaration,
            { name: ToolNames.ENTER_PLAN_MODE } as FunctionDeclaration,
            { name: ToolNames.EXIT_PLAN_MODE } as FunctionDeclaration,
            inlinePermissionDeferred,
            inlineSafe,
          ],
        },
        [],
      );
    isPermissionDeferredSpy.mockImplementation(
      (name) => name === 'hidden_by_allowlist',
    );
    isDeferredAndHiddenSpy.mockImplementation(
      (name) => name === 'hidden_by_allowlist',
    );

    const tools = await core.prepareTools();

    expect(tools).toEqual([inlineSafe]);
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered inline declaration "${ToolNames.SEND_MESSAGE}" from subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered inline declaration "${ToolNames.TASK_UPDATE}" from subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered inline declaration "${ToolNames.ENTER_PLAN_MODE}" from subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered inline declaration "${ToolNames.EXIT_PLAN_MODE}" from subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[prepareTools] Filtered inline declaration "hidden_by_allowlist" from subagent tool list',
    );
  });

  it('filters tool_call from inline subagent declarations', async () => {
    const inlineWrapper = {
      name: ToolNames.DEFERRED_TOOL_CALL,
      description: 'stable deferred tool proxy',
    } as FunctionDeclaration;
    const { core, debugSpy } = buildAgentForTools(
      { tools: [inlineWrapper] },
      [],
    );

    const tools = await core.prepareTools();

    expect(tools).toEqual([]);
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered inline declaration "${ToolNames.DEFERRED_TOOL_CALL}" from subagent tool list`,
    );

    let teammateTools: FunctionDeclaration[] = [];
    await runWithTeammateIdentity(
      {
        agentId: 'worker@test',
        agentName: 'worker',
        teamName: 'test',
        isTeamLead: false,
      },
      async () => {
        teammateTools = await core.prepareTools();
      },
    );
    expect(teammateTools).toEqual([]);
  });

  it('rejects a subagent wrapper call before scheduler normalization', async () => {
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockRejectedValue(new Error('scheduler must not receive wrapper calls'));
    try {
      const { core } = buildAgentForTools(
        {
          tools: [
            {
              name: ToolNames.DEFERRED_TOOL_CALL,
              description: 'stable deferred tool proxy',
            } as FunctionDeclaration,
          ],
        },
        [],
      );
      const tools = await runWithAgentContext('test-subagent', () =>
        core.prepareTools(),
      );

      const result = await runWithAgentContext('test-subagent', () =>
        core.runInAgentFrames(() =>
          core.processFunctionCalls(
            [
              {
                name: ToolNames.DEFERRED_TOOL_CALL,
                args: { name: ToolNames.CRON_CREATE, arguments: {} },
                id: 'proxy-call-1',
              },
            ],
            new AbortController(),
            'prompt-filtered-deferred-wrapper',
            1,
            tools,
          ),
        ),
      );

      const response = result.messages[0]?.parts?.[0]?.functionResponse
        ?.response as { error?: string } | undefined;
      expect(response?.error).toContain(
        `Tool "${ToolNames.DEFERRED_TOOL_CALL}" not found`,
      );
      expect(scheduleSpy).not.toHaveBeenCalled();
    } finally {
      scheduleSpy.mockRestore();
    }
  });

  it('keeps teammate coordination tools but excludes plan lifecycle tools', async () => {
    const fnDecls: FunctionDeclaration[] = [
      {
        name: ToolNames.SEND_MESSAGE,
        description: 'send message',
      } as FunctionDeclaration,
      {
        name: ToolNames.TASK_UPDATE,
        description: 'task update',
      } as FunctionDeclaration,
      {
        name: ToolNames.TODO_WRITE,
        description: 'TodoWrite',
      } as FunctionDeclaration,
      {
        name: ToolNames.ENTER_PLAN_MODE,
        description: 'enter plan mode',
      } as FunctionDeclaration,
      {
        name: ToolNames.EXIT_PLAN_MODE,
        description: 'exit plan mode',
      } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls);

    let tools: FunctionDeclaration[] = [];
    await runWithTeammateIdentity(
      {
        agentId: 'agent@test',
        agentName: 'agent',
        teamName: 'test',
        isTeamLead: false,
      },
      async () => {
        tools = await core.prepareTools();
      },
    );

    expect(tools.map((t) => t.name)).toEqual([
      ToolNames.SEND_MESSAGE,
      ToolNames.TASK_UPDATE,
    ]);
  });

  it('keeps exit_plan_mode for plan-required teammates only', async () => {
    const fnDecls: FunctionDeclaration[] = [
      {
        name: ToolNames.SEND_MESSAGE,
        description: 'send message',
      } as FunctionDeclaration,
      {
        name: ToolNames.ENTER_PLAN_MODE,
        description: 'enter plan mode',
      } as FunctionDeclaration,
      {
        name: ToolNames.EXIT_PLAN_MODE,
        description: 'exit plan mode',
      } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls);

    let tools: FunctionDeclaration[] = [];
    await runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
        planModeRequired: true,
      },
      async () => {
        tools = await core.prepareTools();
      },
    );

    expect(tools.map((t) => t.name)).toEqual([
      ToolNames.SEND_MESSAGE,
      ToolNames.EXIT_PLAN_MODE,
    ]);
  });

  it.each([ToolNames.ENTER_PLAN_MODE, ToolNames.EXIT_PLAN_MODE])(
    'returns a dedicated message when filtered %s is called directly',
    async (toolName) => {
      boundaryObserveMock.mockClear();
      const { core } = buildAgentForTools(undefined, []);

      const result = await runWithAgentContext('test-subagent', () =>
        core.runInAgentFrames(() =>
          core.processFunctionCalls(
            [
              {
                name: toolName,
                args: { plan: 'Plan from filtered tool' },
                id: 'call-1',
              },
            ],
            new AbortController(),
            'prompt-filtered-plan-tool',
            1,
            [{ name: ToolNames.READ_FILE } as FunctionDeclaration],
          ),
        ),
      );

      const response = result.messages[0]?.parts?.[0]?.functionResponse
        ?.response as { error?: string } | undefined;
      expect(response?.error).toContain('not available inside subagents');
      expect(response?.error).toContain('return your plan');
      expect(response?.error).not.toContain('not found');
      const producerObservations = boundaryObserveMock.mock.calls
        .map(([observation]) => observation)
        .filter((observation) => observation.stage === 'producer');
      expect(producerObservations).toHaveLength(1);
      expect(producerObservations[0].artifacts).toEqual([
        { state: 'none', kinds: [] },
      ]);
    },
  );

  it('hard-caps the aggregate subagent tool response', async () => {
    const { core } = buildAgentForTools(undefined, [], 5, 1000);
    const missingName = `missing_${'a'.repeat(2000)}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-'));
    const jsonlPath = path.join(tempDir, 'agent.jsonl');
    const writer = attachJsonlTranscriptWriter(
      core.getEventEmitter(),
      jsonlPath,
      {
        agentId: 'agent-budget',
        agentName: 'test-subagent',
        sessionId: 'session-budget',
        cwd: tempDir,
        version: 'test',
      },
    );

    try {
      const result = await core.processFunctionCalls(
        [
          { name: missingName, args: {} },
          { name: missingName, args: {} },
        ],
        new AbortController(),
        'prompt-budget',
        1,
        [],
      );

      const parts = result.messages[0].parts ?? [];
      const total = parts.reduce((sum, part) => {
        const response = part.functionResponse?.response;
        const output = response?.['output'];
        const error = response?.['error'];
        return (
          sum +
          (typeof output === 'string' ? output.length : 0) +
          (typeof error === 'string' ? error.length : 0)
        );
      }, 0);
      expect(total).toBeLessThanOrEqual(1000);
      const responseIds = parts.map((part) => part.functionResponse?.id);
      expect(new Set(responseIds).size).toBe(2);
      expect(responseIds[0]).toMatch(/-0$/);
      expect(responseIds[1]).toMatch(/-1$/);

      writer.cleanup();
      const records = fs
        .readFileSync(jsonlPath, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string;
              message?: { parts?: unknown[] };
            },
        );
      const transcriptParts = records
        .filter((record) => record.type === 'tool_result')
        .flatMap((record) => record.message?.parts ?? []);
      expect(transcriptParts).toEqual(parts);
    } finally {
      writer.cleanup();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── Nested sub-agents ──────────────────────────────────────────
  // The AgentTool is depth-gated: available to a sub-agent only while
  // maxSubagentDepth still permits another level. prepareTools() reads the
  // sub-agent's own 0-based depth from getCurrentAgentDepth(); a child sits
  // at level (depth + 2), which must not exceed the cap.
  const nestingDecls = (): FunctionDeclaration[] => [
    { name: 'read_file', description: 'read' } as FunctionDeclaration,
    {
      name: ToolNames.AGENT,
      description: 'spawn subagent',
    } as FunctionDeclaration,
  ];

  it('nesting: includes AgentTool for a shallow subagent when depth permits', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 5);
    // One frame → getCurrentAgentDepth() === 0 (a top-level sub-agent).
    const tools = await runWithAgentContext('lvl1', () => core.prepareTools());
    expect(tools.map((t) => t.name)).toContain(ToolNames.AGENT);
  });

  it('nesting: excludes AgentTool at the leaf depth', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 2);
    // Two nested frames → depth === 1 → level 2 → the leaf when max === 2.
    const tools = await runWithAgentContext('lvl1', () =>
      runWithAgentContext('lvl2', () => core.prepareTools()),
    );
    const names = tools.map((t) => t.name);
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('nesting: maxSubagentDepth=1 reproduces the old no-nesting behavior', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 1);
    const tools = await runWithAgentContext('lvl1', () => core.prepareTools());
    expect(tools.map((t) => t.name)).not.toContain(ToolNames.AGENT);
  });

  it('nesting: frameless prepareTools fails closed — AgentTool excluded', async () => {
    // prepareTools() only ever serves agents, never the top-level session.
    // A missing agent frame means the launch path forgot runWithAgentContext
    // (codex review: AgentInteractive.start() before it established its
    // frame); such an agent must not be depth-gated as the top-level session.
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 5);
    const tools = await core.prepareTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('nesting: fork execution contexts never receive the AgentTool', async () => {
    // The fork contract is context-sharing, not isolation — forks must not
    // spawn. Depth would otherwise permit nesting here (one frame, max 5).
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 5);
    const tools = await runInForkContext(() =>
      runWithAgentContext('lvl1', () => core.prepareTools()),
    );
    const names = tools.map((t) => t.name);
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('nesting: teammates never receive the AgentTool regardless of depth', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, nestingDecls(), 5);
    const identity: TeammateIdentity = {
      agentId: 'scribe@demo',
      agentName: 'scribe',
      teamName: 'demo',
      isTeamLead: false,
    };
    const tools = await runWithTeammateIdentity(identity, () =>
      runWithAgentContext('lvl1', () => core.prepareTools()),
    );
    expect(tools.map((t) => t.name)).not.toContain(ToolNames.AGENT);
  });

  it('nesting: explicit tools list includes AgentTool only when nesting is allowed', async () => {
    const allowed = buildAgentForTools(
      { tools: ['read_file', ToolNames.AGENT] },
      nestingDecls(),
      5,
    );
    const allowedTools = await runWithAgentContext('lvl1', () =>
      allowed.core.prepareTools(),
    );
    expect(allowedTools.map((t) => t.name)).toContain(ToolNames.AGENT);

    const denied = buildAgentForTools(
      { tools: ['read_file', ToolNames.AGENT] },
      nestingDecls(),
      1,
    );
    const deniedTools = await runWithAgentContext('lvl1', () =>
      denied.core.prepareTools(),
    );
    const deniedNames = deniedTools.map((t) => t.name);
    expect(deniedNames).not.toContain(ToolNames.AGENT);
    expect(deniedNames).toContain('read_file');
  });
});

describe('AgentCore declared tool names across woken frames (R25-1)', () => {
  // The set prepareTools() records on the ALS frame dies with that frame.
  // Every round woken later — an idle AgentInteractive woken by
  // enqueueMessage(), a background-agent continuation turn, a resumed
  // background agent — enters a FRESH runWithAgentContext frame built from
  // the delivery caller's ambient store: `undefined` when the message comes
  // from the top-level session, or the SENDER agent's set when delivery
  // happens inside another agent's tool body (runInContext restores only
  // the teammate identity). runInAgentFrames — the single entry every
  // reasoning loop and deferred-approval continuation passes through — must
  // re-record THIS agent's persisted set onto the fresh frame, or
  // tool_search's `select:` gate fails closed (or reads the wrong set) on
  // every round after the first.

  function makeCoreWithPreparedTools(
    toolNames: string[],
    name = 'wake-agent',
  ): AgentCore {
    const declarations = toolNames.map(
      (toolName) => ({ name: toolName }) as FunctionDeclaration,
    );
    const config = {
      getToolRegistry: vi.fn().mockReturnValue({
        warmAll: vi.fn().mockResolvedValue(undefined),
        getFunctionDeclarations: vi.fn().mockReturnValue(declarations),
      }),
      getMaxSubagentDepth: vi.fn().mockReturnValue(1),
    } as unknown as Config;
    return new AgentCore(
      name,
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
    );
  }

  it('re-records the prepared set on a wake-round frame entered after the start frame unwound', async () => {
    const core = makeCoreWithPreparedTools([
      'core_tool',
      'mcp__github__create_issue',
    ]);

    // First round: start()'s frame — prepareTools records the set live.
    await runWithAgentContext('wake-agent', async () => {
      await core.prepareTools();
      expect(getCurrentAgentDeclaredToolNames()).toEqual(
        new Set(['core_tool', 'mcp__github__create_issue']),
      );
    });
    // The loop settles and the frame unwinds (agent goes idle).
    expect(getCurrentAgentDeclaredToolNames()).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    // A message wakes the agent: enqueueMessage -> startRunLoop builds a
    // fresh frame from the delivery caller's ambient store — here the
    // top-level session, which has no frame at all — and runs the round.
    let observed: ReadonlySet<string> | undefined;
    await runWithAgentContext('wake-agent', () =>
      core.runInAgentFrames(async () => {
        observed = getCurrentAgentDeclaredToolNames();
      }),
    );
    expect(observed).toEqual(
      new Set(['core_tool', 'mcp__github__create_issue']),
    );
  });

  it('keeps the set visible through the full runReasoningLoop entry of a wake round', async () => {
    // Full-path witness (same shape as observing runReasoningLoop from
    // inside each round's ALS context): an idle agent woken by
    // enqueueMessage from the top-level session enters a fresh frame, and
    // the round's reasoning loop must still see the prepared set.
    const core = makeCoreWithPreparedTools([
      'core_tool',
      'mcp__github__create_issue',
    ]);
    await runWithAgentContext('wake-agent', () => core.prepareTools());
    await new Promise((resolve) => setImmediate(resolve));

    let observedInLoop: ReadonlySet<string> | undefined;
    vi.spyOn(
      core as unknown as {
        _runReasoningLoopInner: () => Promise<ReasoningLoopResult>;
      },
      '_runReasoningLoopInner',
    ).mockImplementation(async () => {
      observedInLoop = getCurrentAgentDeclaredToolNames();
      return { text: '', terminateMode: null, turnsUsed: 0 };
    });

    // Called from the frame-less top-level chain: runLoop's fresh frame
    // starts with no declared set at all.
    await runWithAgentContext('wake-agent', () =>
      core.runReasoningLoop({} as never, [], [], new AbortController()),
    );

    expect(observedInLoop).toEqual(
      new Set(['core_tool', 'mcp__github__create_issue']),
    );
  });

  it('overwrites a SENDER frame set inherited by the fresh wake frame', async () => {
    const core = makeCoreWithPreparedTools([
      'core_tool',
      'mcp__github__create_issue',
    ]);
    await runWithAgentContext('wake-agent', () => core.prepareTools());

    // Delivery happens inside another agent's tool body: the wake frame
    // shallow-copies the sender's store, so it starts with the SENDER's
    // recorded set. The gate must end up reading this agent's own set, and
    // the sender's frame must not be corrupted by the re-recording.
    let observed: ReadonlySet<string> | undefined;
    let senderSetAfter: ReadonlySet<string> | undefined;
    await runWithAgentContext('sender-agent', async () => {
      recordCurrentAgentDeclaredToolNames(new Set(['other_tool']));
      await runWithAgentContext('wake-agent', () =>
        core.runInAgentFrames(async () => {
          observed = getCurrentAgentDeclaredToolNames();
        }),
      );
      senderSetAfter = getCurrentAgentDeclaredToolNames();
    });

    expect(observed).toEqual(
      new Set(['core_tool', 'mcp__github__create_issue']),
    );
    expect(senderSetAfter).toEqual(new Set(['other_tool']));
  });

  it('re-records the prepared set on the restored deferred-approval frame', async () => {
    const core = makeCoreWithPreparedTools(['core_tool']);
    await runWithAgentContext('wake-agent', () => core.prepareTools());
    await new Promise((resolve) => setImmediate(resolve));

    // Shape of the `respond` closure AgentCore emits with
    // TOOL_WAITING_APPROVAL: runInAgentFrames with inheritedAgentId builds
    // a fresh frame from the UI's frame-less async chain.
    let observed: ReadonlySet<string> | undefined;
    await core.runInAgentFrames(
      async () => {
        observed = getCurrentAgentDeclaredToolNames();
      },
      undefined,
      'wake-agent',
      undefined,
      0,
    );
    expect(observed).toEqual(new Set(['core_tool']));
  });

  it('leaves the frame untouched when prepareTools never ran on this core', async () => {
    // Defensive invariant: a core that has not completed prepareTools()
    // carries no set of its own and must not clear or overwrite whatever
    // the frame already holds (e.g. declarations inherited through the
    // shallow-copied frame from an ambient agent context).
    const forkCore = new AgentCore(
      'fork-agent',
      {} as unknown as Config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
    );

    let observed: ReadonlySet<string> | undefined;
    await runWithAgentContext('parent-agent', async () => {
      recordCurrentAgentDeclaredToolNames(new Set(['parent_tool']));
      await forkCore.runInAgentFrames(async () => {
        observed = getCurrentAgentDeclaredToolNames();
      });
    });
    expect(observed).toEqual(new Set(['parent_tool']));
  });
});

describe('extractParentToolNames', () => {
  const configWithTools = (
    tools: Array<{ functionDeclarations?: FunctionDeclaration[] }>,
  ): GenerateContentConfig => ({ tools }) as unknown as GenerateContentConfig;

  it('extracts declaration names from a single group', () => {
    const names = extractParentToolNames(
      configWithTools([
        {
          functionDeclarations: [
            { name: ToolNames.READ_FILE },
            { name: ToolNames.WRITE_FILE },
          ],
        },
      ]),
    );
    expect(names).toEqual([ToolNames.READ_FILE, ToolNames.WRITE_FILE]);
  });

  it('flattens and deduplicates names across multiple functionDeclarations groups', () => {
    const names = extractParentToolNames(
      configWithTools([
        { functionDeclarations: [{ name: ToolNames.READ_FILE }] },
        {
          functionDeclarations: [
            { name: ToolNames.READ_FILE },
            { name: ToolNames.GREP },
          ],
        },
      ]),
    );
    // READ_FILE appears in both groups but is returned once.
    expect(names).toEqual([ToolNames.READ_FILE, ToolNames.GREP]);
  });

  it('drops tools a subagent must never inherit (EXCLUDED_TOOLS_FOR_SUBAGENTS)', () => {
    const names = extractParentToolNames(
      configWithTools([
        {
          functionDeclarations: [
            { name: ToolNames.WORKFLOW },
            { name: ToolNames.AGENT },
            { name: ToolNames.REQUEST_SHUTDOWN },
            { name: ToolNames.READ_FILE },
          ],
        },
      ]),
    );
    expect(names).toEqual([ToolNames.READ_FILE]);
    expect(names).not.toContain(ToolNames.WORKFLOW);
    expect(names).not.toContain(ToolNames.AGENT);
    // Leader-only team control: a subagent must never impersonate the
    // leader by requesting a teammate shutdown (#9401).
    expect(names).not.toContain(ToolNames.REQUEST_SHUTDOWN);
  });

  it('filters out empty and non-string declaration names', () => {
    const names = extractParentToolNames(
      configWithTools([
        {
          functionDeclarations: [
            { name: '' },
            { name: undefined } as FunctionDeclaration,
            { name: ToolNames.READ_FILE },
          ],
        },
      ]),
    );
    expect(names).toEqual([ToolNames.READ_FILE]);
  });

  it('returns an empty array for undefined config or missing tools', () => {
    expect(extractParentToolNames(undefined)).toEqual([]);
    expect(extractParentToolNames({} as GenerateContentConfig)).toEqual([]);
    expect(extractParentToolNames(configWithTools([]))).toEqual([]);
    expect(extractParentToolNames(configWithTools([{}]))).toEqual([]);
  });
});
