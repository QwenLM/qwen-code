/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FunctionDeclaration } from '@google/genai';
import { AgentCore } from './agent-core.js';
import { attachJsonlTranscriptWriter } from '../agent-transcript.js';
import {
  getCurrentAgentDepth,
  getCurrentAgentId,
  getRuntimeContentGenerator,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import { subagentNameContext } from '../../utils/subagentNameContext.js';
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
import { AgentEventEmitter, AgentEventType } from './agent-events.js';

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
  } {
    const debugSpy = vi.fn();
    const getFunctionDeclarationsSpy = vi.fn().mockReturnValue(fnDeclarations);
    const getFunctionDeclarationsFilteredSpy = vi.fn((names: string[]) =>
      fnDeclarations.filter((d) => d.name && names.includes(d.name)),
    );
    const config = {
      getDebugLogger: vi.fn().mockReturnValue({ debug: debugSpy }),
      getToolRegistry: vi.fn().mockReturnValue({
        warmAll: vi.fn().mockResolvedValue(undefined),
        getFunctionDeclarations: getFunctionDeclarationsSpy,
        getFunctionDeclarationsFiltered: getFunctionDeclarationsFilteredSpy,
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
    const { core, debugSpy } = buildAgentForTools(
      {
        tools: [
          { name: ToolNames.SEND_MESSAGE } as FunctionDeclaration,
          { name: ToolNames.TASK_UPDATE } as FunctionDeclaration,
          { name: ToolNames.ENTER_PLAN_MODE } as FunctionDeclaration,
          { name: ToolNames.EXIT_PLAN_MODE } as FunctionDeclaration,
          inlineSafe,
        ],
      },
      [],
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

describe('AgentCore STREAM_TEXT batching (#2928)', () => {
  it('batches thought and response text separately per chunk', () => {
    const emitter = new AgentEventEmitter();
    const events: Array<{ text: string; thought: boolean }> = [];
    emitter.on(AgentEventType.STREAM_TEXT, (e) => {
      events.push({ text: e.text, thought: e.thought ?? false });
    });
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'test',
      round: 1,
      text: 'reasoning',
      thought: true,
      timestamp: Date.now(),
    });
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'test',
      round: 1,
      text: 'output',
      thought: false,
      timestamp: Date.now(),
    });
    expect(events).toHaveLength(2);
    expect(events[0].thought).toBe(true);
    expect(events[1].thought).toBe(false);
  });
});
