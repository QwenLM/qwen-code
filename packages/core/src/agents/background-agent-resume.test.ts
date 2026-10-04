/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content, FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  BackgroundTaskRegistry,
  MAX_RETAINED_TERMINAL_AGENTS,
  type AgentCompletionStats,
  type AgentTaskRegistration,
} from './background-tasks.js';
import { BackgroundAgentResumeService } from './background-agent-resume.js';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  readAgentMeta,
  writeAgentMeta,
  type AgentMeta,
} from './agent-transcript.js';
import { ToolMode } from '../tools/code-mode.js';
import { ToolNames } from '../tools/tool-names.js';
import { AgentTerminateMode } from './runtime/agent-types.js';
import { SubagentError, SubagentErrorCode } from '../subagents/types.js';
import { AgentEventEmitter } from './runtime/agent-events.js';
import {
  getCurrentAgentDepth,
  runWithAgentConfiguredToolAllowlist,
} from './runtime/agent-context.js';
import { AgentHeadless } from './runtime/agent-headless.js';
import {
  getInvocationContext,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../utils/invocation-context.js';
import {
  FORK_DEFAULT_MAX_TURNS,
  FORK_SUBAGENT_TYPE,
  buildChildMessage,
} from '../tools/agent/fork-subagent.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

type ExecuteContext = { get: (key: string) => unknown };

const T0 = '2026-04-20T00:00:00.000Z';
/** A timestamp `s` seconds into 2026-04-20T00:00, e.g. at('01.000'). */
const at = (s: string) => `2026-04-20T00:00:${s}Z`;
const FORK = {
  agentType: FORK_SUBAGENT_TYPE,
  subagentName: FORK_SUBAGENT_TYPE,
};
const UNAVAILABLE =
  'current parent system prompt or tool surface is unavailable';
const FINISHED = 'Finished research';
const makeStats = () => ({
  totalTokens: 42,
  outputTokens: 17,
  toolUses: 3,
  durationMs: 1200,
});
const makeActivities = () => [
  { name: 'Read', description: 'read src/index.ts', at: 1 },
  { name: 'Bash', description: 'npm test', at: 2 },
];
const fullSummary = () => ({
  rounds: 0,
  totalToolCalls: 0,
  successfulToolCalls: 0,
  failedToolCalls: 0,
  successRate: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  toolUsage: [],
  totalDurationMs: 0,
});

const rec = (
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  timestamp: string,
  type: string,
  fields: object,
) => ({ uuid, parentUuid, sessionId, timestamp, type, ...fields });

/** The opening `u1` user record of a seeded transcript. */
const userRec = (sessionId: string, text: string) =>
  rec('u1', null, sessionId, T0, 'user', { message: userText(text) });

function writeJsonl(file: string, ...records: object[]) {
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

// Headless subagent stub ending GOAL/'done'; overrides replace or add members.
// Optional ones (executeExternalInputs, setExternalMessage*) stay absent.
function stubSubagent<T extends object = object>(overrides = {} as T) {
  const base = {
    execute: vi.fn(async (_context: ExecuteContext) => undefined),
    setExternalMessageProvider: vi.fn(),
    getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
    getExecutionSummary: () => ({
      totalTokens: 0,
      outputTokens: 0,
      totalDurationMs: 0,
    }),
    getTerminateMode: () => AgentTerminateMode.GOAL,
    getFinalText: () => 'done',
  };
  return { ...base, ...overrides } as Omit<typeof base, keyof T> & T;
}

/** An execute mock whose run stays pending until `release()`. */
function gatedExecute() {
  let release: (() => void) | undefined;
  const execute = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { execute, release: () => release?.() };
}

describe('BackgroundAgentResumeService', () => {
  let tempDir: string;
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-agent-resume-'));
    registry = new BackgroundTaskRegistry();
  });

  afterEach(() => {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  function createService(
    options: {
      stopHookBlockingCap?: number;
      currentForkRuntime?: {
        systemInstruction: string | Content;
        advertisedTools: FunctionDeclaration[];
        registeredTools?: FunctionDeclaration[];
      };
      // Capability context for the non-empty branches of
      // buildForkResumeCapabilityReminder (MCP instructions, skills, deferred
      // tools); the defaults keep the reminder minimal.
      mcpServerInstructions?: Map<string, string>;
      overrideMcpServerInstructions?: Map<string, string>;
      deferredToolSummary?: Array<{
        name: string;
        description: string;
        serverName?: string;
      }>;
      skillManager?: unknown;
      /**
       * Tool names the stub registry reports as registered, on top of any
       * `currentForkRuntime` declarations. `getInitialChatHistory` ANDs the
       * caller's `includeAvailableSkillsReminder` with
       * `toolRegistry.getAllToolNames().includes(ToolNames.SKILL)` (#12838), so
       * a test asserting that the listing reaches `initialMessages` must also
       * say the Skill tool is registered. Without it every row answers "no
       * listing" for the registry's reason rather than the predicate's, and the
       * negative rows pass vacuously.
       */
      registeredToolNames?: string[];
      toolMode?: ToolMode;
      hookSystem?:
        | {
            fireSubagentStartEvent: ReturnType<typeof vi.fn>;
            fireSubagentStopEvent: ReturnType<typeof vi.fn>;
          }
        | undefined;
      /** When set, createAgentHeadless resolves to `{ subagent, dispose }`. */
      subagent?: object;
    } = {},
  ) {
    const subagentManager = {
      loadSubagent: vi.fn(async (name: string) =>
        name === 'researcher'
          ? {
              name: 'researcher',
              color: 'cyan',
              model: undefined as string | undefined,
              approvalMode: undefined as string | undefined,
            }
          : null,
      ),
      createAgentHeadless: vi.fn(),
    };
    const dispose = vi.fn().mockResolvedValue(undefined);
    if (options.subagent) {
      subagentManager.createAgentHeadless.mockResolvedValue({
        subagent: options.subagent,
        dispose,
      });
    }
    const hookSystem =
      options.hookSystem !== undefined
        ? options.hookSystem
        : {
            fireSubagentStartEvent: vi.fn().mockResolvedValue(undefined),
            fireSubagentStopEvent: vi.fn().mockResolvedValue(undefined),
          };
    const liveTools =
      options.currentForkRuntime?.registeredTools ??
      options.currentForkRuntime?.advertisedTools ??
      [];
    // Exposed on both `parent.getToolRegistry()` and the override that
    // createApprovalModeOverride rebuilds on the resumed agent's Config so
    // bound tools resolve to it (PR #3873); without it every resume throws.
    const stubToolRegistry = {
      copyDiscoveredToolsFrom: vi.fn(),
      registerFactory: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi
        .fn()
        .mockReturnValue([
          ...new Set([
            ...liveTools
              .map((declaration) => declaration.name)
              .filter((name): name is string => Boolean(name)),
            ...(options.registeredToolNames ?? []),
          ]),
        ]),
      getTool: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      warmAll: vi.fn().mockResolvedValue(undefined),
      getDeferredToolSummary: vi
        .fn()
        .mockReturnValue(options.deferredToolSummary ?? []),
      isDeferredToolRevealed: vi.fn().mockReturnValue(false),
      getMcpServerInstructions: vi
        .fn()
        .mockReturnValue(options.mcpServerInstructions ?? new Map()),
      getFunctionDeclarationsFiltered: vi.fn((names: string[]) =>
        liveTools.filter(
          (declaration) =>
            declaration.name !== undefined && names.includes(declaration.name),
        ),
      ),
    };
    const overrideToolRegistry =
      options.overrideMcpServerInstructions === undefined
        ? stubToolRegistry
        : {
            ...stubToolRegistry,
            getMcpServerInstructions: vi
              .fn()
              .mockReturnValue(options.overrideMcpServerInstructions),
          };
    const permissionManager = {
      stripDangerousRulesForAutoMode: vi.fn(),
      restoreDangerousRules: vi.fn(),
    };
    const monitorRegistry = {
      setAgentNotificationCallback: vi.fn(),
      setAgentLifecycleCallback: vi.fn(),
      cancelRunningForOwner: vi.fn(),
    };
    const config = {
      storage: {
        getProjectDir: () => tempDir,
      },
      getBackgroundTaskRegistry: () => registry,
      getAgentExecutionBackend: () => undefined,
      getMonitorRegistry: () => monitorRegistry,
      getSubagentManager: () => subagentManager,
      getHookSystem: () => hookSystem,
      getStopHookBlockingCap: () => options.stopHookBlockingCap ?? 8,
      getApprovalMode: () => 'default',
      getToolMode: () => options.toolMode,
      getModel: () => 'parent-model',
      getBareMode: () => false,
      getSandbox: () => undefined,
      getScreenReader: () => false,
      getMaxSessionTurns: () => -1,
      getMaxToolCalls: () => -1,
      isTrustedFolder: () => true,
      isInteractive: () => false,
      getSessionId: () => 'session-1',
      getProjectRoot: () => tempDir,
      getCliVersion: () => 'test-version',
      getLlmClient: () =>
        options.currentForkRuntime
          ? {
              getChat: () => ({
                getGenerationConfig: () => ({
                  systemInstruction:
                    options.currentForkRuntime!.systemInstruction,
                  tools: [
                    {
                      functionDeclarations:
                        options.currentForkRuntime!.advertisedTools,
                    },
                  ],
                }),
              }),
            }
          : undefined,
      getSkillManager: () => options.skillManager,
      getDisabledSkillNames: () => new Set<string>(),
      isSkillEnabled: () => true,
      getModelInvocableCommandsProvider: () => undefined,
      getSkipStartupContext: () => true,
      getTranscriptPath: () => path.join(tempDir, 'session.jsonl'),
      getToolRegistry: () => stubToolRegistry,
      createToolRegistry: vi.fn().mockResolvedValue(overrideToolRegistry),
      getPermissionManager: () => permissionManager,
    } as unknown as Config;

    return {
      service: new BackgroundAgentResumeService(config),
      subagentManager,
      hookSystem,
      monitorRegistry,
      config,
      permissionManager,
      stubToolRegistry,
      dispose,
    };
  }

  const agentPaths = (sessionId: string, agentId: string) => ({
    metaPath: getAgentMetaPath(tempDir, sessionId, agentId),
    outputFile: getAgentJsonlPath(tempDir, sessionId, agentId),
  });

  // Meta sidecar with the fixture defaults. A field set to `undefined` is
  // dropped by JSON serialization, reproducing a sidecar without that key.
  function seedMeta(
    sessionId: string,
    agentId: string,
    description: string,
    fields: Partial<AgentMeta> = {},
    metaPath = getAgentMetaPath(tempDir, sessionId, agentId),
  ) {
    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description,
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: T0,
      status: 'running',
      subagentName: 'researcher',
      ...fields,
    });
    return metaPath;
  }

  function register(
    agentId: string,
    description: string,
    fields: Partial<AgentTaskRegistration> = {},
  ) {
    registry.register({
      agentId,
      description,
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      ...fields,
    } as AgentTaskRegistration);
  }

  /** An interrupted run's sidecar (mode 'default') and one-record transcript. */
  function seedSidecar(
    sessionId: string,
    agentId: string,
    description: string,
    meta: Partial<AgentMeta> = {},
    text = description,
  ) {
    const paths = agentPaths(sessionId, agentId);
    seedMeta(sessionId, agentId, description, {
      resolvedApprovalMode: 'default',
      ...meta,
    });
    writeJsonl(paths.outputFile, userRec(sessionId, text));
    return paths;
  }

  /** seedSidecar plus the paused registry entry discovery would create. */
  function seedPaused(
    sessionId: string,
    agentId: string,
    description: string,
    meta: Partial<AgentMeta> = {},
    text = description,
  ) {
    const paths = seedSidecar(sessionId, agentId, description, meta, text);
    register(agentId, description, {
      subagentType: meta.agentType ?? 'researcher',
      prompt: description,
      ...paths,
    });
    return paths;
  }

  // A paused fork whose transcript holds the agent_bootstrap history, the
  // launch prompt and its display record, and optionally a model reply.
  function seedPausedFork(
    sessionId: string,
    agentId: string,
    description: string,
    prompt: string,
    history: Content[],
    {
      meta = {},
      payload = {},
      reply,
    }: { meta?: Partial<AgentMeta>; payload?: object; reply?: string } = {},
  ) {
    const paths = agentPaths(sessionId, agentId);
    seedMeta(sessionId, agentId, description, {
      ...FORK,
      resolvedApprovalMode: 'default',
      ...meta,
    });
    writeJsonl(
      paths.outputFile,
      rec('sys1', null, sessionId, T0, 'system', {
        subtype: 'agent_bootstrap',
        systemPayload: { kind: 'fork', history, ...payload },
      }),
      rec('u1', 'sys1', sessionId, at('00.100'), 'user', {
        message: userText(prompt),
      }),
      rec('sys2', 'u1', sessionId, at('00.200'), 'system', {
        subtype: 'agent_launch_prompt',
        systemPayload: { displayText: buildChildMessage(prompt) },
      }),
      ...(reply === undefined
        ? []
        : [
            rec('a1', 'sys2', sessionId, at('01.000'), 'assistant', {
              message: modelText(reply),
            }),
          ]),
    );
    register(agentId, description, {
      subagentType: FORK_SUBAGENT_TYPE,
      prompt,
      ...paths,
    });
    return paths;
  }

  // Seeds a resumable fork task with a complete bootstrap transcript so
  // resumeBackgroundAgent reaches resolveCurrentForkRuntime — the branch under
  // test — rather than short-circuiting earlier on a missing transcript.
  const seedResumableForkTask = (sessionId: string, agentId: string) =>
    seedPausedFork(
      sessionId,
      agentId,
      'Fork task pending capability rebind',
      'Fork task',
      [userText('bootstrap env')],
    );

  // Completed sidecar + transcript (optional 'All done' reply), then the real
  // terminal lifecycle: register running, then complete (sets notified=true).
  function seedCompleted(
    sessionId: string,
    agentId: string,
    {
      meta = {},
      reply = false,
      entry = {},
      stats,
    }: {
      meta?: Partial<AgentMeta>;
      reply?: boolean;
      entry?: Partial<AgentTaskRegistration>;
      stats?: AgentCompletionStats;
    } = {},
  ) {
    const paths = agentPaths(sessionId, agentId);
    seedMeta(sessionId, agentId, FINISHED, {
      status: 'completed',
      resolvedApprovalMode: 'default',
      ...meta,
    });
    writeJsonl(
      paths.outputFile,
      userRec(sessionId, FINISHED),
      ...(reply
        ? [
            rec('a1', 'u1', sessionId, at('01.000'), 'assistant', {
              message: modelText('All done'),
            }),
          ]
        : []),
    );
    register(agentId, FINISHED, { status: 'running', ...paths, ...entry });
    registry.complete(agentId, 'All done', stats);
    return paths;
  }

  const waitForStatus = (agentId: string, status: string) =>
    vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe(status);
    });

  // Spies AgentHeadless.create so the real subagent's execute records its
  // context and the error processFunctionCalls reports for `deniedTool`.
  function spyForkCreate(
    deniedTool: string,
    promptId: string,
    toolsList: FunctionDeclaration[],
  ) {
    const captured: { context?: unknown; deniedError?: unknown } = {};
    const originalCreate = AgentHeadless.create;
    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockImplementation(async (...args) => {
        const subagent = await originalCreate(...args);
        vi.spyOn(subagent, 'execute').mockImplementation(async (context) => {
          captured.context = context;
          const denial = await subagent
            .getCore()
            .processFunctionCalls(
              [{ id: 'call-denied', name: deniedTool, args: {} }],
              new AbortController(),
              promptId,
              1,
              toolsList,
            );
          captured.deniedError =
            denial.messages[0]?.parts?.[0]?.functionResponse?.response?.[
              'error'
            ];
        });
        vi.spyOn(subagent, 'getTerminateMode').mockReturnValue(
          AgentTerminateMode.GOAL,
        );
        vi.spyOn(subagent, 'getFinalText').mockReturnValue('done');
        return subagent;
      });
    return { createSpy, captured };
  }

  // Resuming must leave the fork paused with `reason` (and, when
  // `checkError`, no error) without building a subagent.
  async function expectForkResumeRefused(
    service: BackgroundAgentResumeService,
    agentId: string,
    checkError = true,
    reason = UNAVAILABLE,
  ) {
    const createSpy = vi.spyOn(AgentHeadless, 'create');
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(reason);
    if (checkError) {
      expect(registry.get(agentId)?.error).toBeUndefined();
    }
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  }

  // Resumes a paused agent whose run stays open, applies `stop`, then lets
  // the run end CANCELLED; returns the meta path to inspect.
  async function resumeThenStop(
    sessionId: string,
    agentId: string,
    description: string,
    stop: () => void,
  ) {
    const { metaPath } = seedPaused(sessionId, agentId, description);
    const gate = gatedExecute();
    const { service } = createService({
      subagent: stubSubagent({
        execute: gate.execute,
        getTerminateMode: () => AgentTerminateMode.CANCELLED,
        getFinalText: () => '',
      }),
    });
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();
    stop();
    gate.release();
    await waitForStatus(agentId, 'cancelled');
    return metaPath;
  }

  it('explains how to discover the roster after recovery', () => {
    const service = new BackgroundAgentResumeService({} as Config);
    expect(service.buildRecoveredBackgroundAgentsModelNotice(1)).toContain(
      'In Direct mode: If the list_agents tool is not in your tool list, review its schema with `tool_search` and then invoke it with `tool_call`.',
    );
    expect(service.buildRecoveredBackgroundAgentsNotice(1)).not.toContain(
      'tool_search',
    );
  });

  it('restores interrupted and completed background agents without notifying again', async () => {
    const sessionId = 'session-1';
    const runningAgentId = 'agent-running';
    const completedAgentId = 'agent-completed';
    const runningMetaPath = seedMeta(
      sessionId,
      runningAgentId,
      'Investigate retry handling',
      { isBackgrounded: true, resolvedApprovalMode: 'auto-edit' },
    );
    seedMeta(sessionId, completedAgentId, 'Already done', {
      status: 'completed',
      isBackgrounded: true,
      sessionWorkflow: true,
      lastUpdatedAt: at('02.000'),
      resolvedApprovalMode: 'auto-edit',
      stats: makeStats(),
      recentActivities: makeActivities(),
    });
    writeJsonl(
      getAgentJsonlPath(tempDir, sessionId, runningAgentId),
      userRec(sessionId, 'Investigate retry handling'),
      rec('u2', 'u1', sessionId, at('01.000'), 'assistant', {
        message: modelText('Working on it'),
      }),
    );
    writeJsonl(
      getAgentJsonlPath(tempDir, sessionId, completedAgentId),
      rec('c1', null, sessionId, T0, 'user', {
        agentId: completedAgentId,
        message: userText('Already done'),
      }),
    );

    const { service, subagentManager } = createService();
    const onNotification = vi.fn();
    registry.setNotificationCallback(onNotification);
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toMatchObject({
      agentId: runningAgentId,
      status: 'paused',
      description: 'Investigate retry handling',
      subagentType: 'researcher',
      prompt: 'Investigate retry handling',
      metaPath: runningMetaPath,
      outputFile: getAgentJsonlPath(tempDir, sessionId, runningAgentId),
    });
    expect(recovered[1]).toMatchObject({
      agentId: completedAgentId,
      status: 'completed',
      notified: true,
      description: 'Already done',
      outputFile: getAgentJsonlPath(tempDir, sessionId, completedAgentId),
      stats: makeStats(),
      recentActivities: makeActivities(),
    });
    expect(registry.get(runningAgentId)?.status).toBe('paused');
    expect(registry.get(completedAgentId)?.status).toBe('completed');
    expect(onNotification).not.toHaveBeenCalled();
    expect(subagentManager.loadSubagent).toHaveBeenCalledTimes(2);
    expect(subagentManager.loadSubagent).toHaveBeenCalledWith('researcher');
  });

  it('excludes foreground, legacy completed, and wrong-owner sidecars', async () => {
    const sessionId = 'session-owned';
    for (const [agentId, isBackgrounded, parentSessionId] of [
      ['foreground', false, sessionId],
      ['legacy-completed', undefined, sessionId],
      ['wrong-owner', true, 'other'],
    ] as const) {
      seedMeta(sessionId, agentId, agentId, {
        parentSessionId,
        status: 'completed',
        isBackgrounded,
      });
    }

    const { service, subagentManager } = createService();
    expect(await service.loadPausedBackgroundAgents(sessionId)).toEqual([]);
    expect(subagentManager.loadSubagent).not.toHaveBeenCalled();
  });

  it.each(
    (['metadata', 'operator', 'definition'] as const).flatMap((source) =>
      (['discovery', 'resume', 'revive'] as const).map((operation) => ({
        source,
        operation,
      })),
    ),
  )(
    'refuses $source container task $operation without creating a local runtime',
    async ({ source, operation }) => {
      const agentId = `container-${operation}`;
      const sessionId = 'session-container';
      const { metaPath, outputFile } = agentPaths(sessionId, agentId);
      const status = operation === 'resume' ? 'paused' : 'completed';
      seedMeta(sessionId, agentId, 'Container task', {
        status,
        isBackgrounded: true,
        ...(source === 'metadata'
          ? {
              isolation: 'container' as const,
              executionBackend: 'container' as const,
              workspaceIsolation: 'worktree' as const,
            }
          : {}),
      });
      writeJsonl(
        outputFile,
        rec('container-message', null, sessionId, T0, 'user', {
          agentId,
          cwd: tempDir,
          message: userText('Continue contained work'),
        }),
      );
      const { service, subagentManager, config, hookSystem } = createService();
      if (source === 'operator') {
        vi.spyOn(config, 'getAgentExecutionBackend').mockReturnValue(
          'container',
        );
      } else if (source === 'definition') {
        const definition = {
          ...(await subagentManager.loadSubagent('researcher'))!,
          executionBackend: 'container' as const,
        };
        subagentManager.loadSubagent.mockResolvedValue(definition);
      }
      if (operation === 'discovery') {
        await service.loadPausedBackgroundAgents(sessionId);
      } else {
        register(agentId, 'Container task', { status, outputFile, metaPath });
        const result =
          operation === 'resume'
            ? await service.resumeBackgroundAgent(agentId, 'Continue')
            : await service.reviveCompletedBackgroundAgent(agentId, 'Continue');
        expect(result).toBeUndefined();
      }
      expect(registry.get(agentId)?.resumeBlockedReason).toContain(
        'Container background tasks cannot be resumed',
      );
      expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
      expect(config.createToolRegistry).not.toHaveBeenCalled();
      expect(hookSystem.fireSubagentStartEvent).not.toHaveBeenCalled();
    },
  );

  it('keeps damaged and unsafe retained entries visible but non-continuable', async () => {
    const sessionId = 'session-unsafe';
    const missingId = 'missing-transcript';
    const wrongCwdId = 'wrong-cwd';
    const worktreeId = 'worktree-agent';
    for (const agentId of [missingId, wrongCwdId, worktreeId]) {
      seedMeta(sessionId, agentId, agentId, {
        status: 'completed',
        isBackgrounded: true,
        isolation: agentId === worktreeId ? 'worktree' : undefined,
      });
    }
    writeJsonl(
      getAgentJsonlPath(tempDir, sessionId, wrongCwdId),
      rec('u1', null, sessionId, T0, 'user', {
        agentId: wrongCwdId,
        cwd: path.join(tempDir, 'another-workspace'),
        message: userText('Unsafe cwd'),
      }),
    );
    writeJsonl(
      getAgentJsonlPath(tempDir, sessionId, worktreeId),
      rec('w1', null, sessionId, T0, 'user', {
        agentId: worktreeId,
        cwd: tempDir,
        message: userText('Worktree task'),
      }),
    );

    const { service } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(3);
    expect(registry.get(missingId)).toMatchObject({
      status: 'completed',
      resumeBlockedReason:
        'Background task transcript is missing or unreadable.',
    });
    expect(registry.get(wrongCwdId)).toMatchObject({
      status: 'completed',
      resumeBlockedReason:
        'Background task working directory does not match the restored session.',
    });
    expect(registry.get(worktreeId)).toMatchObject({
      status: 'completed',
      resumeBlockedReason:
        'Background task worktree isolation cannot be reconstructed after session restore.',
    });
    expect(
      await service.reviveCompletedBackgroundAgent(missingId, 'continue'),
    ).toBeUndefined();
  });

  it.each([
    'persisted',
    'definition',
    'legacy-model',
    'legacy-flags',
    'codex-persisted',
    'codex-definition',
  ] as const)(
    'blocks cold external resume using %s provenance',
    async (provenance) => {
      const sessionId = 'session-external';
      const agentId = 'external-agent';
      seedMeta(sessionId, agentId, 'External task', {
        createdAt: new Date().toISOString(),
        subagentName: undefined,
        executor:
          provenance === 'persisted'
            ? 'acp'
            : provenance === 'codex-persisted'
              ? 'codex'
              : undefined,
        model:
          provenance === 'legacy-model' ? 'external-acp:claude' : undefined,
        persistedCliFlags:
          provenance === 'legacy-flags'
            ? { model: 'external-acp:claude' }
            : undefined,
      });
      writeJsonl(getAgentJsonlPath(tempDir, sessionId, agentId), {
        uuid: 'u1',
        sessionId,
        type: 'user',
        message: userText('External task'),
      });
      const { service, subagentManager } = createService();
      if (provenance === 'definition' || provenance === 'codex-definition') {
        subagentManager.loadSubagent.mockResolvedValue({
          name: 'researcher',
          color: 'cyan',
          model: undefined,
          approvalMode: undefined,
          executor: {
            kind: provenance === 'codex-definition' ? 'codex' : 'acp',
            command: 'native-agent',
          },
        } as Awaited<ReturnType<typeof subagentManager.loadSubagent>>);
      }
      const recovered = await service.loadPausedBackgroundAgents(sessionId);
      expect(recovered[0]?.resumeBlockedReason).toContain(
        'External subagent session cannot be restored',
      );
      expect(await service.resumeBackgroundAgent(agentId)).toBeUndefined();
      // Recheck provenance at execution time, not only during discovery.
      recovered[0]!.resumeBlockedReason = undefined;
      expect(await service.resumeBackgroundAgent(agentId)).toBeUndefined();
      expect(registry.get(agentId)?.resumeBlockedReason).toContain(
        'External subagent session cannot be restored',
      );
      expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
    },
  );

  it('preserves model on recovered paused agents for per-model caps', async () => {
    const sessionId = 'session-model';
    const agentId = 'agent-model';
    seedSidecar(sessionId, agentId, 'Model-aware recovery test', {
      resolvedApprovalMode: undefined,
      model: 'qwen3-max',
    });

    const { service } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId,
      status: 'paused',
      model: 'qwen3-max',
    });
  });

  it('keeps interrupted fork tasks visible as paused entries', async () => {
    const sessionId = 'session-fork';
    const agentId = 'agent-fork';
    seedSidecar(sessionId, agentId, 'Implicit fork background task', FORK);

    const { service, subagentManager } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId,
      status: 'paused',
      subagentType: FORK_SUBAGENT_TYPE,
      prompt: 'Implicit fork background task',
    });
    expect(subagentManager.loadSubagent).not.toHaveBeenCalled();
  });

  it('restores the model from the meta sidecar for per-model cap accounting', async () => {
    const sessionId = 'session-model-resume';
    const agentId = 'agent-model-resume';
    seedSidecar(sessionId, agentId, 'Model-capped background task', {
      model: 'gemini-2.5-pro',
    });

    const { service } = createService();
    await service.loadPausedBackgroundAgents(sessionId);

    expect(registry.get(agentId)?.model).toBe('gemini-2.5-pro');
  });

  it('keeps missing subagents visible so they can be abandoned later', async () => {
    const sessionId = 'session-missing';
    const agentId = 'agent-missing';
    seedSidecar(
      sessionId,
      agentId,
      'Background task whose agent file is gone',
      {
        agentType: 'deleted-agent',
        subagentName: 'deleted-agent',
      },
    );

    const { service, subagentManager } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId,
      status: 'paused',
      subagentType: 'deleted-agent',
      resumeBlockedReason: 'Subagent "deleted-agent" is no longer available.',
    });
    expect(subagentManager.loadSubagent).toHaveBeenCalledWith('deleted-agent');
  });

  it('keeps a paused agent listed when its same-named definition now fails the executor guard (R12-3)', async () => {
    const sessionId = 'session-executor-refusal';
    const agentId = 'agent-executor-refusal';
    seedSidecar(
      sessionId,
      agentId,
      'Background task whose same-named definition now fails to load',
      {},
      'task',
    );

    const { service, subagentManager } = createService();
    // The R10-2/R11 executor refusal makes loadSubagent THROW for a same-named
    // file that failed to load. resolveResumeTarget must turn that into the
    // "unavailable" shape so discovery keeps the row listed with a
    // resumeBlockedReason; otherwise the per-sidecar catch swallows it into a
    // debug-only warning and the row vanishes from /tasks. Removing the
    // try/catch turns this red (recovered is empty).
    subagentManager.loadSubagent.mockRejectedValue(
      new SubagentError(
        'Agent file /test/project/.qwen/agents/researcher.md has an invalid executor block: it declares an executor but failed to load.',
        SubagentErrorCode.INVALID_CONFIG,
        'researcher',
      ),
    );
    const recovered = await service.loadPausedBackgroundAgents(sessionId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.resumeBlockedReason).toContain(
      'invalid executor block',
    );
  });

  it('keeps paused tasks resumable when they only carry a stale lastError', async () => {
    const sessionId = 'session-stale-error';
    const agentId = 'agent-stale-error';
    seedSidecar(sessionId, agentId, 'Interrupted task with stale error', {
      lastError: 'Temporary resume setup failed',
    });

    const { service } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId,
      status: 'paused',
      error: 'Temporary resume setup failed',
    });
    expect(recovered[0]?.resumeBlockedReason).toBeUndefined();
  });

  it('falls back to legacy agentType metadata when resume fields are missing', async () => {
    const sessionId = 'session-legacy';
    const agentId = 'agent-legacy';
    seedSidecar(sessionId, agentId, 'Legacy background task', {
      subagentName: undefined,
      resolvedApprovalMode: undefined,
    });

    const { service, subagentManager } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId,
      status: 'paused',
      subagentType: 'researcher',
      prompt: 'Legacy background task',
    });
    expect(subagentManager.loadSubagent).toHaveBeenCalledWith('researcher');
  });

  it('stamps the resumed prompt-avoidance policy where nested launches inherit it', async () => {
    // The policy must sit on the config the rebuilt tool registry binds to
    // (the createToolRegistry receiver), not on a wrapper above it, so a
    // nested AgentTool launched by the resumed agent inherits it through its
    // own config prototype chain. Mirrors the launch path in agent.ts.
    const agentId = 'agent-policy';
    seedPaused('session-policy', agentId, 'Resume policy stamp', {
      resolvedApprovalMode: 'auto-edit',
    });
    const { service, subagentManager } = createService({
      subagent: stubSubagent(),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();

    const createCall = subagentManager.createAgentHeadless.mock.calls.at(-1);
    expect(createCall).toBeDefined();
    const bgConfig = createCall![1] as Config;
    const contexts = vi.mocked(bgConfig.createToolRegistry).mock.contexts;
    // The runtime config IS the createToolRegistry receiver; a wrapper-only
    // stamp would leave these two distinct objects.
    expect(contexts[contexts.length - 1]).toBe(bgConfig);
    // Non-interactive harness → auto-deny, on the tool-bound config itself
    // and through any derived config's prototype chain.
    expect(bgConfig.getShouldAvoidPermissionPrompts()).toBe(true);
    expect(
      (Object.create(bgConfig) as Config).getShouldAvoidPermissionPrompts(),
    ).toBe(true);

    await waitForStatus(agentId, 'completed');
  });

  it('keeps prompts allowed through the chain for a resumed bubble-mode agent in an interactive session', async () => {
    // Mirror of the launch-path bubble test (agent.ts): a resumed `bubble`
    // agent in an INTERACTIVE session surfaces confirmations to the
    // Background-tasks dialog instead of auto-denying them, and nested
    // launches must inherit that policy through their prototype chains.
    const agentId = 'agent-bubble';
    seedPaused('session-bubble', agentId, 'Resume bubble policy', {
      resolvedApprovalMode: 'auto-edit',
    });
    const { service, subagentManager, config } = createService({
      subagent: stubSubagent(),
    });
    config.isInteractive = () => true;
    subagentManager.loadSubagent.mockResolvedValue({
      name: 'researcher',
      color: 'cyan',
      model: undefined,
      approvalMode: 'bubble',
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();

    const createCall = subagentManager.createAgentHeadless.mock.calls.at(-1);
    expect(createCall).toBeDefined();
    const bgConfig = createCall![1] as Config;
    // Bubbling: prompts stay allowed (they park on the entry), and nested
    // launches inherit the same policy through the prototype chain.
    expect(bgConfig.getShouldAvoidPermissionPrompts()).toBe(false);
    expect(
      (Object.create(bgConfig) as Config).getShouldAvoidPermissionPrompts(),
    ).toBe(false);

    await waitForStatus(agentId, 'completed');
  });

  it('fires SubagentStart hooks when resuming and injects hook context', async () => {
    const sessionId = 'session-resume';
    const agentId = 'agent-resume';
    seedPaused(sessionId, agentId, 'Resume with hooks', {
      resolvedApprovalMode: 'auto-edit',
    });
    let resumedInvocation: InvocationContextV1 | undefined;
    const execute = vi.fn(async (_context: ExecuteContext) => {
      resumedInvocation = getInvocationContext();
    });
    const { service, subagentManager, hookSystem } = createService({
      subagent: stubSubagent({ execute }),
    });
    hookSystem.fireSubagentStartEvent.mockResolvedValue({
      getAdditionalContext: () => 'resume-context',
    });

    const resumed = await runWithInvocationContext(
      {
        version: 1,
        sessionId,
        promptId: 'stale-daemon-prompt',
        originatorClientId: 'stale-client',
      },
      () => service.resumeBackgroundAgent(agentId, 'continue'),
    );

    expect(resumed).toBeDefined();
    expect(subagentManager.createAgentHeadless).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        taskName: 'Resume with hooks',
        subagentId: agentId,
      }),
    );
    expect(hookSystem.fireSubagentStartEvent).toHaveBeenCalledWith(
      agentId,
      'researcher',
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const firstCall = execute.mock.calls[0];
    expect(firstCall).toBeDefined();
    const contextArg = firstCall![0];
    expect(contextArg).toBeDefined();
    if (!contextArg) {
      throw new Error('Expected resume execute context');
    }
    expect(contextArg.get('hook_context')).toBe('resume-context');
    expect(contextArg.get('task_prompt')).toBe('continue');
    expect(resumedInvocation).toBeUndefined();
    await waitForStatus(agentId, 'completed');
  });

  it('sets hook_context to empty string when no hook system is configured', async () => {
    const agentId = 'agent-no-hook';
    seedPaused('session-no-hook', agentId, 'Resume without hooks', {
      resolvedApprovalMode: 'auto-edit',
    });
    const subagent = stubSubagent();
    const { service } = createService({ hookSystem: undefined, subagent });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(subagent.execute).toHaveBeenCalledTimes(1);
    const contextArg = subagent.execute.mock.calls[0]![0];
    expect(contextArg.get('hook_context')).toBe('');
  });

  // #12424: the resumed agent is shown the skill listing exactly when
  // createAgentHeadless leaves its Config a SkillManager.
  it.each<
    [
      string,
      {
        tools?: string[] | string | null;
        disallowedTools?: string[] | string;
      },
      boolean,
      ToolMode?,
    ]
  >([
    ['inherits every tool', {}, true],
    [
      'disallows the Skill tool',
      { tools: ['*'], disallowedTools: [ToolNames.SKILL] },
      false,
    ],
    ['lists tools without skill', { tools: ['read_file'] }, false],
    // `tools: []` means "inherit everything" at the definition layer, so the
    // launch keeps the SkillManager and the resume must keep the listing.
    ['declares an empty tools list', { tools: [] }, true],
    // Launch reads `config.tools?.length`, which is falsy for `null` too, so
    // `null` is the wildcard and not the malformed case below.
    ['declares a null tools value', { tools: null }, true],
    // Launch hands `"*"` to `resolveToolNames`, whose `for...of` walks it per
    // character and preserves the `*`, so the launched agent keeps the
    // wildcard: resume must keep the listing, as base did through
    // `String.prototype.includes('*')`.
    ['declares a wildcard tools string', { tools: '*' }, true],
    // `''` is falsy in launch's `config.tools?.length` test, so `toolConfig`
    // stays unset and `createAgentHeadless` defaults it to `['*']`.
    ['declares an empty tools string', { tools: '' }, true],
    // Only unvalidated SDK `initialize.agents` JSON produces this. Launch walks
    // the string per character into nine entries naming no tool, so resume must
    // neither throw nor list.
    ['declares a non-array tools value', { tools: 'read_file' }, false],
    // Same ingress, sibling field. Launch resolves a scalar blocklist one
    // character at a time (`"skill"` → `['s','k','i','l','l']`), so it denies
    // nothing and the agent keeps the Skill tool: resume must neither throw
    // (`blocklist.some is not a function`) nor drop the listing.
    [
      'declares a non-array disallowedTools value',
      { disallowedTools: ToolNames.SKILL },
      true,
    ],
    // Under CodeModeOnly a finite list naming `exec` reaches `skill` through
    // the code-mode gateway, so launch keeps the manager and resume must keep
    // the listing. Dropping the tool-mode argument at the resume call site —
    // the parent Config here reports CodeModeOnly — turns this row red.
    [
      'names exec without skill under CodeModeOnly',
      { tools: [ToolNames.EXEC] },
      true,
      ToolMode.CodeModeOnly,
    ],
    // Same definition, Direct mode: no gateway, so no listing. Pins that the
    // row above is the tool mode and not the `exec` name doing the work.
    [
      'names exec without skill under Direct',
      { tools: [ToolNames.EXEC] },
      false,
    ],
  ])(
    'matches the launch-time skill listing when the definition %s',
    async (_label, toolFields, expectListing, toolMode) => {
      const sessionId = 'session-skill-listing';
      const agentId = 'agent-skill-listing';
      const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
      const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

      writeAgentMeta(metaPath, {
        agentId,
        agentType: 'researcher',
        description: 'Resume with skills',
        parentSessionId: sessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'running',
        subagentName: 'researcher',
        resolvedApprovalMode: 'auto-edit',
      });
      fs.writeFileSync(
        outputFile,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Resume with skills' }] },
        }) + '\n',
        'utf8',
      );
      registry.register({
        agentId,
        description: 'Resume with skills',
        subagentType: 'researcher',
        isBackgrounded: true,
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
        prompt: 'Resume with skills',
        outputFile,
        metaPath,
      });

      const subagent = {
        execute: vi.fn(async () => undefined),
        setExternalMessageProvider: vi.fn(),
        getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
        getExecutionSummary: () => ({
          totalTokens: 0,
          outputTokens: 0,
          totalDurationMs: 0,
        }),
        getTerminateMode: () => AgentTerminateMode.GOAL,
        getFinalText: () => 'done',
      };
      const { service, subagentManager } = createService({
        toolMode,
        // The session this resume runs in does have the Skill tool; the rows
        // below are about `subagentWillHaveSkillTool`, not about #12838's
        // registry gate. Omitting this made every row answer "no listing" for
        // the registry's reason and the two negative rows pass vacuously.
        registeredToolNames: [ToolNames.SKILL],
        skillManager: {
          listSkills: vi.fn().mockResolvedValue([
            {
              name: 'auto-skill-demo',
              description: 'Demo project skill',
              level: 'project',
              disableModelInvocation: false,
            },
          ]),
          isSkillActive: vi.fn().mockReturnValue(true),
        },
      });
      subagentManager.loadSubagent.mockResolvedValue({
        name: 'researcher',
        color: 'cyan',
        model: undefined,
        approvalMode: undefined,
        ...toolFields,
      } as never);
      subagentManager.createAgentHeadless.mockResolvedValue({
        subagent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      await service.resumeBackgroundAgent(agentId, 'continue');

      // Without this the two negative rows pass vacuously: a resume that never
      // reached createAgentHeadless renders no listing either.
      expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);

      const options = subagentManager.createAgentHeadless.mock.calls[0]?.[2] as
        | { promptConfigOverrides?: { initialMessages?: unknown[] } }
        | undefined;
      const initialMessages = JSON.stringify(
        options?.promptConfigOverrides?.initialMessages ?? [],
      );
      expect(initialMessages.includes('auto-skill-demo')).toBe(expectListing);
    },
  );

  it('returns only model-visible subagent output when resumed background agents complete', async () => {
    const agentId = 'agent-resume-sanitized';
    seedPaused(
      'session-resume-sanitized',
      agentId,
      'Resume with tagged result',
      {
        resolvedApprovalMode: 'auto-edit',
      },
    );
    const { service } = createService({
      subagent: stubSubagent({
        getExecutionSummary: fullSummary,
        getFinalText: () =>
          [
            '<analysis>',
            'Scratchpad details should stay out of the parent context.',
            '</analysis>',
            '',
            '<summary>',
            'Resume completed successfully',
            '</summary>',
          ].join('\n'),
      }),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await waitForStatus(agentId, 'completed');
    expect(registry.get(agentId)?.result).toBe('Resume completed successfully');
  });

  it('stores a fallback when resumed output has no model-visible text', async () => {
    const agentId = 'agent-resume-empty-visible';
    seedPaused(
      'session-resume-empty-visible',
      agentId,
      'Resume with scratchpad-only result',
      { resolvedApprovalMode: 'auto-edit' },
    );
    const { service } = createService({
      subagent: stubSubagent({
        getExecutionSummary: fullSummary,
        getFinalText: () => '<analysis>scratch only</analysis>',
      }),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await waitForStatus(agentId, 'completed');
    expect(registry.get(agentId)?.result).toBe(
      '(subagent produced no model-visible output)',
    );
  });

  it('can resume into the final background concurrency slot', async () => {
    registry = new BackgroundTaskRegistry({ maxConcurrentBackgroundAgents: 1 });
    const agentId = 'agent-resume-cap';
    seedPaused('session-resume-cap', agentId, 'Resume at cap');
    const subagent = stubSubagent();
    const { service } = createService({ subagent });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await waitForStatus(agentId, 'completed');
    expect(subagent.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a paused agent paused when resume cannot claim a background slot', async () => {
    registry = new BackgroundTaskRegistry({ maxConcurrentBackgroundAgents: 1 });
    const agentId = 'agent-resume-full';
    register('already-running', 'Already running', {
      status: 'running',
      outputFile: path.join(tempDir, 'already-running.jsonl'),
    });
    seedPaused('session-resume-full', agentId, 'Resume while full');
    const { service, subagentManager } = createService();

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.error).toContain(
      'maximum concurrent background agents (1) reached',
    );
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('passes the sidechain transcript path to SubagentStop hooks on resume', async () => {
    const agentId = 'agent-stop-hook';
    const { outputFile } = seedPaused(
      'session-stop-hook',
      agentId,
      'Resume stop hook path',
    );
    const { service, hookSystem } = createService({ subagent: stubSubagent() });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await vi.waitFor(() => {
      expect(hookSystem.fireSubagentStopEvent).toHaveBeenCalledWith(
        agentId,
        'researcher',
        outputFile,
        'done',
        false,
        expect.anything(),
        expect.any(AbortSignal),
      );
    });
  });

  it('appends a warning when resumed SubagentStop hooks reach the blocking cap', async () => {
    const agentId = 'agent-stop-hook-cap';
    seedPaused('session-stop-hook-cap', agentId, 'Resume cap path');
    const subagent = stubSubagent({ getFinalText: () => 'final output' });
    const { service, hookSystem } = createService({
      stopHookBlockingCap: 2,
      subagent,
    });
    hookSystem.fireSubagentStopEvent.mockResolvedValue({
      isBlockingDecision: vi.fn().mockReturnValue(true),
      shouldStopExecution: vi.fn().mockReturnValue(false),
      getEffectiveReason: vi.fn().mockReturnValue('Keep going'),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await waitForStatus(agentId, 'completed');
    expect(hookSystem.fireSubagentStopEvent).toHaveBeenCalledTimes(2);
    expect(subagent.execute).toHaveBeenCalledTimes(2);
    expect(registry.get(agentId)?.result).toContain(
      'SubagentStop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
    );
  });

  // Windows-24 GitHub Actions runners can take 10s+ on this fs-heavy setup
  // (meta + transcript writes + promise chain), past vitest's 5s default, so
  // the resume-config tests below raise the per-test timeout.
  it('downgrades persisted privileged approval modes when folder trust is revoked', async () => {
    const agentId = 'agent-untrusted';
    seedPaused('session-untrusted', agentId, 'Resume after trust revoked', {
      resolvedApprovalMode: 'yolo',
    });
    const { service, subagentManager, config } = createService({
      subagent: stubSubagent(),
    });
    Object.assign(config, {
      isTrustedFolder: () => false,
      getApprovalMode: () => 'default',
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    const [, overriddenConfig] =
      subagentManager.createAgentHeadless.mock.calls[0]!;
    expect(overriddenConfig.getApprovalMode()).toBe('default');
  }, 20000);

  it('restores persisted launch flags while resuming an agent', async () => {
    const agentId = 'agent-cli-flags';
    seedPaused(
      'session-cli-flags',
      agentId,
      'Resume with launch flags',
      {
        resolvedApprovalMode: 'auto-edit',
        persistedCliFlags: {
          approvalMode: 'auto-edit',
          bare: true,
          sandbox: { command: 'docker', image: 'qwen-code-sandbox' },
          screenReader: true,
          model: 'agent-model',
          authType: 'anthropic',
          baseUrl: 'https://launch-provider.example.com',
          maxSessionTurns: 7,
          maxToolCalls: 11,
          // Deliberately out of range: resume must re-normalize persisted
          // values with Config semantics (clamp to 1–100), so a malformed or
          // tampered sidecar cannot bypass the nesting cap.
          maxSubagentDepth: 5000,
        },
      },
      'Resume with flags',
    );
    const { service, subagentManager } = createService({
      subagent: stubSubagent(),
    });
    subagentManager.loadSubagent.mockResolvedValue({
      name: 'researcher',
      color: 'cyan',
      model: 'configured-model',
      approvalMode: undefined,
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    const [resumeConfig, overriddenConfig, createOptions] =
      subagentManager.createAgentHeadless.mock.calls[0]!;
    expect(resumeConfig.model).toBe('inherit');
    expect(overriddenConfig.getApprovalMode()).toBe('auto-edit');
    expect(overriddenConfig.getBareMode()).toBe(true);
    expect(overriddenConfig.getSandbox()).toEqual({
      command: 'docker',
      image: 'qwen-code-sandbox',
    });
    expect(overriddenConfig.getScreenReader()).toBe(true);
    expect(overriddenConfig.getModel()).toBe('agent-model');
    expect(createOptions.modelConfigOverrides).toEqual({
      model: 'agent-model',
    });
    expect(createOptions.runtimeAuthOverrides).toEqual({
      authType: 'anthropic',
      baseUrl: 'https://launch-provider.example.com',
    });
    expect(overriddenConfig.getMaxSessionTurns()).toBe(7);
    expect(overriddenConfig.getMaxToolCalls()).toBe(11);
    expect(overriddenConfig.getMaxSubagentDepth()).toBe(100);
  }, 20000);

  it.each([
    // Out-of-range values clamp with Config semantics.
    { persisted: 5000, expected: 100 },
    // This codebase never writes null, but a malformed or hand-edited JSON
    // sidecar can carry it; it must fall back to the default, not leak
    // through the getter override.
    { persisted: null as unknown as number, expected: 5 },
  ])(
    'normalizes persisted maxSubagentDepth $persisted to $expected on resume',
    async ({ persisted, expected }) => {
      const agentId = `agent-depth-norm-${expected}`;
      seedPaused(
        `session-depth-norm-${expected}`,
        agentId,
        'Resume with persisted depth cap',
        {
          resolvedApprovalMode: undefined,
          persistedCliFlags: { maxSubagentDepth: persisted },
        },
        'Resume',
      );
      const { service, subagentManager } = createService({
        subagent: stubSubagent(),
      });

      const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

      expect(resumed).toBeDefined();
      expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
      const [, overriddenConfig] =
        subagentManager.createAgentHeadless.mock.calls[0]!;
      expect(overriddenConfig.getMaxSubagentDepth()).toBe(expected);
    },
    20000,
  );

  it.each([
    // Resume runs from a top-level frame (depth would recompute to 0); the
    // persisted meta.depth must be pinned via the runWithAgentContext
    // depthOverride, or a resumed nested agent would regain spawn capacity.
    { persisted: 2, expected: 2 },
    // The sidecar is untrusted input: a tampered negative depth must fail
    // closed to the depth ceiling (no spawn capacity), not pin the frame at
    // a level that passes canSpawnNestedAgent() for every cap.
    { persisted: -50, expected: 100 },
  ])(
    'restores persisted launch depth $persisted as $expected on resume',
    async ({ persisted, expected }) => {
      const agentId = `agent-depth-${expected}`;
      seedPaused(`session-depth-${expected}`, agentId, 'Resume nested agent', {
        resolvedApprovalMode: undefined,
        parentAgentId: 'agent-parent',
        depth: persisted,
      });
      let observedDepth = -1;
      const { service } = createService({
        subagent: stubSubagent({
          execute: vi.fn(async () => {
            observedDepth = getCurrentAgentDepth();
          }),
        }),
      });

      const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

      expect(resumed).toBeDefined();
      await vi.waitFor(() => {
        expect(observedDepth).toBe(expected);
      });
    },
    20000,
  );

  it('coalesces concurrent resume calls into a single running agent', async () => {
    const agentId = 'agent-double';
    seedPaused('session-double', agentId, 'Resume once');
    const gate = gatedExecute();
    const executeExternalInputs = vi.fn().mockResolvedValue(undefined);
    const subagent = stubSubagent({
      execute: gate.execute,
      executeExternalInputs,
    });
    const { service, subagentManager } = createService({ subagent });

    const first = service.resumeBackgroundAgent(agentId, 'first message');
    const second = service.resumeBackgroundAgent(agentId, 'second message');

    await vi.waitFor(() => {
      expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    });
    expect(gate.execute).toHaveBeenCalledTimes(1);

    gate.release();
    await Promise.all([first, second]);
    await waitForStatus(agentId, 'completed');
    const provider = subagent.setExternalMessageProvider.mock.calls[0]?.[0] as
      | (() => string[])
      | undefined;
    expect(provider).toBeDefined();
    expect(executeExternalInputs).toHaveBeenCalledWith(
      ['second message'],
      expect.any(AbortSignal),
      { resetStats: false },
    );
    expect(provider?.()).toEqual([]);
  });

  it('routes owned monitor notifications into a resumed agent queue', async () => {
    const agentId = 'agent-monitor';
    seedPaused('session-monitor', agentId, 'Resume monitor owner');
    const gate = gatedExecute();
    const subagent = stubSubagent({
      execute: gate.execute,
      setExternalMessageWaiter: vi.fn(),
      setExternalMessageWaitPredicate: vi.fn(),
    });
    const { service, monitorRegistry } = createService({ subagent });

    const resume = service.resumeBackgroundAgent(agentId, 'continue');
    await vi.waitFor(() => {
      expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
        agentId,
        expect.any(Function),
      );
    });
    const callback = monitorRegistry.setAgentNotificationCallback.mock
      .calls[0][1] as (displayText: string, modelText: string) => void;

    callback('Monitor "logs" event #1: ready', '<task-notification />');

    expect(registry.get(agentId)?.pendingMessages).toContainEqual({
      kind: 'notification',
      text: '<task-notification />',
    });
    expect(subagent.setExternalMessageWaiter).toHaveBeenCalled();
    expect(subagent.setExternalMessageWaitPredicate).toHaveBeenCalled();
    const lifecycleCallback = monitorRegistry.setAgentLifecycleCallback.mock
      .calls[0][1] as () => void;
    registry.drainMessages(agentId);
    const waitPromise = registry.waitForMessages(
      agentId,
      new AbortController().signal,
    );

    lifecycleCallback();

    await expect(waitPromise).resolves.toEqual([]);
    gate.release();
    await resume;
    await waitForStatus(agentId, 'completed');
    expect(registry.disposeResidentAgent(agentId)).toBe(true);
    await vi.waitFor(() => {
      expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
        agentId,
        { notify: false },
      );
    });
  });

  it('cleans up owned monitor callbacks when resume setup fails before execution', async () => {
    const agentId = 'agent-monitor-setup-fail';
    seedPaused(
      'session-monitor-setup-fail',
      agentId,
      'Resume monitor setup failure',
    );
    const subagent = stubSubagent({
      execute: vi.fn(),
      setExternalMessageWaiter: vi.fn(),
      setExternalMessageWaitPredicate: vi.fn(),
      getCore: vi.fn(() => {
        throw new Error('setup failed');
      }),
    });
    const { service, monitorRegistry, stubToolRegistry, dispose } =
      createService({ subagent });

    await expect(
      service.resumeBackgroundAgent(agentId, 'continue'),
    ).resolves.toBeUndefined();

    expect(subagent.execute).not.toHaveBeenCalled();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(stubToolRegistry.stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    for (const callback of [expect.any(Function), undefined]) {
      expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
        agentId,
        callback,
      );
      expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
        agentId,
        callback,
      );
    }
    expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
      agentId,
      { notify: false },
    );
  });

  it.each([
    {
      format: 'persisted deny-all execution policy',
      legacyCapabilities: {},
      executionAllowedTools: [] as string[] | undefined,
      includeDisplayImage: false,
      deniedTool: 'Read',
      expectedExecutionAllowedTools: [],
    },
    {
      format: 'legacy capability snapshots',
      legacyCapabilities: {
        systemInstruction: {
          role: 'system' as const,
          parts: [{ text: 'persisted system instruction' }],
        },
        tools: [{ name: 'Bash' }, { name: 'mcp__removed__search' }],
      },
      executionAllowedTools: ['Read', ToolNames.ASK_USER_QUESTION] as
        | string[]
        | undefined,
      includeDisplayImage: false,
      deniedTool: 'Edit',
      expectedExecutionAllowedTools: [
        'Read',
        ToolNames.TOOL_SEARCH,
        ToolNames.TOOL_CALL,
      ],
    },
    {
      format: 'history-only bootstrap',
      legacyCapabilities: {},
      executionAllowedTools: undefined as string[] | undefined,
      includeDisplayImage: false,
      deniedTool: ToolNames.ASK_USER_QUESTION,
      expectedExecutionAllowedTools: [
        'Read',
        ToolNames.TOOL_SEARCH,
        ToolNames.TOOL_CALL,
        'Edit',
        'mcp__docs__search',
      ],
    },
    {
      format: 'legacy fork without a persisted display policy',
      legacyCapabilities: {},
      executionAllowedTools: undefined as string[] | undefined,
      includeDisplayImage: true,
      deniedTool: ToolNames.DISPLAY_IMAGE,
      expectedExecutionAllowedTools: [
        'Read',
        ToolNames.TOOL_SEARCH,
        ToolNames.TOOL_CALL,
        'Edit',
        'mcp__docs__search',
      ],
    },
  ])(
    'resumes fork agents with the current parent prompt and live tool registry ($format)',
    async ({
      legacyCapabilities,
      executionAllowedTools,
      includeDisplayImage,
      deniedTool,
      expectedExecutionAllowedTools,
    }) => {
      const agentId = 'agent-fork-resume';
      const launchPrompt = 'Investigate the retry loop and patch it';
      seedPausedFork(
        'session-fork-resume',
        agentId,
        launchPrompt,
        launchPrompt,
        [userText('bootstrap env'), modelText('bootstrap ack')],
        {
          meta: { executionAllowedTools },
          payload: legacyCapabilities,
          reply: 'Working silently',
        },
      );
      const { createSpy, captured } = spyForkCreate(
        deniedTool,
        'resume-policy-test',
        [
          { name: 'Read' },
          ...(includeDisplayImage ? [{ name: ToolNames.DISPLAY_IMAGE }] : []),
          { name: 'Edit' },
          { name: ToolNames.ASK_USER_QUESTION },
        ],
      );
      const currentSystemInstruction: Content = {
        role: 'system',
        parts: [{ text: 'current parent system instruction' }],
      };
      // The advertised and registered surfaces differ only in descriptions
      // and in their last (MCP) entry.
      const surface = (kind: string) => [
        { name: 'Read', description: `${kind} current schema` },
        {
          name: ToolNames.TOOL_SEARCH,
          description: `${kind} deferred tool search`,
        },
        {
          name: ToolNames.TOOL_CALL,
          description: `${kind} deferred tool call`,
        },
        ...(includeDisplayImage
          ? [
              {
                name: ToolNames.DISPLAY_IMAGE,
                description: `${kind} display schema`,
              },
            ]
          : []),
        { name: 'Edit', description: `${kind} edit schema` },
        {
          name: ToolNames.ASK_USER_QUESTION,
          description: `${kind} interactive question schema`,
        },
      ];
      const { service, subagentManager, stubToolRegistry } = createService({
        currentForkRuntime: {
          systemInstruction: currentSystemInstruction,
          advertisedTools: [
            ...surface('advertised'),
            { name: 'mcp__removed__search' },
          ],
          registeredTools: [
            ...surface('registered'),
            {
              name: 'mcp__docs__search',
              description: 'registered deferred MCP target',
            },
          ],
        },
      });
      const deniedBuild = vi.fn();
      stubToolRegistry.getTool.mockReturnValue({
        name: 'Edit',
        build: deniedBuild,
      });
      const resumed = await runWithAgentConfiguredToolAllowlist(['Read'], () =>
        service.resumeBackgroundAgent(agentId, 'continue'),
      );

      expect(resumed).toBeDefined();
      expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledTimes(1);
      const createArgs = createSpy.mock.calls[0];
      expect(createArgs).toBeDefined();
      expect(createArgs![2]).toMatchObject({
        renderedSystemPrompt: currentSystemInstruction,
        initialMessages: [
          userText('bootstrap env'),
          modelText('bootstrap ack'),
          userText(buildChildMessage(launchPrompt)),
          modelText('Working silently'),
        ],
      });
      expect(createArgs?.[4]).toEqual({
        max_turns: FORK_DEFAULT_MAX_TURNS,
      });
      expect(createArgs?.[5]).toEqual({
        tools: [
          'Read',
          ToolNames.TOOL_SEARCH,
          ToolNames.TOOL_CALL,
          ...(includeDisplayImage ? [ToolNames.DISPLAY_IMAGE] : []),
          'Edit',
          ToolNames.ASK_USER_QUESTION,
        ],
        executionAllowedTools: expectedExecutionAllowedTools,
      });
      expect(createArgs?.[9]).toBe(launchPrompt);
      expect(createArgs?.[10]).toBe(agentId);
      expect(captured.context).toBeDefined();
      const contextArg = captured.context as
        | { get(key: string): unknown }
        | undefined;
      expect(contextArg).toBeDefined();
      if (!contextArg) {
        throw new Error('Expected resume execute context');
      }
      expect(contextArg.get('task_prompt')).toContain(
        'Earlier capability listings in the conversation history are obsolete',
      );
      expect(contextArg.get('task_prompt')).toContain('continue');
      expect(captured.deniedError).toContain('execution allowlist');
      expect(captured.deniedError).not.toContain('not found');
      expect(stubToolRegistry.getTool).not.toHaveBeenCalled();
      expect(deniedBuild).not.toHaveBeenCalled();
      if (includeDisplayImage) {
        expect(stubToolRegistry.registerFactory).toHaveBeenCalledWith(
          ToolNames.DISPLAY_IMAGE,
          expect.any(Function),
        );
      }
      createSpy.mockRestore();
    },
  );

  it('restores the persisted disallowedTools blocklist on fork resume', async () => {
    // R29-1: the launch sidecar persisted only executionAllowedTools, so a
    // backgrounded fork resumed with its mcp__* allowlist but without the
    // disallowedTools blocklist that alone bounded it, and would execute the
    // very MCP tool the launching agent was configured never to reach.
    // Mutation check: dropping the disallowedTools restore in
    // createResumedForkSubagent turns this red (the mcp__* allowlist then
    // admits the call and deniedError stays undefined).
    const agentId = 'agent-fork-blocklist';
    const launchPrompt = 'Investigate the retry loop and patch it';
    seedPausedFork(
      'session-fork-blocklist',
      agentId,
      launchPrompt,
      launchPrompt,
      [userText('bootstrap env'), modelText('bootstrap ack')],
      {
        meta: {
          executionAllowedTools: ['mcp__*'],
          disallowedTools: ['mcp__slack'],
        },
        reply: 'Working silently',
      },
    );
    const deniedBuild = vi.fn();
    const { createSpy, captured } = spyForkCreate(
      'mcp__slack__post_message',
      'resume-blocklist-test',
      [{ name: 'Read' }, { name: 'mcp__slack__post_message' }],
    );
    const { service, stubToolRegistry } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        advertisedTools: [
          { name: 'Read', description: 'advertised read schema' },
          {
            name: 'mcp__slack__post_message',
            description: 'advertised slack schema',
          },
        ],
      },
    });
    // The allowlist's mcp__* pattern resolves through the registry's raw
    // server/tool identity, so the stub must supply it; otherwise the
    // mutation probe could not admit the call even with the blocklist lost.
    stubToolRegistry.getTool.mockReturnValue({
      name: 'mcp__slack__post_message',
      serverName: 'slack',
      serverToolName: 'post_message',
      build: deniedBuild,
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    const toolConfig = createSpy.mock.calls[0]?.[5];
    expect(toolConfig?.executionAllowedTools).toEqual(['mcp__*']);
    expect(toolConfig?.disallowedTools).toEqual(['mcp__slack']);
    expect(captured.deniedError).toContain('execution allowlist');
    expect(captured.deniedError).not.toContain('not found');
    expect(deniedBuild).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('keeps legacy fork tasks paused when transcript bootstrap is missing', async () => {
    const agentId = 'agent-fork-legacy';
    seedPaused('session-fork-legacy', agentId, 'Legacy fork task', {
      ...FORK,
      resolvedApprovalMode: 'auto',
    });
    const { service, permissionManager, stubToolRegistry } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        advertisedTools: [{ name: 'Read' }],
      },
    });

    await expectForkResumeRefused(
      service,
      agentId,
      true,
      'bootstrap transcript is missing',
    );
    expect(stubToolRegistry.stop).toHaveBeenCalledTimes(1);
    expect(
      permissionManager.stripDangerousRulesForAutoMode,
    ).toHaveBeenCalledTimes(1);
    expect(permissionManager.restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('keeps fork tasks paused when the current parent runtime is unavailable', async () => {
    const agentId = 'agent-fork-cap-legacy';
    seedPausedFork(
      'session-fork-cap-legacy',
      agentId,
      'Legacy fork task without capabilities',
      'Legacy fork task',
      [userText('bootstrap env')],
    );
    const { service } = createService();

    await expectForkResumeRefused(service, agentId, false);
  });

  it('refuses an old local fork under the operator container policy before warming host tools', async () => {
    const agentId = 'local-fork-now-contained';
    seedResumableForkTask('session-1', agentId);
    const { service, config, stubToolRegistry } = createService({
      currentForkRuntime: {
        systemInstruction: 'Current parent instructions',
        advertisedTools: [{ name: ToolNames.READ_FILE }],
      },
    });
    vi.spyOn(config, 'getAgentExecutionBackend').mockReturnValue('container');
    const createSpy = vi.spyOn(AgentHeadless, 'create');
    try {
      expect(
        await service.resumeBackgroundAgent(agentId, 'continue'),
      ).toBeUndefined();
      expect(registry.get(agentId)).toMatchObject({
        status: 'paused',
        resumeBlockedReason: expect.stringContaining('cannot be resumed'),
      });
      expect(stubToolRegistry.warmAll).not.toHaveBeenCalled();
      expect(config.createToolRegistry).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  it('keeps fork tasks paused when every advertised parent tool is excluded from subagents', async () => {
    const agentId = 'agent-fork-cap-excluded';
    seedResumableForkTask('session-fork-cap-excluded', agentId);
    const { service } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        // Every advertised tool is in EXCLUDED_TOOLS_FOR_SUBAGENTS, so the
        // filtered advertised-name set collapses to empty and the fork must
        // stay paused instead of resuming with no tools.
        advertisedTools: [
          { name: ToolNames.WORKFLOW },
          { name: ToolNames.AGENT },
        ],
      },
    });

    await expectForkResumeRefused(service, agentId);
  });

  it('keeps fork tasks paused when no advertised parent tool is still registered', async () => {
    const agentId = 'agent-fork-cap-unregistered';
    seedResumableForkTask('session-fork-cap-unregistered', agentId);
    const { service } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        advertisedTools: [{ name: 'mcp__removed__search' }],
        // The advertised tool is gone from the live registry, so the
        // registry filter resolves no tool and the fork stays paused.
        registeredTools: [],
      },
    });

    await expectForkResumeRefused(service, agentId);
  });

  it('injects live MCP, skill, and deferred-tool reminders into the resumed fork prompt', async () => {
    const agentId = 'agent-fork-cap-reminders';
    seedResumableForkTask('session-fork-cap-reminders', agentId);
    const subagent = stubSubagent();
    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockResolvedValue(subagent as unknown as AgentHeadless);

    const { service, stubToolRegistry } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        // SKILL must be in the resolved tool surface so the skills branch of
        // buildForkResumeCapabilityReminder runs.
        advertisedTools: [{ name: ToolNames.SKILL }, { name: 'Read' }],
        registeredTools: [{ name: ToolNames.SKILL }, { name: 'Read' }],
      },
      mcpServerInstructions: new Map([
        ['docs-server', 'Use ISO-8601 dates when calling docs tools.'],
      ]),
      // The resumed fork override owns a fresh registry whose MCP client
      // manager has no connected clients; capability reminders must still
      // read instructions from the live parent registry above.
      overrideMcpServerInstructions: new Map(),
      deferredToolSummary: [
        { name: 'web_search', description: 'Search the web.' },
      ],
      skillManager: {
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'auto-skill-demo',
            description: 'Demo project skill',
            level: 'project',
            disableModelInvocation: false,
          },
        ]),
        isSkillActive: vi.fn().mockReturnValue(true),
      },
    });

    // The deferred-tools reminder says "invoke it with tool_call", so model a
    // session where the bridge is registered: buildDeferredToolsReminder
    // suppresses the reminder when either bridge half is absent.
    stubToolRegistry.getTool.mockImplementation((name: string) =>
      name === ToolNames.TOOL_SEARCH || name === ToolNames.TOOL_CALL
        ? ({ name } as never)
        : undefined,
    );

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(subagent.execute).toHaveBeenCalledTimes(1);
    const contextArg = subagent.execute.mock.calls[0]?.[0];
    if (!contextArg) {
      throw new Error('Expected resume execute context');
    }
    const taskPrompt = String(contextArg.get('task_prompt'));

    // MCP server-instructions reminder branch.
    expect(taskPrompt).toContain('The text below was supplied by the MCP');
    expect(taskPrompt).toContain('docs-server');
    expect(taskPrompt).toContain('Use ISO-8601 dates when calling docs tools.');
    // Skills reminder branch (gated on ToolNames.SKILL being present).
    expect(taskPrompt).toContain(
      'The following skills are available for use with the Skill tool',
    );
    expect(taskPrompt).toContain('auto-skill-demo');
    // Deferred-tools reminder branch.
    expect(taskPrompt).toContain('web_search');
    expect(taskPrompt).toContain(ToolNames.TOOL_SEARCH);

    createSpy.mockRestore();
  });

  it('does not persist cancelled status on generic launch interruption recovery', async () => {
    const sessionId = 'session-running-shutdown';
    const agentId = 'agent-running-shutdown';
    const metaPath = seedMeta(sessionId, agentId, 'Interrupted by shutdown', {
      resolvedApprovalMode: 'default',
    });
    register(agentId, 'Interrupted by shutdown', {
      status: 'running',
      prompt: 'Interrupted by shutdown',
      metaPath,
      outputFile: getAgentJsonlPath(tempDir, sessionId, agentId),
    });

    registry.abortAll();

    expect(readMetaStatus(metaPath)).toBe('running');
  });

  it('keeps resumed tasks resumable after a generic shutdown abort', async () => {
    const metaPath = await resumeThenStop(
      'session-resume-shutdown',
      'agent-resume-shutdown',
      'Resume then shutdown',
      () => registry.abortAll(),
    );
    expect(readMetaStatus(metaPath)).toBe('running');
  });

  it('keeps explicit cancellation persisted after a resumed task stops', async () => {
    const agentId = 'agent-resume-cancelled';
    const metaPath = await resumeThenStop(
      'session-resume-cancelled',
      agentId,
      'Resume then cancel',
      () => registry.cancel(agentId),
    );
    expect(readMetaStatus(metaPath)).toBe('cancelled');
  });

  it.each([
    [
      'drops usage-only assistant records while preserving tool history and pending user text',
      false,
    ],
    [
      'drops unfinished nested calls and readiness markers while preserving stable history',
      true,
    ],
  ])('%s', async (_title, nested) => {
    const sessionId = 'session-pending-user';
    const agentId = 'agent-pending-user';
    const { metaPath, outputFile } = agentPaths(sessionId, agentId);
    seedMeta(sessionId, agentId, 'Pending user tail', {
      resolvedApprovalMode: 'default',
    });
    const readCall = content(
      'model',
      fnCall('read_file', { file_path: '/tmp/input.txt' }, 'read-1'),
    );
    const readResult = content(
      'user',
      fnResponse('read_file', { output: 'contents' }, 'read-1'),
    );
    // With `nested`, an unfinished nested call hangs off `u2` and becomes the
    // leaf, so the `a2`/`u3` branch is not on the resumed chain.
    writeJsonl(
      outputFile,
      userRec(sessionId, 'original task'),
      rec('usage-only', 'u1', sessionId, at('00.100'), 'assistant', {
        message: content('model'),
        usageMetadata: { totalTokenCount: 42 },
      }),
      rec('call-1', 'usage-only', sessionId, at('00.200'), 'assistant', {
        message: readCall,
      }),
      rec('result-1', 'call-1', sessionId, at('00.300'), 'tool_result', {
        message: readResult,
      }),
      rec('a1', 'result-1', sessionId, at('00.400'), 'assistant', {
        message: modelText('working'),
      }),
      rec('u2', 'a1', sessionId, at('00.500'), 'user', {
        message: userText('and another thing'),
      }),
      rec('a2', 'u2', sessionId, at('00.600'), 'assistant', {
        message: modelText('still working'),
      }),
      rec('u3', 'a2', sessionId, at('00.700'), 'user', {
        message: userText('one final constraint'),
      }),
      ...(nested
        ? [
            rec('nested-call', 'u2', sessionId, at('00.600'), 'assistant', {
              message: content('model', fnCall('agent', {}, 'nested')),
            }),
            rec(
              'nested-state',
              'nested-call',
              sessionId,
              at('00.700'),
              'system',
              {
                subtype: 'agent_session_ready',
                systemPayload: { callId: 'nested', subagentSessionReady: true },
              },
            ),
          ]
        : []),
    );
    register(agentId, 'Pending user tail', {
      prompt: 'original task',
      outputFile,
      metaPath,
    });
    const { service, subagentManager } = createService({
      subagent: stubSubagent({
        execute: vi.fn(async (context: ExecuteContext) => {
          expect(context.get('initial_messages_override')).toBeUndefined();
          expect(context.get('task_prompt')).toBe('continue work');
        }),
      }),
    });

    await service.resumeBackgroundAgent(agentId, 'continue work');

    expect(subagentManager.createAgentHeadless).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        promptConfigOverrides: {
          initialMessages: [
            userText('original task'),
            readCall,
            readResult,
            modelText('working'),
            userText('and another thing'),
            ...(nested
              ? []
              : [modelText('still working'), userText('one final constraint')]),
          ],
        },
      }),
    );
  });

  it('reconstructs a completed agent once, then reuses and disposes its resident runtime', async () => {
    const agentId = 'agent-revive';
    const { metaPath } = seedCompleted('session-revive', agentId, {
      meta: { resumeCount: 0 },
      reply: true,
      entry: { prompt: FINISHED },
    });
    const sessionDir = path.dirname(metaPath);
    const oldSessionMtime = new Date(T0);
    fs.utimesSync(sessionDir, oldSessionMtime, oldSessionMtime);
    const subagent = stubSubagent({ getFinalText: () => 'iterated' });
    const { execute } = subagent;
    const { service, subagentManager, dispose } = createService({ subagent });

    const revived = await service.reviveCompletedBackgroundAgent(
      agentId,
      'now write the summary',
    );

    expect(revived).toBeDefined();
    expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const contextArg = execute.mock.calls[0]?.[0];
    expect(contextArg).toBeDefined();
    expect(contextArg?.get('task_prompt')).toBe('now write the summary');
    await waitForStatus(agentId, 'completed');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.resumeCount).toBe(1);
    expect(fs.statSync(sessionDir).mtime.getTime()).toBeGreaterThan(
      oldSessionMtime.getTime(),
    );

    expect(registry.continueResidentAgent(agentId, 'tighten the summary')).toBe(
      'continued',
    );
    expect(registry.get(agentId)?.status).toBe('running');
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    const hotContextArg = execute.mock.calls[1]?.[0];
    expect(hotContextArg?.get('task_prompt')).toBe('tighten the summary');
    expect(readAgentMeta(metaPath)?.resumeCount).toBe(2);
    expect(dispose).not.toHaveBeenCalled();

    registry.reset();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.continueResidentAgent(agentId, 'again')).toBe(
      'not_completed',
    );
  });

  it("clears the previous incarnation's stats and activities when cold-reviving", async () => {
    const agentId = 'agent-revive-clear';
    const { metaPath } = seedCompleted('session-revive-clear', agentId, {
      meta: {
        resumeCount: 0,
        sessionWorkflow: true,
        stats: makeStats(),
        recentActivities: makeActivities(),
      },
      reply: true,
      entry: { prompt: FINISHED },
    });

    // Hold the first continuation turn open so the restarted run's
    // intermediate meta is observable.
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const { service } = createService({
      subagent: stubSubagent({
        execute: vi.fn(() => turnGate),
        getFinalText: () => 'iterated',
      }),
    });

    const revivePromise = service.reviveCompletedBackgroundAgent(
      agentId,
      'continue',
    );

    // The restarted run must not carry the completed run's terminal summary:
    // a crash in this window would otherwise let discovery restore run N-1's
    // stats/activities as the interrupted run's live state.
    await vi.waitFor(() => {
      expect(readAgentMeta(metaPath)?.status).toBe('running');
    });
    const meta = readAgentMeta(metaPath);
    expect(meta).not.toHaveProperty('stats');
    expect(meta).not.toHaveProperty('recentActivities');

    releaseTurn();
    await revivePromise;
    await waitForStatus(agentId, 'completed');
    registry.reset();
  });

  // The resume attach recomputes the transcript path instead of reusing the
  // registered outputFile, and must follow meta.parentSessionId, not the
  // current session (the divergence a CLI restart produces, reachable via
  // send-message revive). The registered outputFile is a decoy seeded with
  // the same chain, so a regression back to attaching it would land the
  // resumed record in the decoy and fail here.
  it('appends resumed records to the launch-session transcript when the current session differs', async () => {
    const launchSessionId = 'session-launch'; // config.getSessionId() is 'session-1'
    const agentId = 'agent-cross-session';
    const { metaPath, outputFile } = agentPaths(launchSessionId, agentId);
    // Diverges from the recomputed path the way a future registration path
    // could when it builds outputFile under a session dir other than
    // meta.parentSessionId.
    const decoyOutputFile = getAgentJsonlPath(
      tempDir,
      'session-registry-decoy',
      agentId,
    );
    seedMeta(launchSessionId, agentId, 'Cross-session resume', {
      status: 'completed',
      resolvedApprovalMode: 'default',
    });
    const seedRecords = [
      userRec(launchSessionId, 'original task'),
      rec('a1', 'u1', launchSessionId, at('01.000'), 'assistant', {
        message: modelText('partial answer'),
      }),
    ];
    writeJsonl(outputFile, ...seedRecords);
    // The revive gate and the recovery read the registered outputFile, so
    // the decoy carries the same seed chain.
    fs.mkdirSync(path.dirname(decoyOutputFile), { recursive: true });
    writeJsonl(decoyOutputFile, ...seedRecords);
    register(agentId, 'Cross-session resume', {
      status: 'running',
      prompt: 'original task',
      outputFile: decoyOutputFile,
      metaPath,
    });
    registry.complete(agentId, 'partial answer');
    const { service } = createService({
      subagent: stubSubagent({ getFinalText: () => 'continued' }),
    });

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'keep going'),
    ).resolves.toBeDefined();
    await waitForStatus(agentId, 'completed');

    // Resumed records land in the LAUNCH session's transcript, chained onto
    // its last stable record; the current session's dir stays untouched and
    // the decoy keeps exactly its seed records.
    const records = fs
      .readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      type: 'user',
      sessionId: launchSessionId,
      parentUuid: 'a1',
      message: userText('keep going'),
    });
    const decoyRecords = fs
      .readFileSync(decoyOutputFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim());
    expect(decoyRecords).toHaveLength(2);
    expect(
      fs.existsSync(getAgentJsonlPath(tempDir, 'session-1', agentId)),
    ).toBe(false);
  });

  it('cold-revives a completed worktree-isolated agent without retaining it', async () => {
    const agentId = 'completed-isolated';
    const metaPath = path.join(tempDir, `${agentId}.meta.json`);
    const outputFile = path.join(tempDir, `${agentId}.jsonl`);
    seedMeta(
      'session-isolated-revive',
      agentId,
      'Isolated result',
      { status: 'completed', isolation: 'worktree' },
      metaPath,
    );
    writeJsonl(
      outputFile,
      rec('isolated-result', null, 'session-isolated-revive', T0, 'user', {
        message: userText('Isolated result'),
      }),
    );
    register(agentId, 'Isolated result', {
      status: 'running',
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'done');
    const { service, subagentManager, dispose } = createService({
      subagent: stubSubagent({
        executeExternalInputs: vi.fn().mockResolvedValue(undefined),
        getFinalText: () => 'continued from transcript',
      }),
    });

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'continue'),
    ).resolves.toBeDefined();
    await waitForStatus(agentId, 'completed');

    expect(subagentManager.createAgentHeadless).toHaveBeenCalledOnce();
    expect(registry.continueResidentAgent(agentId, 'again')).toBe('fallback');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not revive non-completed or transcript-less entries', async () => {
    const { service, subagentManager } = createService();
    const revive = (agentId: string) =>
      service.reviveCompletedBackgroundAgent(agentId, 'go');

    // Still running → not revivable.
    register('still-running', 'r', {
      status: 'running',
      outputFile: '/tmp/x.jsonl',
      metaPath: '/tmp/x.meta.json',
    });
    await expect(revive('still-running')).resolves.toBeUndefined();

    // Completed but no metaPath → not revivable.
    register('completed-bare', 'c', {
      status: 'running',
      outputFile: '/tmp/y.jsonl',
    });
    registry.complete('completed-bare', 'done');
    await expect(revive('completed-bare')).resolves.toBeUndefined();

    // Failed (terminal but not completed) → not revivable.
    register('failed-agent', 'f', {
      status: 'running',
      outputFile: '/tmp/z.jsonl',
      metaPath: '/tmp/z.meta.json',
    });
    registry.fail('failed-agent', 'exploded');
    await expect(revive('failed-agent')).resolves.toBeUndefined();

    // Unknown id → not revivable.
    await expect(revive('nope')).resolves.toBeUndefined();

    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('does not mutate a completed entry when revive preflight fails', async () => {
    const { service, subagentManager } = createService();
    // [agentId, file stem, description]: no meta file at all, a meta without
    // its transcript, and a meta whose transcript is not JSON.
    const cases = [
      ['completed-missing-meta', 'missing-meta', 'missing meta'],
      ['completed-missing-output', 'missing-output', 'missing output'],
      ['completed-corrupt-output', 'corrupt-output', 'corrupt output'],
    ] as const;
    for (const [agentId, stem, description] of cases) {
      const metaPath = path.join(tempDir, `${stem}.meta.json`);
      const outputFile = path.join(tempDir, `${stem}.jsonl`);
      if (stem !== 'missing-meta') {
        seedMeta(
          `session-${stem}`,
          agentId,
          description,
          { status: 'completed', resolvedApprovalMode: 'default' },
          metaPath,
        );
      }
      if (stem === 'corrupt-output') {
        fs.writeFileSync(outputFile, 'not-json\n', 'utf8');
      }
      register(agentId, description, {
        status: 'running',
        outputFile,
        metaPath,
      });
      registry.complete(agentId, 'done');
    }

    for (const [agentId] of cases) {
      await expect(
        service.reviveCompletedBackgroundAgent(agentId, 'go'),
      ).resolves.toBeUndefined();
    }

    for (const [agentId] of cases) {
      expect(registry.get(agentId)?.status).toBe('completed');
      expect(registry.get(agentId)?.result).toBe('done');
    }
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('restores the completed entry when revive setup fails after the state flip', async () => {
    const agentId = 'agent-revive-setup-fails';
    const stats = makeStats();
    const recentActivities = makeActivities();
    const { metaPath } = seedCompleted('session-revive-setup-fails', agentId, {
      meta: { sessionWorkflow: true, stats, recentActivities },
      entry: { stats, recentActivities },
      stats,
    });
    const original = registry.get(agentId);
    expect(original?.notified).toBe(true);

    const restoredStates: Array<{
      status: string;
      notified: boolean;
      outputOffset: number;
    }> = [];
    registry.setStatusChangeCallback((entry) => {
      if (entry?.agentId === agentId && entry.status === 'completed') {
        restoredStates.push({
          status: entry.status,
          notified: entry.notified,
          outputOffset: entry.outputOffset,
        });
      }
    });
    const { service } = createService({
      subagent: stubSubagent({
        execute: vi.fn(),
        setExternalMessageProvider: vi.fn(() => {
          throw new Error('setup failed');
        }),
        getFinalText: () => 'iterated',
      }),
    });

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'keep going'),
    ).resolves.toBeUndefined();

    const restored = registry.get(agentId);
    expect(restored?.status).toBe('completed');
    expect(restored?.result).toBe('All done');
    expect(restored?.notified).toBe(true);
    expect(restoredStates.at(-1)).toEqual({
      status: 'completed',
      notified: true,
      outputOffset: original?.outputOffset,
    });
    const restoredMeta = readAgentMeta(metaPath);
    expect(restoredMeta?.lastError).toBeUndefined();
    expect(restoredMeta?.status).toBe('completed');
    expect(restoredMeta?.stats).toEqual(stats);
    expect(restoredMeta?.recentActivities).toEqual(recentActivities);
  });

  it('emits one start event and one terminal notification when a completed agent is revived', async () => {
    const agentId = 'agent-revive-notify';
    seedCompleted('session-revive-notify', agentId);
    expect(registry.get(agentId)?.notified).toBe(true);

    // Attach the callback only AFTER the initial completion so the assertion
    // counts the revived run's terminal notification in isolation.
    const notifications: string[] = [];
    registry.setNotificationCallback((_display, _model, meta) => {
      notifications.push(meta.status);
    });
    const started: string[] = [];
    registry.setRegisterCallback((entry) => {
      started.push(entry.status);
    });
    const { service } = createService({
      subagent: stubSubagent({ getFinalText: () => 'iterated' }),
    });

    await service.reviveCompletedBackgroundAgent(agentId, 'keep going');

    await waitForStatus(agentId, 'completed');
    expect(notifications).toEqual(['completed']);
    expect(started).toEqual(['running']);
  });

  it('does not revive when the background concurrency cap is full', async () => {
    registry = new BackgroundTaskRegistry({ maxConcurrentBackgroundAgents: 1 });
    const agentId = 'agent-revive-cap';
    // Complete the target first (so it doesn't count toward the running cap),
    // then fill the single slot with a live agent.
    seedCompleted('session-revive-cap', agentId);
    register('blocker', 'blocker', {
      status: 'running',
      outputFile: path.join(tempDir, 'blocker.jsonl'),
    });
    const { service, subagentManager } = createService();

    const revived = await service.reviveCompletedBackgroundAgent(
      agentId,
      'keep going',
    );

    // At-capacity revive fails cleanly: the finished entry is NOT stranded as
    // paused, and no agent run is started.
    expect(revived).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('completed');
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('preserves pre-revive activity state when a completed revive fails', async () => {
    const agentId = 'agent-revive-rollback-state';
    const stats = makeStats();
    const { metaPath } = seedCompleted(
      'session-revive-rollback-state',
      agentId,
      { stats },
    );
    // Populate the pre-revive UI state that must survive a failed revive.
    const activities = makeActivities();
    registry.get(agentId)!.recentActivities = activities;

    const { service, subagentManager } = createService();
    // Force the revive to fail after the entry has been transitioned to paused
    // (which resets `recentActivities` to []), exercising the rollback path.
    subagentManager.createAgentHeadless.mockRejectedValue(
      new Error('setup failed'),
    );

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'keep going'),
    ).resolves.toBeUndefined();

    const restored = registry.get(agentId);
    expect(restored?.status).toBe('completed');
    // Regression guard: a `??` fallback would keep the paused entry's empty
    // `recentActivities`, silently dropping the retained activities. The
    // completed snapshot must be restored instead.
    expect(restored?.recentActivities).toEqual(activities);
    expect(restored?.stats).toEqual(stats);
    const restoredMeta = readAgentMeta(metaPath);
    expect(restoredMeta).not.toHaveProperty('stats');
    expect(restoredMeta).not.toHaveProperty('recentActivities');
  });

  it('does not restore more completed agents than the terminal-agent cap', async () => {
    const sessionId = 'session-terminal-cap';
    const extra = 3;
    const total = MAX_RETAINED_TERMINAL_AGENTS + extra;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const agentId = `cap-agent-${String(i).padStart(3, '0')}`;
      ids.push(agentId);
      // Higher index → newer recovery timestamp, so the newest `cap` entries
      // (by `lastUpdatedAt`) are the ones that must survive the cap.
      seedMeta(sessionId, agentId, agentId, {
        status: 'completed',
        isBackgrounded: true,
        lastUpdatedAt: at(`${String(i).padStart(2, '0')}.000`),
      });
      writeJsonl(
        getAgentJsonlPath(tempDir, sessionId, agentId),
        rec(`u-${agentId}`, null, sessionId, T0, 'user', {
          message: userText(agentId),
        }),
      );
    }

    const { service } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    // Only the cap's worth of completed agents are admitted...
    expect(recovered).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
    expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
    // ...and they are the most recent by recovery timestamp; the oldest
    // `extra` sidecars are dropped rather than admitted over the cap.
    for (const id of ids.slice(extra)) {
      expect(registry.get(id)?.status).toBe('completed');
    }
    for (const id of ids.slice(0, extra)) {
      expect(registry.get(id)).toBeUndefined();
    }
  });
});

function readMetaStatus(metaPath: string): string | undefined {
  const raw = fs.readFileSync(metaPath, 'utf8');
  return JSON.parse(raw).status;
}
