/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createToolFileStateCache,
  trackFileStateResult,
  isSameFileContent,
} from '../utils/fileStateCache.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withFileWriteFeedback } from '../tools/file-write-feedback.js';
import * as fileWriteUtils from '../utils/fileWriteUtils.js';
import {
  executeToolWithHooks,
  extractMcpContext,
  extractPostMcpContext,
} from './coreToolHookTriggers.js';
import { ToolErrorType } from '../tools/tool-error.js';
import {
  BaseToolInvocation,
  type ToolResult,
  type AnyDeclarativeTool,
  type ToolLiveOutput,
} from '../tools/tools.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import type { Config } from '../config/config.js';
import { HookEventName, type DefaultHookOutput } from '../hooks/types.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import {
  DiscoveredMCPTool,
  DiscoveredMCPToolInvocation,
} from '../mcp/tools/mcp-tool.js';
import type { CallableTool, Part } from '@google/genai';

/** Helper to create a minimal ToolUseContext from an AbortSignal. */
function makeCtx(
  signal: AbortSignal,
  options?: Record<string, unknown>,
): ToolUseContext {
  return Object.freeze({ signal, options }) as ToolUseContext;
}

function aggregatedHookResult(
  finalOutput?: DefaultHookOutput,
): AggregatedHookResult {
  const result: AggregatedHookResult = {
    success: true,
    allOutputs: [],
    errors: [],
    totalDuration: 0,
  };
  if (finalOutput) {
    result.finalOutput = finalOutput;
  }
  return result;
}

describe(
  'post plugin context',
  () => {
    it.each([true, false])(
      'uses the actual tool snapshot with server config=%s',
      (hasConfig) => {
        const plugin = {
          marketItemId: 'demo@market',
          displayName: 'demo',
          version: '1.2.3',
        };
        const tool = new DiscoveredMCPTool(
          {} as CallableTool,
          'shared',
          'review',
          'review',
          { type: 'object' },
          undefined,
          undefined,
          undefined,
          undefined,
          'demo',
          'demo@market',
          undefined,
          undefined,
          undefined,
          plugin,
        );
        plugin.version = '2.0.0';
        const invocation = tool.build({});
        const config = {
          getMcpClientManager: () => undefined,
          getMcpServers: () =>
            hasConfig
              ? {
                shared: {
                  command: 'node',
                  plugin: { id: 'other', name: 'other' },
                },
              }
              : {},
        } as unknown as Config;
        expect(extractMcpContext(
          invocation,
          config
        )?.plugin).toBeUndefined();
        const context = extractPostMcpContext(
          invocation,
          config
        );
        expect(context).toMatchObject({
          server_name: 'shared',
          tool_name: 'review',
          plugin: {
            marketSourceId: '',
            orgId: '',
            itemKind: '',
            marketItemId: 'demo@market',
            displayName: 'demo',
            version: '1.2.3',
          },
        });
        context!.plugin!.version = 'mutated';
        expect(extractPostMcpContext(
          invocation,
          config
        )?.plugin?.version).toBe(
          '1.2.3',
        );
      },
    );

    it.each([
      undefined,
      { marketItemId: 'demo', displayName: 'demo', version: '' },
    ])(
      'preserves absent plugin/version: %j',
      (plugin) => {
        const invocation = new DiscoveredMCPToolInvocation(
          {} as CallableTool,
          'srv',
          'review',
          'review',
          undefined,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          plugin,
        );
        const config = {
          getMcpClientManager: () => undefined,
          getMcpServers: () => ({ srv: { command: 'node' } }),
        } as unknown as Config;
        const context = extractPostMcpContext(
          invocation,
          config
        );
        expect(context?.plugin).toEqual({
          marketSourceId: '',
          orgId: '',
          itemKind: '',
          marketItemId: plugin?.marketItemId ?? '',
          displayName: plugin?.displayName ?? '',
          version: '',
        });
      }
    );
  }
);

class MockInvocation extends BaseToolInvocation<{ key?: string }, ToolResult> {
  constructor(params: { key?: string }) {
    super(params);
  }
  getDescription() {
    return 'mock';
  }
  async execute(): Promise<ToolResult> {
    return {
      llmContent: this.params.key ? `key: ${this.params.key}` : 'success',
      returnDisplay: this.params.key
        ? `key: ${this.params.key}`
        : 'success display',
    };
  }
}

describe(
  'runtime hook businessId',
  () => {
    it.each(
      (['Read', 'Skill', 'Agent'] as const).flatMap((toolName) =>
        (['success', 'throw', 'failure'] as const).map((outcome) => ({
          toolName,
          outcome,
        })),
      ),
    )(
      'snapshots the source before $toolName $outcome',
      async ({ toolName, outcome }) => {
        const post = vi.fn(async () => aggregatedHookResult());
        const failure = vi.fn(async () => aggregatedHookResult());
        const config = {
          getHookSystem: () => ({
            firePostToolUseEvent: post,
            firePostToolUseFailureEvent: failure,
          }),
        } as unknown as Config;
        const ctx = {
          signal: new AbortController().signal,
          parentBusinessInfo: { id: 'B1', version: '1' },
          skillHookContext:
            toolName === 'Skill'
              ? {
                activation_source: 'model_tool',
                requested_skill_name: 'review',
                skill_type: 'normal',
              }
              : undefined,
        } as ToolUseContext;
        const invocation = Object.assign(
          new MockInvocation({}),
          {
            getSubagentHookContext: () =>
              toolName === 'Agent'
                ? { agent_type: 'reviewer', agent_source: 'project' as const }
                : undefined,
          }
        );
        vi.spyOn(
          invocation,
          'execute'
        ).mockImplementation(async () => {
          Object.assign(
            ctx.parentBusinessInfo!,
            { id: 'B2' }
          );
          if (outcome === 'throw') throw new Error('broken');
          return {
            llmContent: 'result',
            returnDisplay: 'result',
            ...(outcome === 'failure'
              ? {
                error: {
                  type: ToolErrorType.EXECUTION_FAILED,
                  message: 'broken',
                },
              }
              : {}),
          };
        });
        const result = executeToolWithHooks(
          invocation,
          toolName,
          ctx,
          {} as AnyDeclarativeTool,
          config,
          undefined,
          'call',
        );
        if (outcome === 'throw') await expect(result).rejects.toThrow('broken');
        else await result;
        const args = (outcome === 'success' ? post : failure).mock
          .calls[0] as unknown[];
        expect(args[outcome === 'success' ? 11 : 12]).toMatchObject({
          businessId: 'B1',
        });
        if (toolName !== 'Read')
          expect(args[outcome === 'success' ? 11 : 12]).toMatchObject({
            extensionFeatures: { toolCallId: 'call' },
            extensionExecution: {
              name: toolName === 'Agent' ? 'reviewer' : 'Skill'
            },
          });
        expect(args[1]).not.toHaveProperty('businessId');
      },
    );

    it(
      'keeps a missing source undefined',
      async () => {
        const post = vi.fn(async () => aggregatedHookResult());
        const config = {
          getHookSystem: () => ({ firePostToolUseEvent: post }),
        } as unknown as Config;
        await executeToolWithHooks(
          new MockInvocation({}),
          'Read',
          makeCtx(new AbortController().signal),
          {} as AnyDeclarativeTool,
          config,
        );
        expect((post.mock.calls[0] as unknown[])[11]).toEqual({
          businessId: undefined,
        });
      }
    );
  }
);

class MockBackgroundableInvocation extends BaseToolInvocation<
  { key?: string },
  ToolResult
> {
  constructor(params: { key?: string }) {
    super(params);
  }
  getDescription() {
    return 'mock-pid';
  }
  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: ToolLiveOutput) => void,
    options?: { setExecutionIdCallback?: (executionId: number) => void },
  ) {
    options?.setExecutionIdCallback?.(4242);
    return {
      llmContent: 'pid',
      returnDisplay: 'pid',
    };
  }
}

class MockStructuredInvocation extends BaseToolInvocation<
  Record<string, never>,
  ToolResult
> {
  constructor() {
    super({});
  }
  getDescription() {
    return 'structured mock';
  }
  async execute() {
    const toolUseResult = {
      stdout: 'original',
      stderr: '',
      interrupted: false,
      isImage: false,
    };
    return {
      llmContent: 'original',
      returnDisplay: 'original',
      toolUseResult,
      data: toolUseResult,
    };
  }
}

class MockStructuredInvocationWithUndefined extends BaseToolInvocation<
  Record<string, never>,
  ToolResult
> {
  constructor() {
    super({});
  }
  getDescription() {
    return 'structured mock with an optional runtime field';
  }
  async execute() {
    const toolUseResult = {
      stdout: 'original',
      stderr: '',
      interrupted: false,
      isImage: false,
      persistedOutput: undefined,
    };
    return {
      llmContent: 'original',
      returnDisplay: 'original',
      toolUseResult,
      data: toolUseResult,
    };
  }
}

describe('executeToolWithHooks', () => {
  it(
    'executes Skill with an unprepared frozen context and shares local attribution',
    async () => {
      const post = vi.fn(async () => ({}));
      const config = {
        getHookSystem: () => ({ firePostToolUseEvent: post }),
        getSkillManager: () => ({
          getSkill: () => ({ name: 'review', source: 'project' })
        }),
      } as unknown as Config;
      const ctx = Object.freeze({ signal: new AbortController().signal });
      const executeWithContext = vi.fn(async (received: ToolUseContext) => {
        expect(Object.isFrozen(received)).toBe(true);
        expect(received.skillHookContext?.skill_name).toBe('review');
        received.skillHookContext!.skill_activated = true;
        return { llmContent: 'done', returnDisplay: 'done' };
      });
      await expect(
        executeToolWithHooks(
          { params: { skill: 'review' }, executeWithContext } as never,
          'Skill',
          ctx,
          {} as never,
          config
        )).resolves.toMatchObject({ llmContent: 'done' });
      expect(ctx).not.toHaveProperty('skillHookContext');
      expect(post).toHaveBeenCalledOnce();
      expect((post.mock.calls[0] as unknown[])[9]).toMatchObject({
        skill_activated: true
      });
    }
  );

  let mockTool: AnyDeclarativeTool;
  let mockHookSystem: HookSystem;
  let mockConfig: Config;

  it.each(['skill', 'subagent', 'mcp'] as const)(
    'passes the loaded plugin name into the fixed %s execution snapshot',
    async (kind) => {
      Object.assign(
        mockConfig,
        {
          getSessionId: () => 'owner-session',
          getSkillManager: () => ({
            getSkill: () => ({
              name: 'review',
              source: 'plugin',
              pluginName: 'skill-owner',
              plugin: { marketSourceId: 'file-market', orgId: 'file-org', itemKind: 'plugin', marketItemId: 'file-id', displayName: 'File plugin', version: 'file-version' },
            }),
          }),
        },
      );

      const invocation = new MockInvocation({});
      if (kind === 'skill')
        Object.assign(
          invocation.params,
          { skill: 'review' },
        );
      if (kind === 'subagent') {
        Object.assign(
          invocation,
          {
            pluginName: 'subagent-owner',
            getSubagentHookContext: () => ({
              agent_type: 'reviewer',
              agent_source: 'plugin',
              plugin: { marketSourceId: 'file-market', orgId: 'file-org', itemKind: 'plugin', marketItemId: 'file-id', displayName: 'File plugin', version: 'file-version' },
            }),
          },
        );
      }

      await executeToolWithHooks(
        invocation,
        kind === 'skill' ? 'Skill' : kind === 'subagent' ? 'Agent' : 'mcp_call',
        Object.freeze({
          signal: new AbortController().signal,
          extensionExecutionRawRecord: kind === 'mcp' ? { pluginName: 'mcp-owner' } : {},
        }),
        mockTool,
        mockConfig,
      );

      const calls = vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls;
      const attribution = calls[0][11]!;
      expect(attribution.extensionExecution?.pluginName).toBe(`${kind}-owner`);
      expect(attribution.extensionFeatures).not.toHaveProperty('pluginName');
      if (kind !== 'mcp') {
        expect(attribution.extensionFeatures).toMatchObject({
          marketSourceId: 'file-market',
          marketOrgId: 'file-org',
          extensionKind: 'plugin',
          extensionId: 'file-id',
          extensionVersion: 'file-version',
        });
      }
    },
  );

  it(
    'retains the selected Skill facts when its manager reloads during execution',
    async () => {
      let selected = {
        name: 'chosen',
        source: 'project',
        resourceLocation: {
          base: 'project_config',
          relativePath: 'skills/chosen/SKILL.md',
          softlink: false,
        },
      };
      Object.assign(
        mockConfig,
        {
          getSessionId: () => 's',
          getSkillManager: () => ({ getSkill: () => selected }),
        }
      );
      const ctx = {
        signal: new AbortController().signal,
        skillHookContext: {
          requested_skill_name: 'chosen',
          activation_source: 'model_tool',
          skill_name: 'chosen',
          skill_source: 'project',
        },
      } as ToolUseContext;
      const invocation = Object.assign(
        new MockInvocation({}),
        {
          params: { skill: 'chosen' },
        }
      );
      vi.spyOn(
        invocation,
        'execute'
      ).mockImplementation(async () => {
        selected = {
          name: 'replacement',
          source: 'plugin',
          resourceLocation: {
            base: 'plugin_root',
            relativePath: 'new/SKILL.md',
            softlink: true,
          },
        };
        return { llmContent: 'ok', returnDisplay: '' };
      });
      await executeToolWithHooks(
        invocation,
        'Skill',
        ctx,
        mockTool,
        mockConfig
      );
      expect(
        vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls[0][11]
          ?.extensionFeatures,
      ).toMatchObject({
        skillSource: 'project',
        resourcePathBase: 'project_config',
        resourceRelativePath: 'skills/chosen/SKILL.md',
        resourceSoftlink: false,
      });
      expect(
        vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls[0][11]
          ?.extensionExecution?.name).toBe('chosen');
    }
  );

  it(
    'keeps the original hook and result when feature collection throws',
    async () => {
      Object.assign(
        mockConfig,
        {
          getSessionId: () => {
            throw Error('cannot collect');
          },
        }
      );
      const invocation = new MockInvocation({});
      const original = { llmContent: 'original', returnDisplay: 'original' };
      vi.spyOn(
        invocation,
        'execute'
      ).mockResolvedValue(original);
      const result = await executeToolWithHooks(
        invocation,
        'mcp_list',
        makeCtx(new AbortController().signal),
        mockTool,
        mockConfig,
      );
      expect(result).toBe(original);
      expect(mockHookSystem.firePostToolUseEvent).toHaveBeenCalledOnce();
      expect(
        vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls[0][11],
      ).toEqual({ businessId: undefined });
    }
  );

  it.each(['success', 'throw', 'error', 'semantic'] as const)(
    'freezes extension facts before the %s post hook',
    async (outcome) => {
      Object.assign(
        mockConfig,
        {
          getSessionId: () => 'features-session',
        }
      );
      const rawRecord = { mcpListResultCount: 0 };
      const ctx = {
        signal: new AbortController().signal,
        extensionExecutionRawRecord: rawRecord,
        extensionStartedAtMonotonicMs: performance.now() - 100,
      } as ToolUseContext;
      const invocation = new MockInvocation({});
      const rawMessage = 'original failure'.repeat(2000);
      if (outcome === 'throw')
        vi.spyOn(
          invocation,
          'execute'
        ).mockRejectedValue(
          new Error(rawMessage),
        );
      else
        vi.spyOn(
          invocation,
          'execute'
        ).mockResolvedValue({
          llmContent: 'original output',
          returnDisplay: '',
          ...(outcome === 'error'
            ? { error: { message: rawMessage } }
            : outcome === 'semantic'
              ? { isError: true }
              : {}),
        });
      let features:
        | import('../extensions/extension-features.js').ExtensionFeatures
        | undefined;
      let execution: {
        name: string;
        durationMs?: number;
        status: string;
        errorType?: string;
        errorCode?: string
      }
        | undefined;
      const capture = (...args: unknown[]) => {
        const attribution = args.at(-1) as {
          extensionFeatures?: typeof features;
          extensionExecution?: typeof execution
        };
        features = attribution.extensionFeatures;
        execution = attribution.extensionExecution;
        Object.assign(
          rawRecord,
          { mcpListResultCount: 99 }
        );
        return aggregatedHookResult();
      };
      mockHookSystem.firePostToolUseEvent = vi.fn(capture) as never;
      mockHookSystem.firePostToolUseFailureEvent = vi.fn(capture) as never;
      await executeToolWithHooks(
        invocation,
        'mcp_list',
        ctx,
        mockTool,
        mockConfig,
        undefined,
        'feature-call',
      ).catch(() => {});
      expect(features).toBeDefined();
      expect(execution).toMatchObject({
        name: 'mcp_list',
        status: outcome === 'success' ? 'success' : 'error'
      });
      expect(execution?.durationMs).toBeGreaterThanOrEqual(0);
      for (const key of [
        'toolName',
        'skillName',
        'subagentType',
        'mcpTargetToolName',
        'durationMs',
        'status',
        'errorType',
        'errorCode']) {
        expect(Object.keys(features!)).not.toContain(key);
      }
      expect(features).toMatchObject({
        toolCallId: 'feature-call',
        mcpListResultCount: 0,
        success: outcome === 'success',
      });
      expect(execution!.durationMs).toBeGreaterThanOrEqual(100);
      expect(Object.isFrozen(features)).toBe(true);
      if (outcome === 'throw') expect(features!.contentLength).toBe('');
      if (outcome === 'error' || outcome === 'throw')
        expect(features!.errorMessage).toBe(rawMessage);
    },
  );

  beforeEach(() => {
    mockHookSystem = {
      firePreToolUseEvent: vi.fn(),
      firePostToolUseEvent: vi.fn(),
    } as unknown as HookSystem;
    mockConfig = {
      getHookSystem: vi.fn().mockReturnValue(mockHookSystem),
      getMcpClientManager: vi.fn().mockReturnValue(undefined),
      getMcpServers: vi.fn().mockReturnValue({}),
    } as unknown as Config;
    mockTool = {
      build: vi.fn().mockImplementation((params) => new MockInvocation(params)),
    } as unknown as AnyDeclarativeTool;
  });

  describe(
    'post tool plugin context',
    () => {
      it.each(['success', 'returned error', 'thrown error'] as const)(
        'passes actual subagent attribution for %s',
        async (outcome) => {
          const context = {
            agent_type: 'demo:reviewer',
            agent_source: 'plugin' as const,
            plugin: {
              marketSourceId: 'market',
              orgId: 'org',
              itemKind: 'plugin',
              marketItemId: 'demo@market',
              displayName: 'demo',
              version: '1.2.3',
            },
          };
          const invocation = Object.assign(
            new MockInvocation({}),
            {
              getSubagentHookContext: () => structuredClone(context),
            }
          );
          if (outcome === 'thrown error')
            vi.spyOn(
              invocation,
              'execute'
            ).mockRejectedValue(
              new Error('failed'),
            );
          if (outcome === 'returned error')
            vi.spyOn(
              invocation,
              'execute'
            ).mockResolvedValue({
              llmContent: 'failed',
              returnDisplay: 'failed',
              error: { message: 'failed', type: ToolErrorType.EXECUTION_FAILED },
            });
          mockHookSystem.firePostToolUseFailureEvent = vi
            .fn()
            .mockResolvedValue(aggregatedHookResult());
          const result = executeToolWithHooks(
            invocation,
            'Agent',
            makeCtx(new AbortController().signal),
            mockTool,
            mockConfig,
            undefined,
            'agent-call',
          );
          if (outcome === 'thrown error')
            await expect(result).rejects.toThrow('failed');
          else await result;
          const calls =
            outcome === 'success'
              ? vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls
              : vi.mocked(mockHookSystem.firePostToolUseFailureEvent).mock.calls;
          expect(calls).toHaveLength(1);
          expect(calls[0][outcome === 'success' ? 10 : 11]).toEqual(context);
          expect(calls[0].at(-1)).toMatchObject({
            businessId: undefined,
            extensionExecution: { name: context.agent_type },
            extensionFeatures: { toolCallId: 'agent-call' }
          });
          expect(mockHookSystem.firePreToolUseEvent).not.toHaveBeenCalled();
        },
      );

      it.each(['success', 'returned error', 'thrown error'] as const)(
        'passes actual MCP plugin for %s',
        async (outcome) => {
          const invocation = new DiscoveredMCPToolInvocation(
            {} as CallableTool,
            'srv',
            'review',
            'review',
            undefined,
            {},
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              marketItemId: 'demo@market',
              displayName: 'demo',
              version: '1.2.3',
            },
          );
          vi.spyOn(
            invocation,
            'executeWithContext'
          ).mockImplementation(
            async () => {
              if (outcome === 'thrown error') throw new Error('failed');
              return {
                llmContent: 'result',
                returnDisplay: 'result',
                ...(outcome === 'returned error' && {
                  error: {
                    message: 'failed',
                    type: ToolErrorType.EXECUTION_FAILED,
                  },
                }),
              };
            },
          );
          mockHookSystem.firePostToolUseFailureEvent = vi
            .fn()
            .mockResolvedValue(aggregatedHookResult());
          const result = executeToolWithHooks(
            invocation,
            'mcp__srv__review',
            makeCtx(new AbortController().signal),
            mockTool,
            mockConfig,
          );
          if (outcome === 'thrown error')
            await expect(result).rejects.toThrow('failed');
          else await result;
          const args =
            outcome === 'success'
              ? vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls[0]
              : vi.mocked(mockHookSystem.firePostToolUseFailureEvent).mock
                .calls[0];
          expect(args[outcome === 'success' ? 4 : 5]).toMatchObject({
            server_name: 'srv',
            tool_name: 'review',
            plugin: {
              marketSourceId: '',
              orgId: '',
              itemKind: '',
              marketItemId: 'demo@market',
              displayName: 'demo',
              version: '1.2.3',
            },
          });
        },
      );
    }
  );

  it(
    'keeps inline Skill Post at the existing tool completion point',
    async () => {
      const invocation = new MockInvocation({});
      vi.spyOn(
        invocation,
        'execute'
      ).mockResolvedValue({
        llmContent: 'launching',
        returnDisplay: 'launching',
        newMessages: [{ role: 'user', content: 'instructions' }],
      });
      await executeToolWithHooks(
        invocation,
        'Skill',
        { signal: new AbortController().signal },
        mockTool,
        mockConfig,
        undefined,
        'inline-call',
      );
      expect(mockHookSystem.firePostToolUseEvent).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(mockHookSystem.firePostToolUseEvent).mock.calls[0][9],
      ).toMatchObject({ skill_activated: true });
    }
  );

  it(
    'reports cancellation only for fork Skill using its activation facts',
    async () => {
      const controller = new AbortController();
      const invocation = new MockInvocation({});
      vi.spyOn(
        invocation,
        'execute'
      ).mockImplementation(async () => {
        controller.abort();
        throw new Error('cancelled');
      });
      Object.assign(
        mockConfig,
        {
          getSkillManager: () => ({ getSkill: () => ({ context: 'fork' }) }),
        }
      );
      mockHookSystem.firePostToolUseFailureEvent = vi
        .fn()
        .mockResolvedValue(aggregatedHookResult());
      await expect(
        executeToolWithHooks(
          invocation,
          'Skill',
          {
            signal: controller.signal,
            skillHookContext: {
              requested_skill_name: 'fork',
              activation_source: 'model_tool',
              skill_activated: true,
              failure_stage: 'execution',
            },
          },
          mockTool,
          mockConfig,
          undefined,
          'fork-call',
        ),
      ).rejects.toThrow('cancelled');
      const args = vi.mocked(mockHookSystem.firePostToolUseFailureEvent).mock
        .calls[0];
      expect(args[7]?.aborted).toBe(false);
      expect(args[9]).toMatchObject({
        skill_activated: true,
        failure_stage: 'execution',
      });
      expect(args[10]).toBe(true);
    }
  );


  describe.each(['Edit', 'Write'])(
    '%s file feedback after hooks',
    (toolName) => {
      const original = 'original\ncontent\n';
      let dir: string;
      let file: string;
      let cache: ReturnType<typeof createToolFileStateCache>;
      let invocation: MockInvocation;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hook-file-state-'));
        file = join(dir, 'file');
        writeFileSync(file, original);
        const date = new Date(1_700_000_000_000);
        utimesSync(file, date, date);
        cache = createToolFileStateCache();
        cache.set(file, {
          content: original,
          timestamp: Math.floor(statSync(file).mtimeMs),
          offset: undefined,
          limit: undefined,
        });
        invocation = new MockInvocation({});
        vi.spyOn(invocation, 'execute').mockImplementation(async () =>
          withFileWriteFeedback(
            { llmContent: 'written', returnDisplay: '' },
            cache,
            file,
            cache.get(file),
          ),
        );
      });

      afterEach(() => rmSync(dir, { force: true, recursive: true }));

      const execute = () =>
        executeToolWithHooks(
          invocation,
          toolName,
          makeCtx(new AbortController().signal),
          mockTool,
          mockConfig,
        );

      it.each([
        {
          name: 'newer mtime',
          content: 'formatted',
          delta: 2000,
          changed: true,
        },
        { name: 'same mtime', content: 'formatted', delta: 0, changed: true },
        {
          name: 'older mtime',
          content: 'formatted',
          delta: -2000,
          changed: true,
        },
        { name: 'touch only', content: original, delta: 2000, changed: false },
        { name: 'unchanged', content: original, delta: 0, changed: false },
        {
          name: 'BOM/CRLF only',
          content: '\uFEFForiginal\r\ncontent\r\n',
          delta: 0,
          changed: false,
        },
        {
          name: 'compact content',
          content: 'formatted\n'.repeat(1000),
          delta: 0,
          changed: true,
        },
      ])(
        'reconciles feedback for $name',
        async ({ content, delta, changed }) => {
          const timestamp = cache.get(file)!.timestamp + delta;
          vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
            async () => {
              writeFileSync(file, content);
              utimesSync(file, new Date(timestamp), new Date(timestamp));
              return aggregatedHookResult();
            },
          );
          const result = await execute();
          expect(result.error).toBeUndefined();
          expect(isSameFileContent(cache.get(file)!, content)).toBe(true);
          expect(cache.get(file)?.timestamp).toBe(timestamp);
          expect(Boolean(cache.get(file)?.contentNotInModelContext)).toBe(
            changed,
          );
          expect(String(result.llmContent).includes('hook changed')).toBe(
            changed,
          );
          expect(
            String(result.llmContent).includes('no need to read it back'),
          ).toBe(!changed);
        },
      );

      it.each(['isPartialView', 'contentNotInModelContext'] as const)(
        'preserves %s when a hook only touches the file',
        async (flag) => {
          cache.set(file, {
            ...cache.get(file)!,
            [flag]: true,
          });
          vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
            async () => {
              utimesSync(file, new Date(), new Date(Date.now() + 2000));
              return aggregatedHookResult();
            },
          );
          const result = await execute();
          expect(cache.get(file)?.[flag]).toBe(true);
          expect(result.llmContent).not.toContain('no need to read it back');
          expect(result.llmContent).not.toContain('hook changed');
        },
      );

      it.each(['stat', 'read'])(
        'withdraws feedback and invalidates the baseline on a %s failure',
        async (failure) => {
          vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
            async () => {
              rmSync(file);
              // A directory passes stat but cannot be read as a text file.
              if (failure === 'read') mkdirSync(file);
              return aggregatedHookResult();
            },
          );
          const result = await execute();
          expect(result.error).toBeUndefined();
          expect(result.llmContent).toBe('written');
          expect(cache.has(file)).toBe(false);
        },
      );

      it('does not read the file again when no hooks were dispatched', async () => {
        vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue({
          ...aggregatedHookResult(),
          hooksSkipped: true,
        });
        const read = vi.spyOn(fileWriteUtils, 'readFileWithMetadata');
        try {
          const result = await execute();
          expect(result.llmContent).toContain('no need to read it back');
          expect(read).not.toHaveBeenCalled();
        } finally {
          read.mockRestore();
        }
      });

      it.each([false, true])(
        'does not overwrite a later state or retain the earlier hint (hooks skipped=%s)',
        async (hooksSkipped) => {
          let laterState: ReturnType<typeof cache.get>;
          vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
            async () => {
              cache.set(file, { ...cache.get(file)!, content: 'later write' });
              laterState = cache.get(file);
              return { ...aggregatedHookResult(), hooksSkipped };
            },
          );
          const result = await execute();
          expect(result.llmContent).toBe('written');
          expect(cache.get(file)).toBe(laterState);
        },
      );

      it.each([false, true])(
        'preserves explicit hook output, including hook-owned hint text (changed=%s)',
        async (changed) => {
          const replacement =
            'Hook-owned: The file state is current in your context; no need to read it back.';
          vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
            async () => {
              if (changed) writeFileSync(file, 'formatted');
              return aggregatedHookResult({
                shouldStopExecution: () => false,
                getBlockingError: () => ({ blocked: false, reason: '' }),
                getUpdatedToolOutput: () => replacement,
                getUpdatedMCPToolOutput: () => undefined,
                getAdditionalContext: () => undefined,
              } as unknown as DefaultHookOutput);
            },
          );
          const result = await execute();
          expect(String(result.llmContent).startsWith(replacement)).toBe(true);
          expect(String(result.llmContent).includes('hook changed')).toBe(
            changed,
          );
          expect(result.toolUseResult).toBe(replacement);
          expect(result.returnDisplay).toBe(replacement);
        },
      );
    },
  );
  it('marks a Read output replaced by a hook as partial', async () => {
    const cache = createToolFileStateCache();
    const file = '/read-output';
    cache.set(file, {
      content: 'body',
      timestamp: 1,
      offset: 1,
      limit: undefined,
    });
    const invocation = new MockInvocation({});
    vi.spyOn(invocation, 'execute').mockResolvedValue(
      trackFileStateResult(
        { llmContent: 'body', returnDisplay: '' },
        cache,
        file,
      ),
    );
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => 'replacement',
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
      } as unknown as DefaultHookOutput),
    );
    await executeToolWithHooks(
      invocation,
      'Read',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );
    expect(cache.get(file)?.isPartialView).toBe(true);
  });

  // ── PostToolUse tests ──────────────────────────────────────────────
  // PreToolUse is tested in hooks/preToolUseEvaluation.test.ts (the real
  // production path via evaluatePreToolUseHook). This file only covers
  // PostToolUse / PostToolUseFailure and basic execution behaviour.

  it('passes internal file-write facts and business attribution to PostToolUse', async () => {
    const invocation = new MockInvocation({});
    vi.spyOn(invocation, 'execute').mockResolvedValue({
      llmContent: 'written',
      returnDisplay: 'written',
      toolUseResult: { status: 'ok' },
      fileWrite: {
        filePath: '/workspace/file.ts',
        workspacePath: '/workspace',
        originalContent: 'before',
        proposedContent: 'ai proposal',
        writtenContent: 'actual write',
      },
    } as ToolResult);
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );

    const result = await executeToolWithHooks(
      invocation,
      'Edit',
      {
        signal: new AbortController().signal,
        config: mockConfig,
        parentBusinessInfo: {
          id: 'business-1',
          version: 'test',
          orphan: true,
          product: 'cli',
          type: 'agent',
        },
        parentRequestSetId: 'request-1',
      } as ToolUseContext,
      mockTool,
      mockConfig,
    );

    expect(result.llmContent).toBe('written');
    expect(result.returnDisplay).toBe('written');
    expect(result.toolUseResult).toEqual({ status: 'ok' });
    expect(mockHookSystem.firePostToolUseEvent).toHaveBeenCalledWith(
      'Edit',
      {},
      { status: 'ok' },
      '',
      undefined,
      undefined,
      expect.anything(),
      undefined,
      {
        file_path: '/workspace/file.ts',
        workspace_path: '/workspace',
        original_content: 'before',
        proposed_content: 'ai proposal',
        written_content: 'actual write',
        business_id: 'business-1',
        request_set_id: 'request-1',
        orphan: true,
        product: 'cli',
        scenario: 'agent',
      },
      undefined,
      undefined,
      { businessId: 'business-1' },
    );
  });

  it('should handle continue: false in PostToolUse', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;
    const spy = vi.spyOn(invocation, 'execute');
    const pendingHookAttachments: Array<{ type: string; message?: string }> = [];

    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => true,
        getEffectiveReason: () => 'Stop after execution',
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => undefined,
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      { signal: abortSignal, pendingHookAttachments } as unknown as ToolUseContext,
      mockTool,
      mockConfig,
    );

    // Tool result passes through unmodified
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe('success');
    expect(spy).toHaveBeenCalled();
    // Stop signal pushed as attachment
    expect(pendingHookAttachments).toHaveLength(1);
    expect(pendingHookAttachments[0].type).toBe('hook_stopped_continuation');
    expect(pendingHookAttachments[0].message).toBe('Stop after execution');
  });

  it('should preserve the original result and report the block when PostToolUse denies', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;
    const pendingHookAttachments: Array<{
      type: string;
      hookName?: string;
      blockingError?: { blockingError: string; command: string };
    }> = [];

    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getEffectiveReason: () => '',
        getBlockingError: () => ({ blocked: true, reason: 'Result denied' }),
        getUpdatedToolOutput: () => undefined,
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      {
        signal: abortSignal,
        pendingHookAttachments,
      } as unknown as ToolUseContext,
      mockTool,
      mockConfig,
    );

    // The tool already ran — its original output must survive the block,
    // untouched: the reason travels through the attachment channel only, so a
    // rejected result is never rewritten on its way to the model.
    expect(result.llmContent).toBe('success');
    expect(result.returnDisplay).toBe('success display');
    expect(result.error).toBeUndefined();

    // Blocking feedback travels through the shared hook attachment channel.
    expect(pendingHookAttachments).toHaveLength(1);
    expect(pendingHookAttachments[0].type).toBe('hook_blocking_error');
    expect(pendingHookAttachments[0].hookName).toBe('PostToolUse:test_tool');
    expect(pendingHookAttachments[0].blockingError?.blockingError).toBe(
      'Tool result blocked: Result denied',
    );
  });

  it('should apply updated output and additional context after PostToolUse blocks', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;
    const pendingHookAttachments: Array<{ type: string }> = [];
    const pendingHookOutputs: Array<{
      hookEventName: HookEventName;
      output: string;
      sourceType: 'additionalContext';
      toolName?: string;
    }> = [];

    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getEffectiveReason: () => '',
        getBlockingError: () => ({ blocked: true, reason: 'Result denied' }),
        getUpdatedToolOutput: () => 'redacted output',
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => 'review the redacted result',
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      {
        signal: abortSignal,
        pendingHookAttachments,
        pendingHookOutputs,
      } as unknown as ToolUseContext,
      mockTool,
      mockConfig,
    );

    expect(result.llmContent).toBe('redacted output');
    expect(result.returnDisplay).toBe('redacted output');
    expect(result.error).toBeUndefined();
    expect(pendingHookAttachments).toEqual([
      expect.objectContaining({ type: 'hook_blocking_error' }),
    ]);
    expect(pendingHookOutputs).toEqual([
      {
        hookEventName: HookEventName.PostToolUse,
        output: 'review the redacted result',
        sourceType: 'additionalContext',
        toolName: 'test_tool',
      },
    ]);
  });

  it('should fall back to an inline notice when there is no attachment channel', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;

    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getEffectiveReason: () => '',
        getBlockingError: () => ({ blocked: true, reason: 'Result denied' }),
        getUpdatedToolOutput: () => 'redacted output',
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    // query() takes attachmentCtx as an option; the implicit-fork subagent and
    // side-question paths do not pass one, so pendingHookAttachments is absent.
    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      { signal: abortSignal } as unknown as ToolUseContext,
      mockTool,
      mockConfig,
    );

    // Output still survives, and the rejection is not silently lost.
    expect(result.llmContent).not.toContain('success');
    expect(result.llmContent).toContain('redacted output');
    expect(result.llmContent).toContain(
      '[System] Tool result blocked: Result denied',
    );
    expect(result.error).toBeUndefined();
  });

  it('should leave the result untouched when PostToolUse does not block', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;
    const pendingHookAttachments: Array<{ type: string }> = [];

    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getEffectiveReason: () => '',
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => undefined,
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      {
        signal: abortSignal,
        pendingHookAttachments,
      } as unknown as ToolUseContext,
      mockTool,
      mockConfig,
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe('success');
    expect(result.returnDisplay).toBe('success display');
    expect(pendingHookAttachments).toHaveLength(0);
  });

  it('persists an object replacement as the new semantic result', async () => {
    const replacement = {
      stdout: 'replacement',
      stderr: '',
      interrupted: false,
      isImage: false,
    };
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => replacement,
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      new MockStructuredInvocation(),
      'Bash',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );

    expect(result.toolUseResult).toEqual(replacement);
    expect(result.data).toEqual(replacement);
    expect(result.llmContent).toBe('replacement');
    expect(result.returnDisplay).toBe('replacement');
  });

  it('accepts a replacement cloned after the hook protocol drops undefined fields', async () => {
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockImplementation(
      async (_toolName, _toolInput, toolResponse) => {
        expect(toolResponse).toHaveProperty('persistedOutput', undefined);
        const protocolVisibleResponse = JSON.parse(
          JSON.stringify(toolResponse),
        ) as Record<string, unknown>;
        expect(protocolVisibleResponse).not.toHaveProperty('persistedOutput');
        return aggregatedHookResult({
          shouldStopExecution: () => false,
          getBlockingError: () => ({ blocked: false, reason: '' }),
          getUpdatedToolOutput: () => ({
            ...protocolVisibleResponse,
            stdout: 'replacement',
          }),
          getUpdatedMCPToolOutput: () => undefined,
          getAdditionalContext: () => undefined,
          suppressOutput: false,
        } as unknown as DefaultHookOutput);
      },
    );

    const result = await executeToolWithHooks(
      new MockStructuredInvocationWithUndefined(),
      'Bash',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );

    expect(result.toolUseResult).toEqual({
      stdout: 'replacement',
      stderr: '',
      interrupted: false,
      isImage: false,
    });
    expect(result.llmContent).toBe('replacement');
  });

  it('accepts a structurally different replacement without a declared output schema', async () => {
    const replacement = { redacted: true };
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => replacement,
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      new MockStructuredInvocation(),
      'Bash',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );

    expect(result.toolUseResult).toEqual(replacement);
    expect(result.data).toEqual(replacement);
    expect(result.llmContent).toBe('{"redacted":true}');
    expect(result.returnDisplay).toBe('{"redacted":true}');
  });

  it('uses generic MCP replacement by field presence and preserves mcpMeta', async () => {
    const response: Part[] = [
      {
        functionResponse: {
          name: 'render_app',
          response: {
            content: [{ type: 'text', text: 'original app result' }],
            structuredContent: { value: 1 },
            _meta: { ui: { resourceUri: 'ui://example/app' } },
          },
        },
      },
    ];
    const invocation = new DiscoveredMCPToolInvocation(
      {
        callTool: vi.fn().mockResolvedValue(response),
      } as unknown as CallableTool,
      'server',
      'render_app',
      'Render app',
      undefined,
      {},
    );
    vi.mocked(mockConfig.getMcpServers).mockReturnValue({
      server: { command: 'node' },
    });
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => '',
        getUpdatedMCPToolOutput: () => 'legacy replacement',
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'mcp__server__render_app',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );

    expect(result.toolUseResult).toBe('');
    expect(result.mcpResult).toBeUndefined();
    expect(result.llmContent).toBe('');
    expect(result.returnDisplay).toBe('');
    expect(result.mcpMeta).toEqual({
      _meta: { ui: { resourceUri: 'ui://example/app' } },
      structuredContent: { value: 1 },
    });
  });

  it('shows a placeholder when an MCP replacement carries only an image block', async () => {
    const response: Part[] = [
      {
        functionResponse: {
          name: 'render_app',
          response: { content: [{ type: 'text', text: 'original' }] },
        },
      },
    ];
    const invocation = new DiscoveredMCPToolInvocation(
      {
        callTool: vi.fn().mockResolvedValue(response),
      } as unknown as CallableTool,
      'server',
      'render_app',
      'Render app',
      undefined,
      {},
    );
    vi.mocked(mockConfig.getMcpServers).mockReturnValue({
      server: { command: 'node' },
    });
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false, reason: '' }),
        getUpdatedToolOutput: () => [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aW1hZ2U=',
            },
          },
        ],
        getUpdatedMCPToolOutput: () => undefined,
        getAdditionalContext: () => undefined,
        suppressOutput: false,
      } as unknown as DefaultHookOutput),
    );

    const result = await executeToolWithHooks(
      invocation,
      'mcp__server__render_app',
      makeCtx(new AbortController().signal),
      mockTool,
      mockConfig,
    );

    expect(result.llmContent).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ]);
    expect(result.returnDisplay).toContain('[Image: image/png');
  });

  // ── Execution tests ────────────────────────────────────────────────

  it('should pass execution ID callback through for non-shell invocations', async () => {
    const invocation = new MockBackgroundableInvocation({});
    const abortSignal = new AbortController().signal;
    const setExecutionIdCallback = vi.fn();

    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );

    await executeToolWithHooks(
      invocation,
      'test_tool',
      makeCtx(abortSignal, { setExecutionIdCallback }),
      mockTool,
      mockConfig,
    );

    expect(setExecutionIdCallback).toHaveBeenCalledWith(4242);
  });

  it('should execute tool and return result when no hooks fire', async () => {
    const invocation = new MockInvocation({});
    const abortSignal = new AbortController().signal;

    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );
    vi.mocked(mockHookSystem.firePostToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );

    const result = await executeToolWithHooks(
      invocation,
      'test_tool',
      makeCtx(abortSignal),
      mockTool,
      mockConfig,
    );

    expect(result.llmContent).toBe('success');
    expect(result.llmContent).not.toContain('hook_context');
  });

  // ── PostToolUseFailure cancellation tests ─────────────────────────────

  describe('PostToolUseFailure cancellation handling', () => {
    let firePostToolUseFailureEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      firePostToolUseFailureEvent = vi.fn();
      mockHookSystem = {
        firePreToolUseEvent: vi.fn(),
        firePostToolUseEvent: vi.fn(),
        firePostToolUseFailureEvent,
      } as unknown as HookSystem;
      mockConfig = {
        getHookSystem: vi.fn().mockReturnValue(mockHookSystem),
        getMcpClientManager: vi.fn().mockReturnValue(undefined),
        getMcpServers: vi.fn().mockReturnValue({}),
      } as unknown as Config;
    });

    it('should skip PostToolUseFailure when execution throws AbortError and signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const invocation = new MockInvocation({});
      vi.spyOn(invocation, 'execute').mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError'),
      );

      await expect(
        executeToolWithHooks(
          invocation,
          'test_tool',
          makeCtx(controller.signal),
          mockTool,
          mockConfig,
        ),
      ).rejects.toThrow('The operation was aborted');

      expect(firePostToolUseFailureEvent).not.toHaveBeenCalled();
    });

    it('should fire PostToolUseFailure when execution throws a real error (signal not aborted)', async () => {
      const controller = new AbortController();

      const invocation = new MockInvocation({});
      vi.spyOn(invocation, 'execute').mockRejectedValue(
        new Error('disk full'),
      );

      firePostToolUseFailureEvent.mockResolvedValue(undefined);

      await expect(
        executeToolWithHooks(
          invocation,
          'test_tool',
          makeCtx(controller.signal),
          mockTool,
          mockConfig,
        ),
      ).rejects.toThrow('disk full');

      expect(firePostToolUseFailureEvent).toHaveBeenCalledWith(
        'test_tool',
        expect.any(Object),
        'disk full',
        expect.any(String),
        undefined,
        undefined,
        undefined,
        expect.anything(),
        undefined,
        undefined,
        undefined,
        undefined,
        { businessId: undefined },
      );
    });

    it('should skip PostToolUseFailure when toolResult.error and signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const invocation = new MockInvocation({});
      vi.spyOn(invocation, 'execute').mockImplementation(async () => ({
        llmContent: 'error output',
        returnDisplay: 'error output',
        error: { type: ToolErrorType.EXECUTION_FAILED, message: 'cancelled' },
      }));

      const result = await executeToolWithHooks(
        invocation,
        'test_tool',
        makeCtx(controller.signal),
        mockTool,
        mockConfig,
      );

      expect(result.error).toBeDefined();
      expect(firePostToolUseFailureEvent).not.toHaveBeenCalled();
    });

    it.each([ToolErrorType.EXECUTION_FAILED, ToolErrorType.MCP_TOOL_ERROR])(
      'should fire PostToolUseFailure with error type %s when signal is NOT aborted',
      async (errorType) => {
        const controller = new AbortController();

        const invocation = new MockInvocation({});
        vi.spyOn(invocation, 'execute').mockImplementation(async () => ({
          llmContent: 'error output',
          returnDisplay: 'error output',
          error: {
            type: errorType,
            message: 'file not found',
          },
        }));

        firePostToolUseFailureEvent.mockResolvedValue(undefined);

        const result = await executeToolWithHooks(
          invocation,
          'test_tool',
          makeCtx(controller.signal),
          mockTool,
          mockConfig,
        );

        expect(result.error).toBeDefined();
        expect(firePostToolUseFailureEvent).toHaveBeenCalledTimes(1);
        expect(firePostToolUseFailureEvent).toHaveBeenCalledWith(
          'test_tool',
          expect.any(Object),
          'file not found',
          expect.any(String),
          errorType,
          undefined,
          undefined,
          expect.anything(),
          undefined,
          undefined,
          undefined,
          undefined,
          { businessId: undefined },
        );
      },
    );

    it.each([
      'Exit code 1\ncommand failed',
      'Command timed out after 1s and was terminated.\npartial output',
      'Command killed: output file exceeded 5GB.\npartial output',
    ])(
      'runs failure hooks for semantic errors and skips success hooks: %s',
      async (content) => {
        const controller = new AbortController();
        const invocation = new MockInvocation({});
        vi.spyOn(invocation, 'execute').mockImplementation(async () => ({
          llmContent: content,
          returnDisplay: 'command failed',
          isError: true,
        }));
        firePostToolUseFailureEvent.mockResolvedValue(undefined);

        const result = await executeToolWithHooks(
          invocation,
          'test_tool',
          makeCtx(controller.signal),
          mockTool,
          mockConfig,
        );

        expect(result.isError).toBe(true);
        expect(firePostToolUseFailureEvent).toHaveBeenCalledWith(
          'test_tool',
          {},
          content,
          '',
          undefined,
          undefined,
          undefined,
          controller.signal,
          undefined,
          undefined,
          undefined,
          undefined,
          { businessId: undefined },
        );
        expect(mockHookSystem.firePostToolUseEvent).not.toHaveBeenCalled();
      },
    );

    it('should not append pendingHookOutputs when cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const invocation = new MockInvocation({});
      vi.spyOn(invocation, 'execute').mockRejectedValue(
        new DOMException('aborted', 'AbortError'),
      );

      const pendingHookOutputs: unknown[] = [];
      const pendingHookAttachments: unknown[] = [];

      await expect(
        executeToolWithHooks(
          invocation,
          'test_tool',
          {
            signal: controller.signal,
            pendingHookOutputs,
            pendingHookAttachments,
          } as unknown as ToolUseContext,
          mockTool,
          mockConfig,
        ),
      ).rejects.toThrow();

      expect(pendingHookOutputs).toHaveLength(0);
      expect(pendingHookAttachments).toHaveLength(0);
    });
  });
});
