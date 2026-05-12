/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { FunctionDeclaration } from '@google/genai';
import { AgentCore } from './agent-core.js';
import {
  type AgentExecutionMode,
  getCurrentAgentId,
  getCurrentAgentDepth,
  getCurrentAgentExecutionMode,
  getRuntimeContentGenerator,
  runWithAgentDepth,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import { subagentNameContext } from '../../utils/subagentNameContext.js';
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
import { ToolNames } from '../../tools/tool-names.js';

afterEach(() => {
  vi.unstubAllEnvs();
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

  function makeCore(name: string, runtimeView?: RuntimeContentGeneratorView) {
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
    );
  }

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
      expect(getCurrentAgentDepth()).toBe(1);
      expect(getCurrentAgentExecutionMode()).toBe('foreground');
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

  it('publishes the configured nesting depth in the agent frame', async () => {
    const core = new AgentCore(
      'nested-agent',
      {} as unknown as Config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      2,
    );

    let observedDepth = -1;
    await runWithAgentDepth(1, async () => {
      await core.runInAgentFrames(async () => {
        observedDepth = getCurrentAgentDepth();
      });
    });

    expect(observedDepth).toBe(2);
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

describe('AgentCore.prepareTools', () => {
  // Subagents that opt into the wildcard (`tools: ['*']`) — or omit
  // toolConfig entirely — must inherit DEFERRED tools too. Otherwise a
  // subagent configured with `tools: ['*']` against a registry that
  // includes MCP / lsp / cron_* tools would silently lose them once
  // ToolSearch was introduced (the main chat sees them via the
  // "Deferred Tools" prompt + ToolSearch flow, but subagents don't get
  // either of those scaffolds).
  function buildAgentForTools(
    toolConfig: ToolConfig | undefined,
    fnDeclarations: FunctionDeclaration[],
    agentDepth = 1,
    executionMode: AgentExecutionMode = 'foreground',
  ): {
    core: AgentCore;
    getFunctionDeclarationsSpy: ReturnType<typeof vi.fn>;
  } {
    const getFunctionDeclarationsSpy = vi.fn().mockReturnValue(fnDeclarations);
    const config = {
      getToolRegistry: vi.fn().mockReturnValue({
        warmAll: vi.fn().mockResolvedValue(undefined),
        getFunctionDeclarations: getFunctionDeclarationsSpy,
        getFunctionDeclarationsFiltered: vi.fn().mockReturnValue([]),
      }),
    } as unknown as Config;

    const core = new AgentCore(
      'test-subagent',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      toolConfig,
      undefined,
      undefined,
      undefined,
      agentDepth,
      executionMode,
    );
    return { core, getFunctionDeclarationsSpy };
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
    ];
    const { core, getFunctionDeclarationsSpy } = buildAgentForTools(
      undefined,
      fnDecls,
    );

    await core.prepareTools();

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
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

  it('excludes agent at the default maximum subagent depth', async () => {
    const fnDecls: FunctionDeclaration[] = [
      { name: ToolNames.AGENT, description: 'agent' } as FunctionDeclaration,
      { name: 'read_file', description: 'read' } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls, 1);

    const tools = await core.prepareTools();

    expect(tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('allows agent while below QWEN_AGENT_MAX_DEPTH', async () => {
    vi.stubEnv('QWEN_AGENT_MAX_DEPTH', '2');
    const fnDecls: FunctionDeclaration[] = [
      { name: ToolNames.AGENT, description: 'agent' } as FunctionDeclaration,
      {
        name: ToolNames.CRON_CREATE,
        description: 'cron',
      } as FunctionDeclaration,
      { name: 'read_file', description: 'read' } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools({ tools: ['*'] }, fnDecls, 1);

    const tools = await core.prepareTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      ToolNames.AGENT,
      'read_file',
    ]);
  });

  it('allows inline agent declarations while below the nesting limit', async () => {
    vi.stubEnv('QWEN_AGENT_MAX_DEPTH', '2');
    const agentDecl = {
      name: ToolNames.AGENT,
      description: 'agent',
    } as FunctionDeclaration;
    const cronDecl = {
      name: ToolNames.CRON_CREATE,
      description: 'cron',
    } as FunctionDeclaration;
    const { core } = buildAgentForTools(
      { tools: [agentDecl, cronDecl] },
      [],
      1,
    );

    const tools = await core.prepareTools();

    expect(tools.map((tool) => tool.name)).toEqual([ToolNames.AGENT]);
  });

  it('excludes agent in background execution mode even below the nesting limit', async () => {
    vi.stubEnv('QWEN_AGENT_MAX_DEPTH', '2');
    const fnDecls: FunctionDeclaration[] = [
      { name: ToolNames.AGENT, description: 'agent' } as FunctionDeclaration,
      { name: 'read_file', description: 'read' } as FunctionDeclaration,
    ];
    const { core } = buildAgentForTools(
      { tools: ['*'] },
      fnDecls,
      1,
      'background',
    );

    const tools = await core.prepareTools();

    expect(tools.map((tool) => tool.name)).toEqual(['read_file']);
  });
});
