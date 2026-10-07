/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getHookExecutionOwner,
  runWithHookExecutionOwner,
} from '../../hooks/hook-execution-context.js';

import { HookSystem } from '../../hooks/hookSystem.js';
import {
  HookEventName,
  HookType,
  PermissionMode,
  type HookInput,
} from '../../hooks/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FunctionDeclaration, GenerateContentConfig } from '@google/genai';
import {
  AgentCore,
  buildInheritedForkExecutionToolNames,
  extractParentToolNames,
  renderSubagentSystemPrompt,
  type ReasoningLoopResult,
} from './agent-core.js';
import { attachJsonlTranscriptWriter } from '../agent-transcript.js';
import {
  getCurrentAgentChat,
  runWithAgentChat,
  getCurrentAgentDepth,
  getCurrentAgentConfiguredToolAllowlist,
  getCurrentAgentDisallowedTools,
  getCurrentAgentId,
  getRuntimeContentGenerator,
  runWithAgentContext,
  runWithAgentConfiguredToolAllowlist,
  runWithAgentDisallowedTools,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import {
  subagentIdentityContext,
  subagentNameContext,
} from '../../utils/subagentNameContext.js';
import { runInForkContext } from '../../tools/agent/fork-subagent.js';
import { ToolNames } from '../../tools/tool-names.js';
import { ToolMode } from '../../tools/code-mode.js';
import {
  getAgentName,
  getTeammateContext,
  isTeammate,
  runWithTeammateIdentity,
} from '../team/identity.js';
import type { TeammateIdentity } from '../team/types.js';
import type { Config } from '../../config/config.js';
import type { ExecutionEnvironment } from '../../services/execution-environment.js';
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
import { markToolCallArgumentsIncomplete } from '../../core/incomplete-tool-call-args.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import {
  AgentEventType,
  type AgentApprovalRequestEvent,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
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

describe('renderSubagentSystemPrompt', () => {
  it('does not give structured memory routing instructions to subagents', () => {
    const runtimeContext = {
      getUserMemory: () => '',
      getAutoMemoryPrompt: () =>
        'Use search_memory only when routed by the complete tree.',
      getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
    } as unknown as Config;
    const prompt = renderSubagentSystemPrompt(
      { systemPrompt: 'You are a code reviewer.' } as PromptConfig,
      new ContextState(),
      runtimeContext,
    );

    expect(prompt).not.toContain('Use search_memory only when');

    vi.mocked(runtimeContext.getMemoryRecallMode).mockReturnValue('legacy');
    expect(
      renderSubagentSystemPrompt(
        { systemPrompt: 'You are a code reviewer.' } as PromptConfig,
        new ContextState(),
        runtimeContext,
      ),
    ).toContain('Use search_memory only when');
  });
});

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

const teammate = (
  agentName: string,
  teamName: string,
  extra: Partial<TeammateIdentity> = {},
): TeammateIdentity => ({
  agentId: `${agentName}@${teamName}`,
  agentName,
  teamName,
  isTeamLead: false,
  ...extra,
});

describe('AgentCore.runInAgentFrames', () => {
  // The deferred-approval `respond` callback that AgentCore hands to the UI
  // must restore both ALS frames the agent normally runs under, so any tool
  // body resumed via approval (including ones that trigger LLM calls) sees
  // the agent's ContentGenerator (modalities, auth) and is attributed to the
  // agent in token stats. The reasoning loop uses the same wrap, so anything
  // that breaks here also breaks the synchronous path. These tests pin the
  // contract.

  function makeCore(
    name: string,
    runtimeView?: RuntimeContentGeneratorView,
    taskName?: string,
    subagentId?: string,
    toolConfig?: ToolConfig,
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
      toolConfig,
      undefined,
      undefined,
      runtimeView,
      taskName,
      subagentId,
    );
  }

  const makeView = (
    model: string,
    authType = 'anthropic',
  ): RuntimeContentGeneratorView => ({
    contentGenerator: {
      generateContentStream: () => Promise.resolve(),
    } as unknown as ContentGenerator,
    contentGeneratorConfig: { model, authType } as ContentGeneratorConfig,
  });

  /** The trailing (inherited*) arguments of runInAgentFrames. */
  type Inherited = [
    RuntimeContentGeneratorView?,
    string?,
    TeammateIdentity?,
    number?,
  ];

  /** Runs `read` inside core's frames and returns what it observed. */
  async function observeIn<T>(
    core: AgentCore,
    read: () => T,
    ...inherited: Inherited
  ): Promise<T> {
    let observed!: T;
    await core.runInAgentFrames(
      async () => {
        observed = read();
      },
      ...inherited,
    );
    return observed;
  }

  const frameView = () => ({
    view: getRuntimeContentGenerator(),
    name: subagentNameContext.getStore(),
  });

  // Simulates the UI's async-input handler invoking the captured `respond`
  // closure after the emit-time frame has unwound: `capture` snapshots the
  // closure's inherited args inside `emitFrame`, `unwound` checks the frame
  // is gone, then we hop to a brand-new macrotask (so no parent ALS frame is
  // in scope) and replay runInAgentFrames with the snapshot.
  async function resumeLater<T>(
    core: AgentCore,
    emitFrame: (emit: () => Promise<void>) => Promise<unknown>,
    capture: () => Inherited,
    unwound: () => void,
    read: () => T,
  ): Promise<T> {
    let inherited: Inherited = [];
    await emitFrame(async () => {
      inherited = capture();
    });
    unwound();
    await new Promise((resolve) => setImmediate(resolve));
    return observeIn(core, read, ...inherited);
  }

  it.each([
    { caller: null, explicit: undefined, expected: null },
    { caller: 'caller-A', explicit: undefined, expected: 'caller-A' },
    { caller: 'caller-A', explicit: 'child-B', expected: 'child-B' },
  ])(
    'dispatches real tool hooks for caller $caller and explicit child $explicit',
    async ({ caller, explicit, expected }) => {
      const events: HookInput[] = [];
      const config = {
        getSessionId: () => 'session',
        getAllowedHttpHookUrls: () => [],
        getAllowPrivateNetworkHooks: () => false,
        getSystemHooks: () => undefined,
        getUserHooks: () => ({
          [HookEventName.PreToolUse]: [
            {
              hooks: [
                {
                  type: HookType.Function,
                  id: 'recorder',
                  errorMessage: 'recorder failed',
                  callback: async (input: HookInput) => {
                    events.push(input);
                    return undefined;
                  },
                },
              ],
            },
          ],
        }),
        getProjectHooks: () => undefined,
        getExtensions: () => [],
        getSessionSourceType: () => undefined,
        getSessionSourceId: () => undefined,
        getTranscriptPath: () => '/tmp/transcript',
        getWorkingDir: () => '/tmp',
        getProjectRoot: () => '/tmp',
        getApprovalMode: () => 'default',
        getMessageBus: () => undefined,
        getHookSystem: (): HookSystem => system,
        isTrustedFolder: () => true,
      } as unknown as Config;
      const system = new HookSystem(config);
      await system.initialize();
      const localEvents: HookInput[] = [];
      system.getRegistry().addAgentHooks(
        {
          [HookEventName.PreToolUse]: [
            {
              hooks: [
                {
                  type: HookType.Function,
                  id: 'caller-local',
                  errorMessage: 'local failed',
                  callback: async (input: HookInput) => {
                    localEvents.push(input);
                    return undefined;
                  },
                },
              ],
            },
          ],
        },
        'caller-registration',
        {
          owner: {
            sessionId: 'session',
            agentId: 'caller-A',
          },
        },
      );
      const owner = {
        runtimeId: system.runtimeId,
        sessionId: 'session',
        agentId: caller,
      };
      const core = runWithHookExecutionOwner(
        owner,
        () =>
          new AgentCore(
            'internal-fork',
            config,
            { systemPrompt: '' },
            { model: 'test' },
            { max_turns: 1 },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            explicit,
          ),
      );
      await core.runInAgentFrames(() =>
        system.firePreToolUseEvent(
          'read_file',
          {},
          'tool',
          PermissionMode.Default,
        ),
      );
      expect(localEvents).toHaveLength(expected === 'caller-A' ? 1 : 0);
      expect(events).toHaveLength(1);
      expect(events[0].session_id).toBe('session');
      if (expected === null) expect(events[0]).not.toHaveProperty('agent_id');
      else expect(events[0].agent_id).toBe(expected);
    },
  );

  it('pins hook ownership to the core across foreign frames and deferred approval', async () => {
    let sessionId = 'original-session';
    const config = {
      getSessionId: () => sessionId,
      getHookSystem: () => ({ runtimeId: 'own-runtime' }),
    } as unknown as Config;
    const foreign = {
      runtimeId: 'foreign-runtime',
      sessionId: 'foreign-session',
      agentId: 'B',
    };
    const core = runWithHookExecutionOwner(
      foreign,
      () =>
        new AgentCore(
          'A',
          config,
          { systemPrompt: '' },
          { model: 'test' },
          { max_turns: 1 },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'actual-A',
        ),
    );
    const expected = {
      runtimeId: 'own-runtime',
      sessionId: 'original-session',
      agentId: 'actual-A',
    };
    sessionId = 'later-session';
    let resume: (() => Promise<void>) | undefined;
    await runWithAgentContext('general-parent', () =>
      runWithHookExecutionOwner(foreign, async () => {
        const depth = getCurrentAgentDepth();
        await core.runInHookFrame(async () => {
          await Promise.resolve();
          expect(getHookExecutionOwner()).toEqual(expected);
          expect(getCurrentAgentId()).toBe('general-parent');
          expect(getCurrentAgentDepth()).toBe(depth);
          resume = () =>
            core.runInAgentFrames(async () => {
              await Promise.resolve();
              expect(getHookExecutionOwner()).toEqual(expected);
            });
        });
        expect(getHookExecutionOwner()).toEqual(foreign);
        await resume!();
        expect(getHookExecutionOwner()).toEqual(foreign);
        expect(getCurrentAgentDepth()).toBe(depth);
      }),
    );
    expect(getHookExecutionOwner()).toBeUndefined();
  });

  it('binds the running chat for Advisor and restores it during approval continuation', async () => {
    const core = makeCore('child');
    const chat = {} as LlmChat;
    let continuation: (() => Promise<void>) | undefined;
    vi.spyOn(
      core as unknown as {
        _runReasoningLoopInner: () => Promise<ReasoningLoopResult>;
      },
      '_runReasoningLoopInner',
    ).mockImplementation(async () => {
      expect(getCurrentAgentChat()).toBe(chat);
      continuation = () =>
        core.runInAgentFrames(async () => {
          expect(getCurrentAgentChat()).toBe(chat);
        });
      return { text: 'done' } as ReasoningLoopResult;
    });
    await core.runReasoningLoop(chat, [], [], new AbortController());
    expect(getCurrentAgentChat()).toBeUndefined();
    await continuation!();
    await runWithAgentChat(chat, () =>
      makeCore('other').runInAgentFrames(async () => {
        expect(getCurrentAgentChat()).toBeUndefined();
      }),
    );
  });

  it('publishes the per-agent disallowedTools blocklist, shadowing any parent frame', async () => {
    // AgentTool's fork reads this frame (getCurrentAgentDisallowedTools) so
    // the parent's blocklist survives one level down (R24-1). Mutation
    // check: removing the runWithAgentDisallowedTools wrap in
    // runInAgentFrames turns the first assertion red. A nested agent with no
    // blocklist of its own must shadow, not inherit, the parent's frame.
    const blocked = makeCore('blocked-agent', undefined, undefined, undefined, {
      tools: ['*'],
      disallowedTools: ['mcp__slack'],
    });
    const plain = makeCore('plain-agent');

    await runWithAgentDisallowedTools(['outer__blocked'], async () => {
      expect(await observeIn(blocked, getCurrentAgentDisallowedTools)).toEqual([
        'mcp__slack',
      ]);
      expect(
        await observeIn(plain, getCurrentAgentDisallowedTools),
      ).toBeUndefined();
    });
  });

  it('publishes the configured tool allowlist, shadowing any parent frame', async () => {
    const restricted = makeCore(
      'restricted-agent',
      undefined,
      undefined,
      undefined,
      { tools: [ToolNames.READ_FILE, ToolNames.TOOL_CALL] },
    );
    const plain = makeCore('plain-agent');

    await runWithAgentConfiguredToolAllowlist(['outer_tool'], async () => {
      expect(
        await observeIn(restricted, getCurrentAgentConfiguredToolAllowlist),
      ).toEqual([ToolNames.READ_FILE, ToolNames.TOOL_CALL]);
      expect(
        await observeIn(plain, getCurrentAgentConfiguredToolAllowlist),
      ).toBeUndefined();
    });
  });

  it('keeps the stable telemetry name and exposes task identity locally', async () => {
    const core = makeCore(
      'general-purpose',
      undefined,
      'fix token panel bug',
      'general-purpose-stable',
    );

    const { name, identity } = await observeIn(core, () => ({
      name: subagentNameContext.getStore(),
      identity: subagentIdentityContext.getStore(),
    }));

    expect(name).toBe('general-purpose');
    expect(identity).toMatchObject({
      type: 'general-purpose',
      taskName: 'fix token panel bug',
    });
    expect(identity?.id).toBe('general-purpose-stable');
  });

  it('publishes both the runtime view and the agent name when invoked from outside any frame', async () => {
    const view = makeView('agent-model');

    const observed = await observeIn(makeCore('image-agent', view), frameView);

    expect(observed.view).toBe(view);
    expect(observed.name).toBe('image-agent');
  });

  it('restores frames even when called from a fresh async chain (deferred-approval path)', async () => {
    // Without `runInAgentFrames` re-entering, the body would see the
    // top-level (parent) view. The emitted `respond` closure uses the same
    // wrap as the one built here inside the reasoning-loop frame.
    const view = makeView('agent-model');
    const core = makeCore('approval-agent', view);
    const invocations: Array<ReturnType<typeof frameView>> = [];

    await resumeLater(
      core,
      (emit) => core.runInAgentFrames(emit),
      () => [],
      () => {
        // After the loop frame has unwound, neither frame is active.
        expect(getRuntimeContentGenerator()).toBeUndefined();
        expect(subagentNameContext.getStore()).toBeUndefined();
      },
      () => invocations.push(frameView()),
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.view).toBe(view);
    expect(invocations[0]!.name).toBe('approval-agent');
  });

  it('still publishes the agent name when no runtime view is set (inheriting agent)', async () => {
    const observed = await observeIn(makeCore('inherit-agent'), frameView);

    expect(observed.view).toBeUndefined();
    expect(observed.name).toBe('inherit-agent');
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
    // checking modalities) need the parent's view. The reasoning loop sees
    // it via ALS, but the deferred-approval `respond` callback runs from a
    // fresh async chain where that frame is gone, so the agent must capture
    // it at emit time and pass it back through.
    const parentView = makeView('parent-model');

    const observed = await resumeLater(
      makeCore('inherit-agent'),
      (emit) => runWithRuntimeContentGenerator(parentView, emit),
      () => [getRuntimeContentGenerator()],
      () => expect(getRuntimeContentGenerator()).toBeUndefined(),
      frameView,
    );

    expect(observed.view).toBe(parentView);
    expect(observed.name).toBe('inherit-agent');
  });

  it('restores the logical agent id for deferred-approval continuations', async () => {
    const observed = await resumeLater(
      makeCore('approval-agent'),
      (emit) => runWithAgentContext('agent-123', emit),
      () => [undefined, getCurrentAgentId() ?? undefined],
      () => expect(getCurrentAgentId()).toBeNull(),
      getCurrentAgentId,
    );

    expect(observed).toBe('agent-123');
  });

  it('restores the nesting depth for deferred-approval continuations', async () => {
    // Regression (codex review): the respond closure captured only the agent
    // id, so runWithAgentContext recomputed depth 0 from the UI's frame-less
    // chain, and a deferred-approved `agent` tool call from a leaf-depth
    // sub-agent would bypass maxSubagentDepth. The closure must carry the
    // depth captured at emit time.
    const observed = await resumeLater(
      makeCore('approval-agent'),
      // Emit from a nested frame (depth 2): a sub-agent of a sub-agent whose
      // tool call parks for approval.
      (emit) =>
        runWithAgentContext('lvl1', () =>
          runWithAgentContext('lvl2', () => runWithAgentContext('lvl3', emit)),
        ),
      () => {
        const inheritedAgentDepth = getCurrentAgentDepth();
        expect(inheritedAgentDepth).toBe(2);
        return [
          undefined,
          getCurrentAgentId() ?? undefined,
          undefined,
          inheritedAgentDepth,
        ];
      },
      () => expect(getCurrentAgentId()).toBeNull(),
      getCurrentAgentDepth,
    );

    expect(observed).toBe(2);
  });

  it('restores the teammate identity for deferred-approval continuations', async () => {
    // Regression: a teammate's `send_message`/`task_update` that requires
    // confirmation resumes from the UI's async chain, outside the teammate
    // identity frame TeamManager established. Before the fix `getAgentName()`
    // returned undefined there and send_message fell back to the leader,
    // forging a `from="leader"` envelope and slipping past the leader-only
    // `isTeammate()` guard. The respond closure must carry the identity
    // captured at emit time back into the resumed tool body.
    const observed = await resumeLater(
      makeCore('approval-agent'),
      (emit) => runWithTeammateIdentity(teammate('scribe', 'demo'), emit),
      () => [undefined, undefined, getTeammateContext()],
      () => {
        expect(getAgentName()).toBeUndefined();
        expect(isTeammate()).toBe(false);
      },
      () => ({ agentName: getAgentName(), isTeammate: isTeammate() }),
    );

    expect(observed.agentName).toBe('scribe');
    expect(observed.isTeammate).toBe(true);
  });

  it("prefers the agent's own view over inheritedView when both are present", async () => {
    // Defensive: if a future caller wires both, the agent's explicit view
    // wins; a captured snapshot must never override its declared view.
    const ownView = makeView('own-model');

    const observed = await observeIn(
      makeCore('own-view-agent', ownView),
      getRuntimeContentGenerator,
      makeView('other-model', 'openai'),
    );

    expect(observed).toBe(ownView);
  });
});

describe('AgentCore approval response deduplication', () => {
  type Scheduler = {
    onToolCallsUpdate?: (calls: ToolCall[]) => void;
    onAllToolCallsComplete?: (calls: ToolCall[]) => Promise<void>;
    isToolExecutionAllowed?: (name: string) => boolean;
  };
  type Request = {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    prompt_id: string;
  };
  type Call = { id: string; name: string; args: Record<string, unknown> };

  /** `<slug>-agent` with session `<slug>-session`; `overrides` patch the config. */
  function buildCore(
    slug = 'approval',
    toolConfig?: ToolConfig,
    overrides: Record<string, unknown> = {},
  ): { core: AgentCore; errorSpy: ReturnType<typeof vi.fn> } {
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
      getSessionId: vi.fn().mockReturnValue(`${slug}-session`),
      ...overrides,
    } as unknown as Config;
    const core = new AgentCore(
      `${slug}-agent`,
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      toolConfig,
    );
    return { core, errorSpy };
  }

  const request = (
    slug: string,
    name = 'Shell',
    args: Record<string, unknown> = { command: 'git status' },
  ) => ({
    callId: `call-${slug}`,
    name,
    args,
    isClientInitiated: true,
    prompt_id: `prompt-${slug}`,
  });
  const execWaiting = (
    req: Request,
    onConfirm: unknown = vi.fn(async () => {}),
  ) =>
    ({
      status: 'awaiting_approval',
      request: req,
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
        onConfirm,
      },
    }) as unknown as WaitingToolCall;
  const hookWaiting = (req: Request, onConfirm: unknown) =>
    ({
      status: 'awaiting_approval',
      request: req,
      confirmationDetails: {
        type: 'info',
        title: 'Hook confirmation',
        prompt: 'Approve bounced execution?',
        onConfirm,
      },
    }) as unknown as WaitingToolCall;
  const scheduled = (req: Request, status = 'scheduled') =>
    ({ status, request: req }) as unknown as ToolCall;

  const directCall = (req: Request): Call => ({
    id: req.callId,
    name: req.name,
    args: req.args,
  });
  /** The model-facing tool_call wrapper that bridges to `req`'s target. */
  const bridgedCall = (req: Request): Call => ({
    id: req.callId,
    name: ToolNames.TOOL_CALL,
    args: { name: req.name, arguments: req.args },
  });

  const onApproval = (
    core: AgentCore,
    listener: (event: AgentApprovalRequestEvent) => void,
  ) =>
    core.getEventEmitter().on(AgentEventType.TOOL_WAITING_APPROVAL, listener);
  function collectApprovals(core: AgentCore) {
    const events: AgentApprovalRequestEvent[] = [];
    onApproval(core, (event) => {
      events.push(event);
    });
    return events;
  }
  function recordToolEvents(core: AgentCore) {
    const calls: AgentToolCallEvent[] = [];
    const results: AgentToolResultEvent[] = [];
    const order: string[] = [];
    core.getEventEmitter().on(AgentEventType.TOOL_CALL, (event) => {
      calls.push(event);
      order.push(`call:${event.name}`);
    });
    core.getEventEmitter().on(AgentEventType.TOOL_RESULT, (event) => {
      results.push(event);
      order.push(`result:${event.name}`);
    });
    return { calls, results, order };
  }
  /** A listener that always throws the same error. */
  const throwing = (message: string) => {
    const error = new Error(message);
    return vi.fn(() => {
      throw error;
    });
  };
  /** A listener that throws `error` on its first call only. */
  const failOnce = (error: Error) => {
    let shouldThrow = true;
    return vi.fn(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw error;
      }
    });
  };

  /** Stubs schedule() to replay `batches` through onToolCallsUpdate. */
  function mockScheduleUpdates(batches: ToolCall[][], gate?: Promise<void>) {
    return vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        if (gate) await gate;
        for (const calls of batches) {
          (this as unknown as Scheduler).onToolCallsUpdate?.(calls);
        }
      });
  }
  /** The scheduler instance the active schedule() stub was called on. */
  const currentScheduler = () =>
    vi.mocked(CoreToolScheduler.prototype.schedule).mock
      .instances[0] as unknown as Scheduler;

  function startCall(core: AgentCore, call: Call, promptId: string) {
    const abortController = new AbortController();
    const processing = core.processFunctionCalls(
      [call],
      abortController,
      promptId,
      1,
      [{ name: call.name } as FunctionDeclaration],
    );
    return { abortController, processing };
  }

  // Processes `req` with schedule() replaying `batches` and runs `body`
  // while the call is in flight; then aborts, drains, restores schedule()
  // and real timers.
  async function whileScheduled(
    core: AgentCore,
    req: Request,
    batches: ToolCall[][],
    body: (run: ReturnType<typeof startCall>) => Promise<void> | void,
    toCall = directCall,
  ) {
    const scheduleSpy = mockScheduleUpdates(batches);
    const run = startCall(core, toCall(req), req.prompt_id);
    try {
      await body(run);
    } finally {
      run.abortController.abort();
      await run.processing;
      scheduleSpy.mockRestore();
      vi.useRealTimers();
    }
  }

  // Runs `call` for a `<slug>` core with schedule() stubbed to capture the
  // isToolExecutionAllowed predicate it was handed, then aborts.
  async function capturePredicate(
    slug: string,
    toolConfig: ToolConfig,
    call: Omit<Call, 'id'>,
    overrides?: Record<string, unknown>,
  ): Promise<((name: string) => boolean) | undefined> {
    const { core } = buildCore(slug, toolConfig, overrides);
    let capturedPredicate: ((name: string) => boolean) | undefined;
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockImplementation(async function (this: CoreToolScheduler) {
        capturedPredicate = (this as unknown as Scheduler)
          .isToolExecutionAllowed;
      });
    const { abortController, processing } = startCall(
      core,
      { id: `call-${slug}`, ...call },
      `prompt-${slug}`,
    );
    await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledOnce());
    abortController.abort();
    await processing;
    scheduleSpy.mockRestore();
    return capturedPredicate;
  }
  const bridgeTo = (target: string) => ({
    name: ToolNames.TOOL_CALL,
    args: { name: target, arguments: {} },
  });

  it('emits scheduler-resolved tool identity for bridged calls', async () => {
    const { core } = buildCore();
    const { calls, results } = recordToolEvents(core);
    const targetRequest = {
      ...request('bridge', 'mcp__docs__read', { path: 'README.md' }),
      modelFacingName: ToolNames.TOOL_CALL,
      modelFacingArgs: {
        name: 'mcp__docs__read',
        arguments: { path: 'README.md' },
      },
    };

    await whileScheduled(
      core,
      targetRequest,
      [[scheduled(targetRequest)]],
      async () => {
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toMatchObject({
          callId: targetRequest.callId,
          name: targetRequest.name,
          args: targetRequest.args,
          modelFacingName: ToolNames.TOOL_CALL,
          modelFacingArgs: {
            name: targetRequest.name,
            arguments: targetRequest.args,
          },
        });
      },
      bridgedCall,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      callId: targetRequest.callId,
      name: targetRequest.name,
      success: false,
    });
    expect(results[0].responseParts?.[0]?.functionResponse?.name).toBe(
      ToolNames.TOOL_CALL,
    );
  });

  it('emits a wrapper TOOL_CALL before a bridge cancellation on abort', async () => {
    // The abort lands BEFORE the scheduler resolves the target. Persist the
    // model-facing wrapper call before its synthetic cancellation, then ignore
    // the scheduler's late resolved-target update.
    const { core } = buildCore();
    const { calls, results, order } = recordToolEvents(core);
    const targetRequest = request('bridge-aborted', 'mcp__docs__read', {
      path: 'README.md',
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    // Hold the first update until after the abort has run.
    const scheduleSpy = mockScheduleUpdates(
      [[scheduled(targetRequest)]],
      updateGate,
    );
    const { abortController, processing } = startCall(
      core,
      bridgedCall(targetRequest),
      targetRequest.prompt_id,
    );

    await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledOnce());
    abortController.abort();
    releaseUpdate();
    await processing;
    scheduleSpy.mockRestore();

    expect(order).toEqual([
      `call:${ToolNames.TOOL_CALL}`,
      `result:${ToolNames.TOOL_CALL}`,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callId: targetRequest.callId,
      name: ToolNames.TOOL_CALL,
      args: {
        name: targetRequest.name,
        arguments: targetRequest.args,
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      callId: targetRequest.callId,
      success: false,
    });
    expect(results[0].responseParts?.[0]?.functionResponse?.name).toBe(
      ToolNames.TOOL_CALL,
    );
  });

  it('passes the execution allowlist to the scheduler for bridged targets', async () => {
    // The pre-schedule gates only see the wrapper name (tool_call), which a
    // fork's allowlist always contains; the scheduler must be given a
    // predicate bound to the same allowlist to re-check resolved targets.
    const capturedPredicate = await capturePredicate(
      'allowlist',
      {
        tools: ['*'],
        executionAllowedTools: [
          ToolNames.TOOL_CALL,
          ToolNames.TOOL_SEARCH,
          'read_file',
        ],
      },
      bridgeTo('web_fetch'),
    );

    expect(capturedPredicate).toBeDefined();
    expect(capturedPredicate?.('web_fetch')).toBe(false);
    expect(capturedPredicate?.('read_file')).toBe(true);
    expect(capturedPredicate?.(ToolNames.TOOL_CALL)).toBe(true);
  });

  it('folds the configured tool allowlist into the bridged-target re-check', async () => {
    const capturedPredicate = await capturePredicate(
      'configured-allowlist',
      {
        tools: [
          ToolNames.READ_FILE,
          ToolNames.TOOL_SEARCH,
          ToolNames.TOOL_CALL,
        ],
      },
      bridgeTo('mcp__slack__post_message'),
    );

    expect(capturedPredicate).toBeDefined();
    expect(capturedPredicate?.('mcp__slack__post_message')).toBe(false);
    expect(capturedPredicate?.(ToolNames.READ_FILE)).toBe(true);
    expect(capturedPredicate?.(ToolNames.TOOL_CALL)).toBe(true);
  });

  it('folds the per-agent disallowedTools blocklist into the bridged-target re-check', async () => {
    // R6-8: the tool_call bridge resolves around the declaration list, so
    // the disallowedTools blocklist prepareTools applies to declarations
    // must be re-checked at invocation level, symmetrically to the
    // execution allowlist above. Without this fold a subagent configured
    // with disallowedTools: ['mcp__slack'] could bridge-execute
    // mcp__slack__post_message even though prepareTools filtered it out of
    // the declarations. Mutation check: removing the blocklist fold from
    // isToolExecutionAllowed turns this test red.
    const capturedPredicate = await capturePredicate(
      'blocklist',
      { tools: ['*'], disallowedTools: ['mcp__slack', ToolNames.TODO_WRITE] },
      bridgeTo('mcp__slack__post_message'),
    );

    expect(capturedPredicate).toBeDefined();
    // Server-level MCP pattern blocks every tool of that server…
    expect(capturedPredicate?.('mcp__slack__post_message')).toBe(false);
    expect(capturedPredicate?.('mcp__slack')).toBe(false);
    // …without touching other servers.
    expect(capturedPredicate?.('mcp__github__create_issue')).toBe(true);
    // Exact-match blocklisting for non-MCP tools.
    expect(capturedPredicate?.(ToolNames.TODO_WRITE)).toBe(false);
    expect(capturedPredicate?.('read_file')).toBe(true);
    expect(capturedPredicate?.(ToolNames.TOOL_CALL)).toBe(true);
  });

  it('lets disallowedTools beat the execution allowlist for bridged targets', async () => {
    // R7-13: the two policy lists must compose with the blocklist winning;
    // an allowlist entry cannot re-admit a tool the agent's disallowedTools
    // removes. Mutation check: moving the blocklist fold after the allowlist
    // pass (or dropping it) turns this red.
    const capturedPredicate = await capturePredicate(
      'precedence',
      {
        tools: ['*'],
        executionAllowedTools: [
          ToolNames.TOOL_CALL,
          ToolNames.TOOL_SEARCH,
          'mcp__slack__post_message',
        ],
        disallowedTools: ['mcp__slack'],
      },
      bridgeTo('mcp__slack__post_message'),
    );

    expect(capturedPredicate).toBeDefined();
    // Allowlisted AND blocklisted → blocklist wins.
    expect(capturedPredicate?.('mcp__slack__post_message')).toBe(false);
    // Allowlisted and not blocklisted → allowed.
    expect(capturedPredicate?.(ToolNames.TOOL_CALL)).toBe(true);
  });

  it.each([ToolNames.EXEC, ToolNames.TOOL_SEARCH])(
    'keeps %s invocable in CodeModeOnly when the configured tools omit it',
    async (gateway) => {
      // R30-1: in CodeModeOnly the registry declares exec unconditionally
      // (getCodeModeFunctionDeclarations keeps exposure 'exec' regardless of
      // the allowed set), so a finite tools list without exec must not fold
      // into an execution allowlist that refuses the only declared tool — the
      // agent would degrade to text-only. Mutation check: removing the exec
      // carve-out from the executionAllowedTools === undefined branch of
      // isToolExecutionAllowed turns this red.
      const config = {
        getToolRegistry: vi.fn().mockReturnValue({
          warmAll: vi.fn().mockResolvedValue(undefined),
          getTool: vi.fn(),
          getAllToolNames: vi
            .fn()
            .mockReturnValue([ToolNames.EXEC, ToolNames.READ_FILE]),
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([{ name: ToolNames.EXEC }]),
        }),
        getDebugLogger: vi
          .fn()
          .mockReturnValue({ debug: vi.fn(), error: vi.fn() }),
        getToolOutputBatchBudget: vi
          .fn()
          .mockReturnValue(Number.POSITIVE_INFINITY),
        getToolResultBytesWritten: vi.fn().mockReturnValue(0),
        getSessionId: vi.fn().mockReturnValue('code-mode-exec-session'),
        getMaxSubagentDepth: vi.fn().mockReturnValue(5),
        getToolMode: vi.fn().mockReturnValue(ToolMode.CodeModeOnly),
      } as unknown as Config;
      const core = new AgentCore(
        'code-mode-exec-agent',
        config,
        { systemPrompt: '' },
        { model: 'test-model' },
        { max_turns: 1 },
        { tools: [ToolNames.READ_FILE] },
      );

      let capturedPredicate: ((name: string) => boolean) | undefined;
      const scheduleSpy = vi
        .spyOn(CoreToolScheduler.prototype, 'schedule')
        .mockImplementation(async function (this: CoreToolScheduler) {
          capturedPredicate = (
            this as unknown as {
              isToolExecutionAllowed?: (name: string) => boolean;
            }
          ).isToolExecutionAllowed;
        });
      const abortController = new AbortController();

      const processing = core.processFunctionCalls(
        [
          {
            id: 'call-code-mode-exec',
            name: gateway,
            args: { source: 'await tools.read_file({ path: "x" })' },
          },
        ],
        abortController,
        'prompt-code-mode-exec',
        1,
        [{ name: gateway } as FunctionDeclaration],
      );
      await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledOnce());
      expect(scheduleSpy.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          name: gateway,
          codeModeAllowedToolNames: [ToolNames.READ_FILE],
        }),
      ]);
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();

      expect(capturedPredicate).toBeDefined();
      // The one tool code mode always declares stays invocable …
      expect(capturedPredicate?.(gateway)).toBe(true);
      // … without widening the configured list for anything else.
      expect(capturedPredicate?.('web_fetch')).toBe(false);
    },
  );

  it('retries only a transiently failed listener', async () => {
    const { core, errorSpy } = buildCore();
    const deliveryError = new Error('approval listener failed');
    const transientListener = failOnce(deliveryError);
    onApproval(core, transientListener);
    const approvalEvents = collectApprovals(core);
    const req = request('retry');

    await whileScheduled(core, req, [[execWaiting(req)]], async () => {
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
    });
  });

  it('continues past a thrower before a healthy listener', async () => {
    const { core } = buildCore();
    const thrower = throwing('approval listener always fails');
    onApproval(core, thrower);
    const healthyListener = vi.fn();
    onApproval(core, healthyListener);
    const req = request('bounded-retry');

    await whileScheduled(core, req, [[execWaiting(req)]], () => {
      expect(thrower).toHaveBeenCalledOnce();
      expect(healthyListener).toHaveBeenCalledOnce();
    });
  });

  it('bounds persistent listener retries and reports exhaustion', async () => {
    vi.useFakeTimers();
    const { core, errorSpy } = buildCore();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const thrower = throwing('approval listener always fails');
    onApproval(core, thrower);
    const req = request('bounded-retry');
    const waiting = execWaiting(req);

    try {
      await whileScheduled(core, req, [[waiting]], async () => {
        await vi.runAllTimersAsync();
        expect(thrower).toHaveBeenCalledTimes(3);
        expect(errorSpy).toHaveBeenCalledTimes(3);
        expect(consoleErrorSpy).toHaveBeenCalledOnce();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Approval event delivery for call-bounded-retry exhausted 3 attempts for 1 listener',
          ),
        );
        const sibling = {
          ...req,
          callId: 'call-sibling',
          args: { command: 'pwd' },
        };
        currentScheduler().onToolCallsUpdate?.([waiting, scheduled(sibling)]);
        currentScheduler().onToolCallsUpdate?.([
          waiting,
          scheduled(sibling, 'executing'),
        ]);
        expect(thrower).toHaveBeenCalledTimes(3);
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('cancels a pending delivery retry when the approval settles', async () => {
    vi.useFakeTimers();
    const { core } = buildCore();
    let attempts = 0;
    onApproval(core, () => {
      attempts++;
      throw new Error('approval listener failed');
    });
    const req = request('settled-retry');

    await whileScheduled(core, req, [[execWaiting(req)], []], async () => {
      await vi.runAllTimersAsync();
      expect(attempts).toBe(1);
    });
  });

  it('does not duplicate a healthy listener before a failed listener', async () => {
    const { core } = buildCore();
    const retainedEvents = collectApprovals(core);
    const transientListener = failOnce(new Error('later listener failed'));
    onApproval(core, transientListener);
    let retryEvent: AgentApprovalRequestEvent | undefined;
    onApproval(core, (event) => {
      retryEvent = event;
    });
    const onConfirm = vi.fn(async () => {});
    const req = request('partial-delivery');

    await whileScheduled(
      core,
      req,
      [[execWaiting(req, onConfirm)]],
      async () => {
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
      },
    );
  });

  it('cancels a pending delivery retry on abort', async () => {
    vi.useFakeTimers();
    const { core } = buildCore();
    const thrower = throwing('approval listener failed');
    onApproval(core, thrower);
    const req = request('aborted-retry');

    await whileScheduled(
      core,
      req,
      [[execWaiting(req)]],
      async ({ abortController, processing }) => {
        expect(thrower).toHaveBeenCalledOnce();
        abortController.abort();
        await processing;
        await vi.runAllTimersAsync();
        expect(thrower).toHaveBeenCalledOnce();
      },
    );
  });

  it('cancels a pending delivery retry when all tool calls complete', async () => {
    vi.useFakeTimers();
    const { core } = buildCore();
    const thrower = throwing('approval listener failed');
    onApproval(core, thrower);
    const req = request('completed-retry');

    await whileScheduled(
      core,
      req,
      [[execWaiting(req)]],
      async ({ processing }) => {
        expect(thrower).toHaveBeenCalledOnce();
        await currentScheduler().onAllToolCallsComplete?.([]);
        await processing;
        await vi.runAllTimersAsync();
        expect(thrower).toHaveBeenCalledOnce();
      },
    );
  });

  it('rejects an old approval after the call bounces to a new incarnation', async () => {
    const { core } = buildCore();
    const approvalEvents = collectApprovals(core);
    const firstOnConfirm = vi.fn(async () => {});
    const secondOnConfirm = vi.fn(async () => {});
    const req = request('stale-approval');

    await whileScheduled(
      core,
      req,
      [[execWaiting(req, firstOnConfirm)]],
      async () => {
        await vi.waitFor(() => expect(approvalEvents).toHaveLength(1));
        currentScheduler().onToolCallsUpdate?.([
          hookWaiting(req, secondOnConfirm),
        ]);
        await vi.waitFor(() => expect(approvalEvents).toHaveLength(2));

        await approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce);
        await approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce);

        expect(firstOnConfirm).not.toHaveBeenCalled();
        expect(secondOnConfirm).toHaveBeenCalledOnce();
      },
    );
  });

  it('creates a new approval when the same details become active again', async () => {
    const { core } = buildCore();
    const approvalEvents = collectApprovals(core);
    const onConfirm = vi.fn(async () => {});
    const req = request('reused-details');
    const waiting = execWaiting(req, onConfirm);

    await whileScheduled(core, req, [[waiting]], async () => {
      expect(approvalEvents).toHaveLength(1);
      currentScheduler().onToolCallsUpdate?.([]);
      currentScheduler().onToolCallsUpdate?.([waiting]);
      expect(approvalEvents).toHaveLength(2);

      await approvalEvents[0].respond(ToolConfirmationOutcome.ProceedOnce);
      await approvalEvents[1].respond(ToolConfirmationOutcome.ProceedOnce);

      expect(onConfirm).toHaveBeenCalledOnce();
    });
  });

  it('emits once per approval incarnation and allows each response', async () => {
    const { core } = buildCore();
    const approvalEvents = collectApprovals(core);
    const firstOnConfirm = vi.fn(async () => {});
    const secondOnConfirm = vi.fn(async () => {});
    const req = request('1');
    const secondWaiting = hookWaiting(req, secondOnConfirm);
    const firstWaiting = execWaiting(
      req,
      vi.fn(async () => {
        await firstOnConfirm();
        currentScheduler().onToolCallsUpdate?.([secondWaiting]);
      }),
    );

    await whileScheduled(
      core,
      req,
      [[firstWaiting], [firstWaiting]],
      async () => {
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
      },
    );
  });
});

describe('AgentCore.processFunctionCalls incomplete-argument marker', () => {
  it('forwards hadIncompleteArguments when the turn was not token-truncated', async () => {
    const config = {
      getToolRegistry: vi.fn().mockReturnValue({ getTool: vi.fn() }),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), error: vi.fn() }),
      getToolOutputBatchBudget: vi
        .fn()
        .mockReturnValue(Number.POSITIVE_INFINITY),
      getToolResultBytesWritten: vi.fn().mockReturnValue(0),
      getSessionId: vi.fn().mockReturnValue('incomplete-args-session'),
    } as unknown as Config;
    const core = new AgentCore(
      'incomplete-args-agent',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
    );

    const functionCall = {
      id: 'call-incomplete',
      name: 'write_file',
      args: { file_path: 'a.txt', content: 'half-written' },
    };
    markToolCallArgumentsIncomplete([{ functionCall }]);
    // Negative control: an unmarked sibling must reach the scheduler WITHOUT
    // hadIncompleteArguments, or over-application of the marker (which would
    // reject every subagent Edit call) is undetectable.
    const cleanFunctionCall = {
      id: 'call-clean',
      name: 'write_file',
      args: { file_path: 'b.txt', content: 'complete' },
    };

    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockResolvedValue(undefined);
    const abortController = new AbortController();

    const processing = core.processFunctionCalls(
      [functionCall, cleanFunctionCall],
      abortController,
      'prompt-incomplete',
      1,
      [{ name: 'write_file' } as FunctionDeclaration],
      undefined,
      // The subagent turn saw finishReason STOP (delayed usage disproved a
      // token cut), so the marker is the only thing left that can arm the
      // scheduler's data-loss guard here — a subagent has no approval prompt
      // between the response and the write (#12970).
      false,
    );
    try {
      await vi.waitFor(() => expect(scheduleSpy).toHaveBeenCalledOnce());
      const scheduledRequests = scheduleSpy.mock.calls[0]?.[0];
      expect(scheduledRequests).toEqual([
        expect.objectContaining({
          callId: 'call-incomplete',
          name: 'write_file',
          wasOutputTruncated: false,
          hadIncompleteArguments: true,
        }),
        expect.objectContaining({
          callId: 'call-clean',
          name: 'write_file',
          wasOutputTruncated: false,
        }),
      ]);
      expect(Array.isArray(scheduledRequests)).toBe(true);
      expect((scheduledRequests as unknown[])[1]).not.toHaveProperty(
        'hadIncompleteArguments',
      );
    } finally {
      abortController.abort();
      await processing;
      scheduleSpy.mockRestore();
    }
  });
});

describe('AgentCore.prepareTools', () => {
  // Subagents that opt into the wildcard (`tools: ['*']`), or omit
  // toolConfig entirely, must inherit DEFERRED tools too. Otherwise a
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
    config: Config;
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
      config,
      getFunctionDeclarationsSpy,
      getFunctionDeclarationsFilteredSpy,
      isPermissionDeferredSpy,
      isDeferredAndHiddenSpy,
    };
  }

  const decl = (name: string, description?: string) =>
    (description === undefined
      ? { name }
      : { name, description }) as FunctionDeclaration;
  const planDecls = () => [
    decl(ToolNames.ENTER_PLAN_MODE, 'enter plan mode'),
    decl(ToolNames.EXIT_PLAN_MODE, 'exit plan mode'),
  ];
  const namesOf = (tools: FunctionDeclaration[]) => tools.map((t) => t.name);

  it.each([true, false])(
    'exposes worker task_stop only to contained agents (container=%s)',
    async (contained) => {
      const { core, config } = buildAgentForTools(undefined, [
        { name: ToolNames.TASK_STOP },
      ]);
      config.getExecutionEnvironment = () =>
        contained ? ({} as ExecutionEnvironment) : undefined;
      expect(namesOf(await core.prepareTools())).toEqual(
        contained ? [ToolNames.TASK_STOP] : [],
      );
    },
  );

  it('wildcard tools:["*"] inherits deferred tools (passes includeDeferred: true)', async () => {
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      { tools: ['*'] },
      [
        decl('core_tool', 'core'),
        decl('mcp__github__create_issue', 'mcp deferred'),
      ],
    );

    const tools = await core.prepareTools();

    // The critical assertion: includeDeferred: true was used. Without it
    // a refactor could silently downgrade to the default which excludes
    // deferred tools, breaking subagent configs that depend on MCP.
    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
    });
    // Sanity: declared MCP tool is present in the agent's tool list.
    expect(namesOf(tools)).toEqual(
      expect.arrayContaining(['core_tool', 'mcp__github__create_issue']),
    );
  });

  it('absent toolConfig also inherits deferred tools (default = wildcard)', async () => {
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(undefined, [
      decl('lsp', 'language server'),
      ...planDecls(),
    ]);

    const tools = await core.prepareTools();

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
    });
    expect(namesOf(tools)).toEqual(['lsp']);
  });

  it('explicit empty tools array denies all tools (does not inherit)', async () => {
    // An explicit `tools: []` is the documented deny-all contract (e.g.
    // single-turn text-output agents); it must not fall into the wildcard
    // inherit branch, or a no-tools agent silently runs with the full
    // registry under forced auto-approval.
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      { tools: [] },
      [
        { name: 'core_tool', description: 'core' } as FunctionDeclaration,
        {
          name: 'mcp__github__create_issue',
          description: 'mcp deferred',
        } as FunctionDeclaration,
      ],
    );

    const tools = await core.prepareTools();

    expect(tools).toEqual([]);
    expect(getFunctionDeclarationsSpy).not.toHaveBeenCalled();
  });

  it('explicit empty tools array denies all tools in CodeModeOnly', async () => {
    const config = {
      getToolRegistry: vi.fn().mockReturnValue({
        warmAll: vi.fn().mockResolvedValue(undefined),
        getAllToolNames: vi
          .fn()
          .mockReturnValue([ToolNames.EXEC, ToolNames.READ_FILE]),
        getFunctionDeclarationsFiltered: vi.fn((names: string[]) =>
          [ToolNames.EXEC, ToolNames.READ_FILE]
            .filter((name) => names.includes(name))
            .map((name) => ({ name }) as FunctionDeclaration),
        ),
        isPermissionDeferred: vi.fn().mockReturnValue(false),
        isDeferredAndHidden: vi.fn().mockReturnValue(false),
      }),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), error: vi.fn() }),
      getToolOutputBatchBudget: vi
        .fn()
        .mockReturnValue(Number.POSITIVE_INFINITY),
      getToolResultBytesWritten: vi.fn().mockReturnValue(0),
      getSessionId: vi.fn().mockReturnValue('code-mode-empty-tools'),
      getMaxSubagentDepth: vi.fn().mockReturnValue(5),
      getToolMode: vi.fn().mockReturnValue(ToolMode.CodeModeOnly),
    } as unknown as Config;
    const core = new AgentCore(
      'code-mode-empty-tools-agent',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      { tools: [] },
    );

    await expect(core.prepareTools()).resolves.toEqual([]);
  });

  it.each(['subagent', 'teammate'])(
    'excludes parent-owned record_source from a reused registry in a %s',
    async (context) => {
      const { core } = buildAgentForTools({ tools: ['*'] }, [
        { name: ToolNames.RECORD_SOURCE },
        { name: ToolNames.READ_FILE },
      ]);

      const prepareTools = () => core.prepareTools();
      const tools =
        context === 'subagent'
          ? await runWithAgentContext('workflow-subagent', prepareTools)
          : await runWithTeammateIdentity(
              teammate('scribe', 'demo'),
              prepareTools,
            );

      expect(namesOf(tools)).toEqual([ToolNames.READ_FILE]);
    },
  );

  it('explicit tools list does NOT use the wildcard inherit path', async () => {
    // When the subagent enumerates tools by name, deferred-tool inclusion
    // is not the wildcard branch's responsibility (getFunctionDeclarationsFiltered
    // is used instead). This pins that the wildcard arm and the explicit
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
      const { core, isPermissionDeferredSpy, isDeferredAndHiddenSpy } =
        buildAgentForTools(toolConfig, [
          decl('visible'),
          decl('hidden_by_allowlist'),
        ]);
      isPermissionDeferredSpy.mockImplementation(
        (name) => name === 'hidden_by_allowlist',
      );
      isDeferredAndHiddenSpy.mockImplementation(
        (name) => name === 'hidden_by_allowlist',
      );

      const tools = await core.prepareTools();

      expect(namesOf(tools)).toEqual(['visible']);
    },
  );

  it('excludes plan lifecycle tools from wildcard/default subagent tools', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, [
      decl('core_tool', 'core'),
      ...planDecls(),
    ]);

    const tools = await core.prepareTools();

    expect(namesOf(tools)).toEqual(['core_tool']);
  });

  it('does not re-enable plan lifecycle tools via explicit tool names', async () => {
    const { core, debugSpy, getFunctionDeclarationsFilteredSpy } =
      buildAgentForTools(
        {
          tools: [
            ToolNames.READ_FILE,
            ToolNames.ENTER_PLAN_MODE,
            ToolNames.EXIT_PLAN_MODE,
          ],
        },
        [decl(ToolNames.READ_FILE, 'read'), ...planDecls()],
      );

    const tools = await core.prepareTools();

    expect(getFunctionDeclarationsFilteredSpy).toHaveBeenCalledWith([
      ToolNames.READ_FILE,
    ]);
    expect(namesOf(tools)).toEqual([ToolNames.READ_FILE]);
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered "${ToolNames.ENTER_PLAN_MODE}" from explicit subagent tool list`,
    );
    expect(debugSpy).toHaveBeenCalledWith(
      `[prepareTools] Filtered "${ToolNames.EXIT_PLAN_MODE}" from explicit subagent tool list`,
    );
  });

  it('filters inline declarations using the full subagent exclusion floor', async () => {
    const inlineSafe = decl('inline_safe', 'safe inline tool');
    const { core, debugSpy, isPermissionDeferredSpy, isDeferredAndHiddenSpy } =
      buildAgentForTools(
        {
          tools: [
            decl(ToolNames.SEND_MESSAGE),
            decl(ToolNames.TASK_UPDATE),
            decl(ToolNames.ENTER_PLAN_MODE),
            decl(ToolNames.EXIT_PLAN_MODE),
            decl('hidden_by_allowlist', 'hidden'),
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
    for (const name of [
      ToolNames.SEND_MESSAGE,
      ToolNames.TASK_UPDATE,
      ToolNames.ENTER_PLAN_MODE,
      ToolNames.EXIT_PLAN_MODE,
      'hidden_by_allowlist',
    ]) {
      expect(debugSpy).toHaveBeenCalledWith(
        `[prepareTools] Filtered inline declaration "${name}" from subagent tool list`,
      );
    }
  });

  it('keeps teammate coordination tools but excludes plan lifecycle tools', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, [
      decl(ToolNames.SEND_MESSAGE, 'send message'),
      decl(ToolNames.TASK_UPDATE, 'task update'),
      decl(ToolNames.TODO_WRITE, 'TodoWrite'),
      ...planDecls(),
    ]);

    const tools = await runWithTeammateIdentity(teammate('agent', 'test'), () =>
      core.prepareTools(),
    );

    expect(namesOf(tools)).toEqual([
      ToolNames.SEND_MESSAGE,
      ToolNames.TASK_UPDATE,
    ]);
  });

  it('keeps exit_plan_mode for plan-required teammates only', async () => {
    const { core } = buildAgentForTools({ tools: ['*'] }, [
      decl(ToolNames.SEND_MESSAGE, 'send message'),
      ...planDecls(),
    ]);

    const tools = await runWithTeammateIdentity(
      teammate('planner', 'test', { planModeRequired: true }),
      () => core.prepareTools(),
    );

    expect(namesOf(tools)).toEqual([
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
  type Prepare = () => Promise<FunctionDeclaration[]>;
  /** Tool names a read_file + agent registry yields, prepared inside `frame`. */
  async function nestingNames(
    maxSubagentDepth: number,
    frame: (prepare: Prepare) => Promise<FunctionDeclaration[]>,
    tools: string[] = ['*'],
  ) {
    const { core } = buildAgentForTools(
      { tools },
      [decl('read_file', 'read'), decl(ToolNames.AGENT, 'spawn subagent')],
      maxSubagentDepth,
    );
    return namesOf(await frame(() => core.prepareTools()));
  }
  // One frame → getCurrentAgentDepth() === 0 (a top-level sub-agent).
  const inLvl1 = (prepare: Prepare) => runWithAgentContext('lvl1', prepare);

  it('nesting: includes AgentTool for a shallow subagent when depth permits', async () => {
    expect(await nestingNames(5, inLvl1)).toContain(ToolNames.AGENT);
  });

  it('nesting: excludes AgentTool at the leaf depth', async () => {
    // Two nested frames → depth === 1 → level 2 → the leaf when max === 2.
    const names = await nestingNames(2, (prepare) =>
      runWithAgentContext('lvl1', () => runWithAgentContext('lvl2', prepare)),
    );
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('nesting: maxSubagentDepth=1 reproduces the old no-nesting behavior', async () => {
    expect(await nestingNames(1, inLvl1)).not.toContain(ToolNames.AGENT);
  });

  it('nesting: frameless prepareTools fails closed — AgentTool excluded', async () => {
    // prepareTools() only ever serves agents, never the top-level session.
    // A missing agent frame means the launch path forgot runWithAgentContext
    // (codex review: AgentInteractive.start() before it established its
    // frame); such an agent must not be depth-gated as the top-level session.
    const names = await nestingNames(5, (prepare) => prepare());
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('nesting: fork execution contexts never receive the AgentTool', async () => {
    // The fork contract is context-sharing, not isolation: forks must not
    // spawn. Depth would otherwise permit nesting here (one frame, max 5).
    const names = await nestingNames(5, (prepare) =>
      runInForkContext(() => inLvl1(prepare)),
    );
    expect(names).not.toContain(ToolNames.AGENT);
    expect(names).toContain('read_file');
  });

  it('teammates never receive the session-scoped memory tools', async () => {
    // Teammates run in-process on a Config prototype-chained to the
    // leader's, so their search_memory would claim the leader's turn-scoped
    // request signatures and manage_memory would mutate shared memory
    // without the leader's review — the same hazard the subagent set lists.
    const { core } = buildAgentForTools({ tools: ['*'] }, [
      { name: ToolNames.SEARCH_MEMORY, description: 'search memory' },
      { name: ToolNames.MANAGE_MEMORY, description: 'manage memory' },
      { name: 'read_file', description: 'read' },
    ] as FunctionDeclaration[]);
    const identity: TeammateIdentity = {
      agentId: 'scribe@demo',
      agentName: 'scribe',
      teamName: 'demo',
      isTeamLead: false,
    };
    const tools = await runWithTeammateIdentity(identity, () =>
      core.prepareTools(),
    );
    const names = tools.map((t) => t.name);
    expect(names).not.toContain(ToolNames.SEARCH_MEMORY);
    expect(names).not.toContain(ToolNames.MANAGE_MEMORY);
    expect(names).toContain('read_file');
  });

  it('nesting: teammates never receive the AgentTool regardless of depth', async () => {
    const names = await nestingNames(5, (prepare) =>
      runWithTeammateIdentity(teammate('scribe', 'demo'), () =>
        inLvl1(prepare),
      ),
    );
    expect(names).not.toContain(ToolNames.AGENT);
  });

  it('nesting: explicit tools list includes AgentTool only when nesting is allowed', async () => {
    const explicit = ['read_file', ToolNames.AGENT];
    expect(await nestingNames(5, inLvl1, explicit)).toContain(ToolNames.AGENT);

    const deniedNames = await nestingNames(1, inLvl1, explicit);
    expect(deniedNames).not.toContain(ToolNames.AGENT);
    expect(deniedNames).toContain('read_file');
  });
});

describe('extractParentToolNames', () => {
  const configWithTools = (
    tools: Array<{ functionDeclarations?: FunctionDeclaration[] }>,
  ): GenerateContentConfig => ({ tools }) as unknown as GenerateContentConfig;
  /** One `functionDeclarations` group holding a `{ name }` per entry. */
  const group = (...names: Array<string | undefined>) => ({
    functionDeclarations: names.map((name) => ({ name })),
  });

  it('extracts declaration names from a single group', () => {
    const names = extractParentToolNames(
      configWithTools([group(ToolNames.READ_FILE, ToolNames.WRITE_FILE)]),
    );
    expect(names).toEqual([ToolNames.READ_FILE, ToolNames.WRITE_FILE]);
  });

  it('flattens and deduplicates names across multiple functionDeclarations groups', () => {
    const names = extractParentToolNames(
      configWithTools([
        group(ToolNames.READ_FILE),
        group(ToolNames.READ_FILE, ToolNames.GREP),
      ]),
    );
    // READ_FILE appears in both groups but is returned once.
    expect(names).toEqual([ToolNames.READ_FILE, ToolNames.GREP]);
  });

  it('drops tools a subagent must never inherit (EXCLUDED_TOOLS_FOR_SUBAGENTS)', () => {
    const names = extractParentToolNames(
      configWithTools([
        group(
          ToolNames.WORKFLOW,
          ToolNames.AGENT,
          ToolNames.REQUEST_SHUTDOWN,
          ToolNames.RECORD_SOURCE,
          ToolNames.READ_FILE,
        ),
      ]),
    );
    expect(names).toEqual([ToolNames.READ_FILE]);
    expect(names).not.toContain(ToolNames.WORKFLOW);
    expect(names).not.toContain(ToolNames.AGENT);
    // Leader-only team control: a subagent must never impersonate the
    // leader by requesting a teammate shutdown (#9401).
    expect(names).not.toContain(ToolNames.REQUEST_SHUTDOWN);
    expect(names).not.toContain(ToolNames.RECORD_SOURCE);
  });

  it('filters out empty and non-string declaration names', () => {
    const names = extractParentToolNames(
      configWithTools([group('', undefined, ToolNames.READ_FILE)]),
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

describe('buildInheritedForkExecutionToolNames', () => {
  it('unions deferred registry tools without escaping a configured allowlist', () => {
    const advertised = [
      ToolNames.READ_FILE,
      ToolNames.TOOL_SEARCH,
      ToolNames.TOOL_CALL,
    ];
    const registered = [
      ...advertised,
      'mcp__docs__search',
      ToolNames.TASK_LIST,
    ];
    expect(
      buildInheritedForkExecutionToolNames(advertised, registered, [
        ...registered,
      ]),
    ).toEqual([...advertised, 'mcp__docs__search']);
  });
});
