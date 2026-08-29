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
} from './background-tasks.js';
import { BackgroundAgentResumeService } from './background-agent-resume.js';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  readAgentMeta,
  writeAgentMeta,
} from './agent-transcript.js';
import { ToolNames } from '../tools/tool-names.js';
import { AgentTerminateMode } from './runtime/agent-types.js';
import { AgentEventEmitter } from './runtime/agent-events.js';
import { getCurrentAgentDepth } from './runtime/agent-context.js';
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
      // Optional capability context used to exercise the non-empty branches of
      // buildForkResumeCapabilityReminder (MCP instructions, skills, and
      // deferred tools). Defaults keep the reminder minimal for other tests.
      mcpServerInstructions?: Map<string, string>;
      overrideMcpServerInstructions?: Map<string, string>;
      deferredToolSummary?: Array<{
        name: string;
        description: string;
        serverName?: string;
      }>;
      skillManager?: unknown;
      hookSystem?:
        | {
            fireSubagentStartEvent: ReturnType<typeof vi.fn>;
            fireSubagentStopEvent: ReturnType<typeof vi.fn>;
          }
        | undefined;
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
    const hookSystem =
      options.hookSystem !== undefined
        ? options.hookSystem
        : {
            fireSubagentStartEvent: vi.fn().mockResolvedValue(undefined),
            fireSubagentStopEvent: vi.fn().mockResolvedValue(undefined),
          };
    // Stub registry exposed on both `parent.getToolRegistry()` and the
    // override built by `createApprovalModeOverride` (which now rebuilds
    // the tool registry on the resumed agent's Config so bound tools
    // resolve to the resumed agent — see PR #3873). Without these
    // mocks the override helper throws and every resume test fails.
    const stubToolRegistry = {
      copyDiscoveredToolsFrom: vi.fn(),
      registerFactory: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi
        .fn()
        .mockReturnValue(
          (
            options.currentForkRuntime?.registeredTools ??
            options.currentForkRuntime?.advertisedTools ??
            []
          )
            .map((declaration) => declaration.name)
            .filter((name): name is string => Boolean(name)),
        ),
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
        (
          options.currentForkRuntime?.registeredTools ??
          options.currentForkRuntime?.advertisedTools ??
          []
        ).filter(
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
      getMonitorRegistry: () => monitorRegistry,
      getSubagentManager: () => subagentManager,
      getHookSystem: () => hookSystem,
      getStopHookBlockingCap: () => options.stopHookBlockingCap ?? 8,
      getApprovalMode: () => 'default',
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
    };
  }

  it('restores interrupted and completed background agents without notifying again', async () => {
    const sessionId = 'session-1';
    const runningAgentId = 'agent-running';
    const completedAgentId = 'agent-completed';

    const runningMetaPath = getAgentMetaPath(
      tempDir,
      sessionId,
      runningAgentId,
    );
    const completedMetaPath = getAgentMetaPath(
      tempDir,
      sessionId,
      completedAgentId,
    );

    writeAgentMeta(runningMetaPath, {
      agentId: runningAgentId,
      agentType: 'researcher',
      description: 'Investigate retry handling',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      isBackgrounded: true,
      subagentName: 'researcher',
      resolvedApprovalMode: 'auto-edit',
    });
    writeAgentMeta(completedMetaPath, {
      agentId: completedAgentId,
      agentType: 'researcher',
      description: 'Already done',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      isBackgrounded: true,
      lastUpdatedAt: '2026-04-20T00:00:02.000Z',
      subagentName: 'researcher',
      resolvedApprovalMode: 'auto-edit',
    });

    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, runningAgentId),
      [
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Investigate retry handling' }],
          },
        }),
        JSON.stringify({
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:01.000Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Working on it' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, completedAgentId),
      JSON.stringify({
        uuid: 'c1',
        parentUuid: null,
        sessionId,
        agentId: completedAgentId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Already done' }] },
      }) + '\n',
      'utf8',
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
    });
    expect(registry.get(runningAgentId)?.status).toBe('paused');
    expect(registry.get(completedAgentId)?.status).toBe('completed');
    expect(onNotification).not.toHaveBeenCalled();
    expect(subagentManager.loadSubagent).toHaveBeenCalledTimes(2);
    expect(subagentManager.loadSubagent).toHaveBeenCalledWith('researcher');
  });

  it('excludes foreground, legacy completed, and wrong-owner sidecars', async () => {
    const sessionId = 'session-owned';
    const cases = [
      {
        agentId: 'foreground',
        isBackgrounded: false,
        parentSessionId: sessionId,
      },
      { agentId: 'legacy-completed', parentSessionId: sessionId },
      {
        agentId: 'wrong-owner',
        isBackgrounded: true,
        parentSessionId: 'other',
      },
    ];

    for (const item of cases) {
      writeAgentMeta(getAgentMetaPath(tempDir, sessionId, item.agentId), {
        agentId: item.agentId,
        agentType: 'researcher',
        description: item.agentId,
        parentSessionId: item.parentSessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'completed',
        isBackgrounded: item.isBackgrounded,
        subagentName: 'researcher',
      });
    }

    const { service, subagentManager } = createService();
    expect(await service.loadPausedBackgroundAgents(sessionId)).toEqual([]);
    expect(subagentManager.loadSubagent).not.toHaveBeenCalled();
  });

  it('keeps damaged and unsafe retained entries visible but non-continuable', async () => {
    const sessionId = 'session-unsafe';
    const missingId = 'missing-transcript';
    const wrongCwdId = 'wrong-cwd';
    const worktreeId = 'worktree-agent';
    for (const agentId of [missingId, wrongCwdId, worktreeId]) {
      writeAgentMeta(getAgentMetaPath(tempDir, sessionId, agentId), {
        agentId,
        agentType: 'researcher',
        description: agentId,
        parentSessionId: sessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'completed',
        isBackgrounded: true,
        ...(agentId === worktreeId ? { isolation: 'worktree' as const } : {}),
        subagentName: 'researcher',
      });
    }
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, wrongCwdId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        agentId: wrongCwdId,
        cwd: path.join(tempDir, 'another-workspace'),
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Unsafe cwd' }] },
      }) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, worktreeId),
      JSON.stringify({
        uuid: 'w1',
        parentUuid: null,
        sessionId,
        agentId: worktreeId,
        cwd: tempDir,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Worktree task' }] },
      }) + '\n',
      'utf8',
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

  it('preserves model on recovered paused agents for per-model caps', async () => {
    const sessionId = 'session-model';
    const agentId = 'agent-model';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Model-aware recovery test',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      model: 'qwen3-max',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Model-aware recovery test' }],
        },
      }) + '\n',
      'utf8',
    );

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
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: FORK_SUBAGENT_TYPE,
      description: 'Implicit fork background task',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: FORK_SUBAGENT_TYPE,
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Implicit fork background task' }],
        },
      }) + '\n',
      'utf8',
    );

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
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Model-capped background task',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
      model: 'gemini-2.5-pro',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Model-capped background task' }],
        },
      }) + '\n',
      'utf8',
    );

    const { service } = createService();
    await service.loadPausedBackgroundAgents(sessionId);

    expect(registry.get(agentId)?.model).toBe('gemini-2.5-pro');
  });

  it('keeps missing subagents visible so they can be abandoned later', async () => {
    const sessionId = 'session-missing';
    const agentId = 'agent-missing';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'deleted-agent',
      description: 'Background task whose agent file is gone',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'deleted-agent',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Background task whose agent file is gone' }],
        },
      }) + '\n',
      'utf8',
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

  it('keeps paused tasks resumable when they only carry a stale lastError', async () => {
    const sessionId = 'session-stale-error';
    const agentId = 'agent-stale-error';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Interrupted task with stale error',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
      lastError: 'Temporary resume setup failed',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Interrupted task with stale error' }],
        },
      }) + '\n',
      'utf8',
    );

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
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Legacy background task',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
    });
    fs.writeFileSync(
      getAgentJsonlPath(tempDir, sessionId, agentId),
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Legacy background task' }] },
      }) + '\n',
      'utf8',
    );

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
    // (the createToolRegistry receiver) — not on a wrapper above it — so a
    // nested AgentTool launched by the resumed agent inherits it through its
    // own config prototype chain. Mirrors the launch path in agent.ts.
    const sessionId = 'session-policy';
    const agentId = 'agent-policy';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume policy stamp',
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
        message: { role: 'user', parts: [{ text: 'Resume policy stamp' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume policy stamp',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume policy stamp',
      outputFile,
      metaPath,
    });

    const subagent = {
      execute: vi.fn(async () => {}),
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

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();

    const createCall = subagentManager.createAgentHeadless.mock.calls.at(-1);
    expect(createCall).toBeDefined();
    const bgConfig = createCall![1] as Config;
    const contexts = vi.mocked(bgConfig.createToolRegistry).mock.contexts;
    // The runtime config IS the createToolRegistry receiver — the config
    // whose rebuilt registry a nested AgentTool binds to. A wrapper-only
    // stamp would leave these two distinct objects.
    expect(contexts[contexts.length - 1]).toBe(bgConfig);
    // Non-interactive harness → auto-deny, visible on the tool-bound config
    // itself and through any derived config's prototype chain.
    expect(bgConfig.getShouldAvoidPermissionPrompts()).toBe(true);
    expect(
      (Object.create(bgConfig) as Config).getShouldAvoidPermissionPrompts(),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
  });

  it('keeps prompts allowed through the chain for a resumed bubble-mode agent in an interactive session', async () => {
    // Mirror of the launch-path bubble test (agent.ts): a resumed agent of
    // a `bubble` definition in an INTERACTIVE session surfaces
    // confirmations to the Background-tasks dialog instead of auto-denying
    // them, and nested launches under it must inherit the same policy
    // through their config prototype chains.
    const sessionId = 'session-bubble';
    const agentId = 'agent-bubble';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume bubble policy',
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
        message: { role: 'user', parts: [{ text: 'Resume bubble policy' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume bubble policy',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume bubble policy',
      outputFile,
      metaPath,
    });

    const subagent = {
      execute: vi.fn(async () => {}),
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

    const { service, subagentManager, config } = createService();
    config.isInteractive = () => true;
    subagentManager.loadSubagent.mockResolvedValue({
      name: 'researcher',
      color: 'cyan',
      model: undefined,
      approvalMode: 'bubble',
    });
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
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

    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
  });

  it('fires SubagentStart hooks when resuming and injects hook context', async () => {
    const sessionId = 'session-resume';
    const agentId = 'agent-resume';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume with hooks',
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
        message: { role: 'user', parts: [{ text: 'Resume with hooks' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume with hooks',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume with hooks',
      outputFile,
      metaPath,
    });

    let resumedInvocation: InvocationContextV1 | undefined;
    const execute = vi.fn(
      async (_context: { get: (key: string) => unknown }) => {
        resumedInvocation = getInvocationContext();
      },
    );
    const setExternalMessageProvider = vi.fn();
    const subagent = {
      execute,
      setExternalMessageProvider,
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'done',
    };

    const { service, subagentManager, hookSystem } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
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
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
  });

  it('sets hook_context to empty string when no hook system is configured', async () => {
    const sessionId = 'session-no-hook';
    const agentId = 'agent-no-hook';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume without hooks',
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
        message: { role: 'user', parts: [{ text: 'Resume without hooks' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume without hooks',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume without hooks',
      outputFile,
      metaPath,
    });

    const execute = vi.fn(
      async (_context: { get: (key: string) => unknown }) => undefined,
    );
    const subagent = {
      execute,
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
      hookSystem: undefined,
    });
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const contextArg = execute.mock.calls[0]![0] as {
      get: (key: string) => unknown;
    };
    expect(contextArg.get('hook_context')).toBe('');
  });

  it('returns only model-visible subagent output when resumed background agents complete', async () => {
    const sessionId = 'session-resume-sanitized';
    const agentId = 'agent-resume-sanitized';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume with tagged result',
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
        message: {
          role: 'user',
          parts: [{ text: 'Resume with tagged result' }],
        },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume with tagged result',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume with tagged result',
      outputFile,
      metaPath,
    });

    const subagent = {
      execute: vi.fn(async () => undefined),
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
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
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
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
    };

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(registry.get(agentId)?.result).toBe('Resume completed successfully');
  });

  it('stores a fallback when resumed output has no model-visible text', async () => {
    const sessionId = 'session-resume-empty-visible';
    const agentId = 'agent-resume-empty-visible';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume with scratchpad-only result',
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
        message: {
          role: 'user',
          parts: [{ text: 'Resume with scratchpad-only result' }],
        },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume with scratchpad-only result',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume with scratchpad-only result',
      outputFile,
      metaPath,
    });

    const subagent = {
      execute: vi.fn(async () => undefined),
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
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
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => '<analysis>scratch only</analysis>',
    };

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(registry.get(agentId)?.result).toBe(
      '(subagent produced no model-visible output)',
    );
  });

  it('can resume into the final background concurrency slot', async () => {
    registry = new BackgroundTaskRegistry({
      maxConcurrentBackgroundAgents: 1,
    });
    const sessionId = 'session-resume-cap';
    const agentId = 'agent-resume-cap';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume at cap',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume at cap' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume at cap',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume at cap',
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

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(subagent.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a paused agent paused when resume cannot claim a background slot', async () => {
    registry = new BackgroundTaskRegistry({
      maxConcurrentBackgroundAgents: 1,
    });
    const sessionId = 'session-resume-full';
    const agentId = 'agent-resume-full';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    registry.register({
      agentId: 'already-running',
      description: 'Already running',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: path.join(tempDir, 'already-running.jsonl'),
    });

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume while full',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume while full' }] },
      }) + '\n',
      'utf8',
    );
    registry.register({
      agentId,
      description: 'Resume while full',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume while full',
      outputFile,
      metaPath,
    });

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
    const sessionId = 'session-stop-hook';
    const agentId = 'agent-stop-hook';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume stop hook path',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume stop hook path' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume stop hook path',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume stop hook path',
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

    const { service, subagentManager, hookSystem } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

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
    const sessionId = 'session-stop-hook-cap';
    const agentId = 'agent-stop-hook-cap';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume cap path',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume cap path' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume cap path',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume cap path',
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
      getFinalText: () => 'final output',
    };
    const stopOutput = {
      isBlockingDecision: vi.fn().mockReturnValue(true),
      shouldStopExecution: vi.fn().mockReturnValue(false),
      getEffectiveReason: vi.fn().mockReturnValue('Keep going'),
    };

    const { service, subagentManager, hookSystem } = createService({
      stopHookBlockingCap: 2,
    });
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    hookSystem.fireSubagentStopEvent.mockResolvedValue(stopOutput);

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(hookSystem.fireSubagentStopEvent).toHaveBeenCalledTimes(2);
    expect(subagent.execute).toHaveBeenCalledTimes(2);
    expect(registry.get(agentId)?.result).toContain(
      'SubagentStop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
    );
  });

  // Windows-24 GitHub Actions runners can take 10s+ on this fs-heavy
  // setup (writeAgentMeta + fs.writeFileSync + Promise resolution chain),
  // exceeding vitest's 5s default. Raise the per-test timeout so the
  // legitimate slow-runner case doesn't fail the suite.
  it('downgrades persisted privileged approval modes when folder trust is revoked', async () => {
    const sessionId = 'session-untrusted';
    const agentId = 'agent-untrusted';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume after trust revoked',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'yolo',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Resume after trust revoked' }],
        },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume after trust revoked',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume after trust revoked',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    const createAgentHeadless = vi.fn().mockResolvedValue({
      subagent: {
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
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const { service, subagentManager } = createService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).config.isTrustedFolder = () => false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).config.getApprovalMode = () => 'default';
    subagentManager.createAgentHeadless = createAgentHeadless;

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(createAgentHeadless).toHaveBeenCalledTimes(1);
    const [, overriddenConfig] = createAgentHeadless.mock.calls[0]!;
    expect(overriddenConfig.getApprovalMode()).toBe('default');
  }, 20000);

  it('restores persisted launch flags while resuming an agent', async () => {
    const sessionId = 'session-cli-flags';
    const agentId = 'agent-cli-flags';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume with launch flags',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
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
        // Deliberately out of range: the resume path must re-normalize
        // persisted values with Config semantics (clamp to 1–100), so a
        // malformed or tampered sidecar cannot bypass the nesting cap.
        maxSubagentDepth: 5000,
      },
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume with flags' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume with launch flags',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume with launch flags',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    const createAgentHeadless = vi.fn().mockResolvedValue({
      subagent: {
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
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const { service, subagentManager } = createService();
    subagentManager.loadSubagent.mockResolvedValue({
      name: 'researcher',
      color: 'cyan',
      model: 'configured-model',
      approvalMode: undefined,
    });
    subagentManager.createAgentHeadless = createAgentHeadless;

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(createAgentHeadless).toHaveBeenCalledTimes(1);
    const [resumeConfig, overriddenConfig, createOptions] =
      createAgentHeadless.mock.calls[0]!;
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
    // This codebase never writes null, but the sidecar is a plain JSON
    // file — a malformed or hand-edited copy can carry it; it must fall
    // back to the default, not leak through the getter override.
    { persisted: null as unknown as number, expected: 5 },
  ])(
    'normalizes persisted maxSubagentDepth $persisted to $expected on resume',
    async ({ persisted, expected }) => {
      const sessionId = `session-depth-norm-${expected}`;
      const agentId = `agent-depth-norm-${expected}`;
      const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
      const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

      writeAgentMeta(metaPath, {
        agentId,
        agentType: 'researcher',
        description: 'Resume with persisted depth cap',
        parentSessionId: sessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'running',
        subagentName: 'researcher',
        persistedCliFlags: { maxSubagentDepth: persisted },
      });
      fs.writeFileSync(
        outputFile,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Resume' }] },
        }) + '\n',
        'utf8',
      );

      registry.register({
        agentId,
        description: 'Resume with persisted depth cap',
        subagentType: 'researcher',
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
        prompt: 'Resume with persisted depth cap',
        outputFile,
        metaPath,
        isBackgrounded: true,
      });

      const createAgentHeadless = vi.fn().mockResolvedValue({
        subagent: {
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
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const { service, subagentManager } = createService();
      subagentManager.createAgentHeadless = createAgentHeadless;

      const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

      expect(resumed).toBeDefined();
      expect(createAgentHeadless).toHaveBeenCalledTimes(1);
      const [, overriddenConfig] = createAgentHeadless.mock.calls[0]!;
      expect(overriddenConfig.getMaxSubagentDepth()).toBe(expected);
    },
    20000,
  );

  it.each([
    // Resume happens from a top-level frame (depth would recompute to 0);
    // the persisted meta.depth must be pinned via the runWithAgentContext
    // depthOverride, or a resumed nested agent would regain spawn capacity.
    { persisted: 2, expected: 2 },
    // The sidecar is untrusted input: a tampered negative depth must fail
    // closed to the depth ceiling (no spawn capacity), not pin the frame
    // at a level that passes canSpawnNestedAgent() for every cap.
    { persisted: -50, expected: 100 },
  ])(
    'restores persisted launch depth $persisted as $expected on resume',
    async ({ persisted, expected }) => {
      const sessionId = `session-depth-${expected}`;
      const agentId = `agent-depth-${expected}`;
      const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
      const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

      writeAgentMeta(metaPath, {
        agentId,
        agentType: 'researcher',
        description: 'Resume nested agent',
        parentSessionId: sessionId,
        parentAgentId: 'agent-parent',
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'running',
        subagentName: 'researcher',
        depth: persisted,
      });
      fs.writeFileSync(
        outputFile,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Resume nested agent' }] },
        }) + '\n',
        'utf8',
      );

      registry.register({
        agentId,
        description: 'Resume nested agent',
        subagentType: 'researcher',
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
        prompt: 'Resume nested agent',
        outputFile,
        metaPath,
        isBackgrounded: true,
      });

      let observedDepth = -1;
      const createAgentHeadless = vi.fn().mockResolvedValue({
        subagent: {
          execute: vi.fn(async () => {
            observedDepth = getCurrentAgentDepth();
          }),
          setExternalMessageProvider: vi.fn(),
          getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
          getExecutionSummary: () => ({
            totalTokens: 0,
            outputTokens: 0,
            totalDurationMs: 0,
          }),
          getTerminateMode: () => AgentTerminateMode.GOAL,
          getFinalText: () => 'done',
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const { service, subagentManager } = createService();
      subagentManager.createAgentHeadless = createAgentHeadless;

      const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

      expect(resumed).toBeDefined();
      await vi.waitFor(() => {
        expect(observedDepth).toBe(expected);
      });
    },
    20000,
  );

  it('coalesces concurrent resume calls into a single running agent', async () => {
    const sessionId = 'session-double';
    const agentId = 'agent-double';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume once',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume once' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume once',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume once',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    let releaseExecute: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseExecute = resolve;
        }),
    );
    const executeExternalInputs = vi.fn().mockResolvedValue(undefined);
    const subagent = {
      execute,
      executeExternalInputs,
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

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const first = service.resumeBackgroundAgent(agentId, 'first message');
    const second = service.resumeBackgroundAgent(agentId, 'second message');

    await vi.waitFor(() => {
      expect(subagentManager.createAgentHeadless).toHaveBeenCalledTimes(1);
    });
    expect(execute).toHaveBeenCalledTimes(1);

    releaseExecute?.();
    await Promise.all([first, second]);
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
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
    const sessionId = 'session-monitor';
    const agentId = 'agent-monitor';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume monitor owner',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume monitor owner' }] },
      }) + '\n',
      'utf8',
    );
    registry.register({
      agentId,
      description: 'Resume monitor owner',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume monitor owner',
      outputFile,
      metaPath,
    });

    let releaseExecute: (() => void) | undefined;
    const subagent = {
      execute: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseExecute = resolve;
          }),
      ),
      setExternalMessageProvider: vi.fn(),
      setExternalMessageWaiter: vi.fn(),
      setExternalMessageWaitPredicate: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'done',
    };
    const { service, subagentManager, monitorRegistry } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

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
    releaseExecute?.();
    await resume;
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
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
        {
          notify: false,
        },
      );
    });
  });

  it('cleans up owned monitor callbacks when resume setup fails before execution', async () => {
    const sessionId = 'session-monitor-setup-fail';
    const agentId = 'agent-monitor-setup-fail';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume monitor setup failure',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Resume monitor setup failure' }],
        },
      }) + '\n',
      'utf8',
    );
    registry.register({
      agentId,
      description: 'Resume monitor setup failure',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume monitor setup failure',
      outputFile,
      metaPath,
    });

    const subagent = {
      execute: vi.fn(),
      setExternalMessageProvider: vi.fn(),
      setExternalMessageWaiter: vi.fn(),
      setExternalMessageWaitPredicate: vi.fn(),
      getCore: vi.fn(() => {
        throw new Error('setup failed');
      }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'done',
    };
    const { service, subagentManager, monitorRegistry, stubToolRegistry } =
      createService();
    const dispose = vi.fn().mockResolvedValue(undefined);
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose,
    });

    await expect(
      service.resumeBackgroundAgent(agentId, 'continue'),
    ).resolves.toBeUndefined();

    expect(subagent.execute).not.toHaveBeenCalled();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(stubToolRegistry.stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
      agentId,
      expect.any(Function),
    );
    expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
      agentId,
      expect.any(Function),
    );
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
      {
        notify: false,
      },
    );
  });

  it.each([
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
      expectedExecutionAllowedTools: ['Read'],
    },
    {
      format: 'history-only bootstrap',
      legacyCapabilities: {},
      executionAllowedTools: undefined as string[] | undefined,
      includeDisplayImage: false,
      deniedTool: ToolNames.ASK_USER_QUESTION,
      expectedExecutionAllowedTools: ['Read', 'Edit'],
    },
    {
      format: 'legacy fork without a persisted display policy',
      legacyCapabilities: {},
      executionAllowedTools: undefined as string[] | undefined,
      includeDisplayImage: true,
      deniedTool: ToolNames.DISPLAY_IMAGE,
      expectedExecutionAllowedTools: ['Read', 'Edit'],
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
      const sessionId = 'session-fork-resume';
      const agentId = 'agent-fork-resume';
      const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
      const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);
      const launchPrompt = 'Investigate the retry loop and patch it';

      writeAgentMeta(metaPath, {
        agentId,
        agentType: FORK_SUBAGENT_TYPE,
        description: launchPrompt,
        parentSessionId: sessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'running',
        subagentName: FORK_SUBAGENT_TYPE,
        resolvedApprovalMode: 'default',
        ...(executionAllowedTools !== undefined
          ? { executionAllowedTools }
          : {}),
      });
      fs.writeFileSync(
        outputFile,
        [
          JSON.stringify({
            uuid: 'sys1',
            parentUuid: null,
            sessionId,
            timestamp: '2026-04-20T00:00:00.000Z',
            type: 'system',
            subtype: 'agent_bootstrap',
            systemPayload: {
              kind: 'fork',
              history: [
                { role: 'user', parts: [{ text: 'bootstrap env' }] },
                { role: 'model', parts: [{ text: 'bootstrap ack' }] },
              ],
              ...legacyCapabilities,
            },
          }),
          JSON.stringify({
            uuid: 'u1',
            parentUuid: 'sys1',
            sessionId,
            timestamp: '2026-04-20T00:00:00.100Z',
            type: 'user',
            message: { role: 'user', parts: [{ text: launchPrompt }] },
          }),
          JSON.stringify({
            uuid: 'sys2',
            parentUuid: 'u1',
            sessionId,
            timestamp: '2026-04-20T00:00:00.200Z',
            type: 'system',
            subtype: 'agent_launch_prompt',
            systemPayload: {
              displayText: buildChildMessage(launchPrompt),
            },
          }),
          JSON.stringify({
            uuid: 'a1',
            parentUuid: 'sys2',
            sessionId,
            timestamp: '2026-04-20T00:00:01.000Z',
            type: 'assistant',
            message: { role: 'model', parts: [{ text: 'Working silently' }] },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      registry.register({
        agentId,
        description: launchPrompt,
        subagentType: FORK_SUBAGENT_TYPE,
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
        prompt: launchPrompt,
        outputFile,
        metaPath,
        isBackgrounded: true,
      });

      const originalCreate = AgentHeadless.create;
      let executeContext: unknown;
      let deniedError: unknown;
      const createSpy = vi
        .spyOn(AgentHeadless, 'create')
        .mockImplementation(async (...args) => {
          const subagent = await originalCreate(...args);
          vi.spyOn(subagent, 'execute').mockImplementation(async (context) => {
            executeContext = context;
            const denial = await subagent
              .getCore()
              .processFunctionCalls(
                [{ id: 'call-denied', name: deniedTool, args: {} }],
                new AbortController(),
                'resume-policy-test',
                1,
                [
                  { name: 'Read' },
                  ...(includeDisplayImage
                    ? [{ name: ToolNames.DISPLAY_IMAGE }]
                    : []),
                  { name: 'Edit' },
                  { name: ToolNames.ASK_USER_QUESTION },
                ],
              );
            deniedError =
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
      const currentSystemInstruction: Content = {
        role: 'system',
        parts: [{ text: 'current parent system instruction' }],
      };
      const { service, subagentManager, stubToolRegistry } = createService({
        currentForkRuntime: {
          systemInstruction: currentSystemInstruction,
          advertisedTools: [
            { name: 'Read', description: 'advertised current schema' },
            ...(includeDisplayImage
              ? [
                  {
                    name: ToolNames.DISPLAY_IMAGE,
                    description: 'advertised display schema',
                  },
                ]
              : []),
            { name: 'Edit', description: 'advertised edit schema' },
            {
              name: ToolNames.ASK_USER_QUESTION,
              description: 'advertised interactive question schema',
            },
            { name: 'mcp__removed__search' },
          ],
          registeredTools: [
            { name: 'Read', description: 'registered current schema' },
            ...(includeDisplayImage
              ? [
                  {
                    name: ToolNames.DISPLAY_IMAGE,
                    description: 'registered display schema',
                  },
                ]
              : []),
            { name: 'Edit', description: 'registered edit schema' },
            {
              name: ToolNames.ASK_USER_QUESTION,
              description: 'registered interactive question schema',
            },
          ],
        },
      });
      const deniedBuild = vi.fn();
      stubToolRegistry.getTool.mockReturnValue({
        name: 'Edit',
        build: deniedBuild,
      });
      const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

      expect(resumed).toBeDefined();
      expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledTimes(1);
      const createArgs = createSpy.mock.calls[0];
      expect(createArgs).toBeDefined();
      expect(createArgs![2]).toMatchObject({
        renderedSystemPrompt: currentSystemInstruction,
        initialMessages: [
          { role: 'user', parts: [{ text: 'bootstrap env' }] },
          { role: 'model', parts: [{ text: 'bootstrap ack' }] },
          { role: 'user', parts: [{ text: buildChildMessage(launchPrompt) }] },
          { role: 'model', parts: [{ text: 'Working silently' }] },
        ],
      });
      expect(createArgs?.[4]).toEqual({
        max_turns: FORK_DEFAULT_MAX_TURNS,
      });
      expect(createArgs?.[5]).toEqual({
        tools: [
          'Read',
          ...(includeDisplayImage ? [ToolNames.DISPLAY_IMAGE] : []),
          'Edit',
          ToolNames.ASK_USER_QUESTION,
        ],
        executionAllowedTools: expectedExecutionAllowedTools,
      });
      expect(createArgs?.[9]).toBe(launchPrompt);
      expect(createArgs?.[10]).toBe(agentId);
      expect(executeContext).toBeDefined();
      const contextArg = executeContext as
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
      expect(deniedError).toContain('execution allowlist');
      expect(deniedError).not.toContain('not found');
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

  it('keeps legacy fork tasks paused when transcript bootstrap is missing', async () => {
    const sessionId = 'session-fork-legacy';
    const agentId = 'agent-fork-legacy';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: FORK_SUBAGENT_TYPE,
      description: 'Legacy fork task',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: FORK_SUBAGENT_TYPE,
      resolvedApprovalMode: 'auto',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Legacy fork task' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Legacy fork task',
      subagentType: FORK_SUBAGENT_TYPE,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Legacy fork task',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    const createSpy = vi.spyOn(AgentHeadless, 'create');
    const { service, permissionManager, stubToolRegistry } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        advertisedTools: [{ name: 'Read' }],
      },
    });
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(
      'bootstrap transcript is missing',
    );
    expect(registry.get(agentId)?.error).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    expect(stubToolRegistry.stop).toHaveBeenCalledTimes(1);
    expect(
      permissionManager.stripDangerousRulesForAutoMode,
    ).toHaveBeenCalledTimes(1);
    expect(permissionManager.restoreDangerousRules).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });

  it('keeps fork tasks paused when the current parent runtime is unavailable', async () => {
    const sessionId = 'session-fork-cap-legacy';
    const agentId = 'agent-fork-cap-legacy';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: FORK_SUBAGENT_TYPE,
      description: 'Legacy fork task without capabilities',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: FORK_SUBAGENT_TYPE,
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      [
        JSON.stringify({
          uuid: 'sys1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'system',
          subtype: 'agent_bootstrap',
          systemPayload: {
            kind: 'fork',
            history: [{ role: 'user', parts: [{ text: 'bootstrap env' }] }],
          },
        }),
        JSON.stringify({
          uuid: 'u1',
          parentUuid: 'sys1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.100Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Legacy fork task' }] },
        }),
        JSON.stringify({
          uuid: 'sys2',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.200Z',
          type: 'system',
          subtype: 'agent_launch_prompt',
          systemPayload: {
            displayText: buildChildMessage('Legacy fork task'),
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Legacy fork task without capabilities',
      subagentType: FORK_SUBAGENT_TYPE,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Legacy fork task',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    const createSpy = vi.spyOn(AgentHeadless, 'create');
    const { service } = createService();
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(
      'current parent system prompt or tool surface is unavailable',
    );
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  // Seeds a resumable fork task with a complete bootstrap transcript so
  // resumeBackgroundAgent reaches resolveCurrentForkRuntime — the branch under
  // test — rather than short-circuiting earlier on a missing transcript.
  function seedResumableForkTask(sessionId: string, agentId: string) {
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: FORK_SUBAGENT_TYPE,
      description: 'Fork task pending capability rebind',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: FORK_SUBAGENT_TYPE,
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      [
        JSON.stringify({
          uuid: 'sys1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'system',
          subtype: 'agent_bootstrap',
          systemPayload: {
            kind: 'fork',
            history: [{ role: 'user', parts: [{ text: 'bootstrap env' }] }],
          },
        }),
        JSON.stringify({
          uuid: 'u1',
          parentUuid: 'sys1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.100Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Fork task' }] },
        }),
        JSON.stringify({
          uuid: 'sys2',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.200Z',
          type: 'system',
          subtype: 'agent_launch_prompt',
          systemPayload: {
            displayText: buildChildMessage('Fork task'),
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Fork task pending capability rebind',
      subagentType: FORK_SUBAGENT_TYPE,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Fork task',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    return { metaPath, outputFile };
  }

  it('keeps fork tasks paused when every advertised parent tool is excluded from subagents', async () => {
    const sessionId = 'session-fork-cap-excluded';
    const agentId = 'agent-fork-cap-excluded';
    seedResumableForkTask(sessionId, agentId);

    const createSpy = vi.spyOn(AgentHeadless, 'create');
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
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(
      'current parent system prompt or tool surface is unavailable',
    );
    expect(registry.get(agentId)?.error).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('keeps fork tasks paused when no advertised parent tool is still registered', async () => {
    const sessionId = 'session-fork-cap-unregistered';
    const agentId = 'agent-fork-cap-unregistered';
    seedResumableForkTask(sessionId, agentId);

    const createSpy = vi.spyOn(AgentHeadless, 'create');
    const { service } = createService({
      currentForkRuntime: {
        systemInstruction: 'current parent system instruction',
        advertisedTools: [{ name: 'mcp__removed__search' }],
        // The advertised tool is no longer in the live registry, so the
        // registry filter yields no resolvable tool and the fork stays paused.
        registeredTools: [],
      },
    });
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(
      'current parent system prompt or tool surface is unavailable',
    );
    expect(registry.get(agentId)?.error).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('injects live MCP, skill, and deferred-tool reminders into the resumed fork prompt', async () => {
    const sessionId = 'session-fork-cap-reminders';
    const agentId = 'agent-fork-cap-reminders';
    seedResumableForkTask(sessionId, agentId);

    const execute = vi.fn(async (_context: unknown) => undefined);
    const subagent = {
      execute,
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
    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockResolvedValue(subagent as unknown as AgentHeadless);

    const { service } = createService({
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
      // manager has no connected clients. Capability reminders must still
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

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const contextArg = execute.mock.calls[0]?.[0] as
      | { get(key: string): unknown }
      | undefined;
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
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Interrupted by shutdown',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });

    registry.register({
      agentId,
      description: 'Interrupted by shutdown',
      subagentType: 'researcher',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Interrupted by shutdown',
      metaPath,
      outputFile: getAgentJsonlPath(tempDir, sessionId, agentId),
      isBackgrounded: true,
    });

    registry.abortAll();

    expect(readMetaStatus(metaPath)).toBe('running');
  });

  it('keeps resumed tasks resumable after a generic shutdown abort', async () => {
    const sessionId = 'session-resume-shutdown';
    const agentId = 'agent-resume-shutdown';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume then shutdown',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume then shutdown' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume then shutdown',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume then shutdown',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    let releaseExecute: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseExecute = resolve;
        }),
    );
    const subagent = {
      execute,
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.CANCELLED,
      getFinalText: () => '',
    };

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();
    registry.abortAll();
    releaseExecute?.();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('cancelled');
    });
    expect(readMetaStatus(metaPath)).toBe('running');
  });

  it('keeps explicit cancellation persisted after a resumed task stops', async () => {
    const sessionId = 'session-resume-cancelled';
    const agentId = 'agent-resume-cancelled';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Resume then cancel',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Resume then cancel' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Resume then cancel',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Resume then cancel',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    let releaseExecute: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseExecute = resolve;
        }),
    );
    const subagent = {
      execute,
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.CANCELLED,
      getFinalText: () => '',
    };

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');
    expect(resumed).toBeDefined();
    registry.cancel(agentId);
    releaseExecute?.();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('cancelled');
    });
    expect(readMetaStatus(metaPath)).toBe('cancelled');
  });

  it('drops usage-only assistant records while preserving tool history and pending user text', async () => {
    const sessionId = 'session-pending-user';
    const agentId = 'agent-pending-user';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Pending user tail',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'running',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      [
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'original task' }] },
        }),
        JSON.stringify({
          uuid: 'usage-only',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.100Z',
          type: 'assistant',
          message: { role: 'model', parts: [] },
          usageMetadata: { totalTokenCount: 42 },
        }),
        JSON.stringify({
          uuid: 'call-1',
          parentUuid: 'usage-only',
          sessionId,
          timestamp: '2026-04-20T00:00:00.200Z',
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'read-1',
                  name: 'read_file',
                  args: { file_path: '/tmp/input.txt' },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          uuid: 'result-1',
          parentUuid: 'call-1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.300Z',
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'read-1',
                  name: 'read_file',
                  response: { output: 'contents' },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          uuid: 'a1',
          parentUuid: 'result-1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.400Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'working' }] },
        }),
        JSON.stringify({
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.500Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'and another thing' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Pending user tail',
      subagentType: 'researcher',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'original task',
      outputFile,
      metaPath,
      isBackgrounded: true,
    });

    const execute = vi.fn(
      async (context: { get: (key: string) => unknown }) => {
        const override = context.get('initial_messages_override') as
          | Array<{ parts?: Array<{ text?: string }> }>
          | undefined;
        expect(override).toBeUndefined();
        expect(context.get('task_prompt')).toBe('continue work');
      },
    );
    const subagent = {
      execute,
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

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    await service.resumeBackgroundAgent(agentId, 'continue work');

    expect(subagentManager.createAgentHeadless).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        promptConfigOverrides: {
          initialMessages: [
            { role: 'user', parts: [{ text: 'original task' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'read-1',
                    name: 'read_file',
                    args: { file_path: '/tmp/input.txt' },
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'read-1',
                    name: 'read_file',
                    response: { output: 'contents' },
                  },
                },
              ],
            },
            { role: 'model', parts: [{ text: 'working' }] },
            { role: 'user', parts: [{ text: 'and another thing' }] },
          ],
        },
      }),
    );
  });

  it('reconstructs a completed agent once, then reuses and disposes its resident runtime', async () => {
    const sessionId = 'session-revive';
    const agentId = 'agent-revive';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);
    const sessionDir = path.dirname(metaPath);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Finished research',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
      resumeCount: 0,
    });
    fs.writeFileSync(
      outputFile,
      [
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Finished research' }] },
        }),
        JSON.stringify({
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:01.000Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'All done' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const oldSessionMtime = new Date('2026-04-20T00:00:00.000Z');
    fs.utimesSync(sessionDir, oldSessionMtime, oldSessionMtime);

    // Real terminal lifecycle: run, then complete (sets notified=true).
    registry.register({
      agentId,
      description: 'Finished research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Finished research',
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'All done');

    const execute = vi.fn(
      async (_context: { get: (key: string) => unknown }) => undefined,
    );
    const subagent = {
      execute,
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'iterated',
    };

    const dispose = vi.fn().mockResolvedValue(undefined);
    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose,
    });

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
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.resumeCount).toBe(1);
    expect(fs.statSync(sessionDir).mtime.getTime()).toBeGreaterThan(
      oldSessionMtime.getTime(),
    );

    expect(registry.continueResidentAgent(agentId, 'tighten the summary')).toBe(
      true,
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
    expect(registry.continueResidentAgent(agentId, 'again')).toBe(false);
  });

  // The resume attach recomputes the transcript path instead of reusing the
  // registered outputFile; the recomputed path must follow
  // meta.parentSessionId, not the current session (the divergence a CLI
  // restart produces, reachable via send-message revive). The registered
  // outputFile is a decoy the attach must NOT write to — seeded with the
  // same chain, so a regression back to attaching the registered
  // outputFile would land the resumed record in the decoy and fail here.
  it('appends resumed records to the launch-session transcript when the current session differs', async () => {
    const launchSessionId = 'session-launch'; // config.getSessionId() is 'session-1'
    const agentId = 'agent-cross-session';
    const metaPath = getAgentMetaPath(tempDir, launchSessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, launchSessionId, agentId);
    // Diverges from the recomputed path the way a future registration path
    // could when it builds outputFile under a session dir other than
    // meta.parentSessionId.
    const decoyOutputFile = getAgentJsonlPath(
      tempDir,
      'session-registry-decoy',
      agentId,
    );

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Cross-session resume',
      parentSessionId: launchSessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    const seedRecords =
      [
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId: launchSessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'original task' }] },
        }),
        JSON.stringify({
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: launchSessionId,
          timestamp: '2026-04-20T00:00:01.000Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'partial answer' }] },
        }),
      ].join('\n') + '\n';
    fs.writeFileSync(outputFile, seedRecords, 'utf8');
    // The revive gate and the recovery read the registered outputFile, so
    // the decoy carries the same seed chain.
    fs.mkdirSync(path.dirname(decoyOutputFile), { recursive: true });
    fs.writeFileSync(decoyOutputFile, seedRecords, 'utf8');

    registry.register({
      agentId,
      description: 'Cross-session resume',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'original task',
      outputFile: decoyOutputFile,
      metaPath,
    });
    registry.complete(agentId, 'partial answer');

    const subagent = {
      execute: vi.fn().mockResolvedValue(undefined),
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'continued',
    };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose,
    });

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'keep going'),
    ).resolves.toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });

    // Resumed records land in the LAUNCH session's transcript, chained onto
    // its last stable record — the current session's dir stays untouched and
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
      message: { role: 'user', parts: [{ text: 'keep going' }] },
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
    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Isolated result',
      parentSessionId: 'session-isolated-revive',
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      isolation: 'worktree',
      subagentName: 'researcher',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'isolated-result',
        parentUuid: null,
        sessionId: 'session-isolated-revive',
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Isolated result' }] },
      }) + '\n',
      'utf8',
    );
    registry.register({
      agentId,
      description: 'Isolated result',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'done');

    const subagent = {
      execute: vi.fn().mockResolvedValue(undefined),
      executeExternalInputs: vi.fn().mockResolvedValue(undefined),
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        outputTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'continued from transcript',
    };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose,
    });

    await expect(
      service.reviveCompletedBackgroundAgent(agentId, 'continue'),
    ).resolves.toBeDefined();
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });

    expect(subagentManager.createAgentHeadless).toHaveBeenCalledOnce();
    expect(registry.continueResidentAgent(agentId, 'again')).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not revive non-completed or transcript-less entries', async () => {
    const { service, subagentManager } = createService();

    // Still running → not revivable.
    registry.register({
      agentId: 'still-running',
      description: 'r',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/x.jsonl',
      metaPath: '/tmp/x.meta.json',
    });
    await expect(
      service.reviveCompletedBackgroundAgent('still-running', 'go'),
    ).resolves.toBeUndefined();

    // Completed but no metaPath → not revivable.
    registry.register({
      agentId: 'completed-bare',
      description: 'c',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/y.jsonl',
    });
    registry.complete('completed-bare', 'done');
    await expect(
      service.reviveCompletedBackgroundAgent('completed-bare', 'go'),
    ).resolves.toBeUndefined();

    // Failed (terminal but not completed) → not revivable.
    registry.register({
      agentId: 'failed-agent',
      description: 'f',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/z.jsonl',
      metaPath: '/tmp/z.meta.json',
    });
    registry.fail('failed-agent', 'exploded');
    await expect(
      service.reviveCompletedBackgroundAgent('failed-agent', 'go'),
    ).resolves.toBeUndefined();

    // Unknown id → not revivable.
    await expect(
      service.reviveCompletedBackgroundAgent('nope', 'go'),
    ).resolves.toBeUndefined();

    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('does not mutate a completed entry when revive preflight fails', async () => {
    const { service, subagentManager } = createService();
    const missingMetaAgentId = 'completed-missing-meta';
    const missingOutputAgentId = 'completed-missing-output';
    const corruptOutputAgentId = 'completed-corrupt-output';

    registry.register({
      agentId: missingMetaAgentId,
      description: 'missing meta',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: path.join(tempDir, 'missing-meta.jsonl'),
      metaPath: path.join(tempDir, 'missing-meta.meta.json'),
    });
    registry.complete(missingMetaAgentId, 'done');

    const validMetaPath = path.join(tempDir, 'missing-output.meta.json');
    writeAgentMeta(validMetaPath, {
      agentId: missingOutputAgentId,
      agentType: 'researcher',
      description: 'missing output',
      parentSessionId: 'session-missing-output',
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    registry.register({
      agentId: missingOutputAgentId,
      description: 'missing output',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: path.join(tempDir, 'missing-output.jsonl'),
      metaPath: validMetaPath,
    });
    registry.complete(missingOutputAgentId, 'done');

    const corruptMetaPath = path.join(tempDir, 'corrupt-output.meta.json');
    const corruptOutputPath = path.join(tempDir, 'corrupt-output.jsonl');
    writeAgentMeta(corruptMetaPath, {
      agentId: corruptOutputAgentId,
      agentType: 'researcher',
      description: 'corrupt output',
      parentSessionId: 'session-corrupt-output',
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(corruptOutputPath, 'not-json\n', 'utf8');
    registry.register({
      agentId: corruptOutputAgentId,
      description: 'corrupt output',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: corruptOutputPath,
      metaPath: corruptMetaPath,
    });
    registry.complete(corruptOutputAgentId, 'done');

    await expect(
      service.reviveCompletedBackgroundAgent(missingMetaAgentId, 'go'),
    ).resolves.toBeUndefined();
    await expect(
      service.reviveCompletedBackgroundAgent(missingOutputAgentId, 'go'),
    ).resolves.toBeUndefined();
    await expect(
      service.reviveCompletedBackgroundAgent(corruptOutputAgentId, 'go'),
    ).resolves.toBeUndefined();

    expect(registry.get(missingMetaAgentId)?.status).toBe('completed');
    expect(registry.get(missingMetaAgentId)?.result).toBe('done');
    expect(registry.get(missingOutputAgentId)?.status).toBe('completed');
    expect(registry.get(missingOutputAgentId)?.result).toBe('done');
    expect(registry.get(corruptOutputAgentId)?.status).toBe('completed');
    expect(registry.get(corruptOutputAgentId)?.result).toBe('done');
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('restores the completed entry when revive setup fails after the state flip', async () => {
    const sessionId = 'session-revive-setup-fails';
    const agentId = 'agent-revive-setup-fails';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Finished research',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Finished research' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Finished research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'All done');
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
    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockRejectedValue(
      new Error('setup failed'),
    );

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
  });

  it('emits one start event and one terminal notification when a completed agent is revived', async () => {
    const sessionId = 'session-revive-notify';
    const agentId = 'agent-revive-notify';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Finished research',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Finished research' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Finished research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'All done');
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
      getFinalText: () => 'iterated',
    };
    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    await service.reviveCompletedBackgroundAgent(agentId, 'keep going');

    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
    expect(notifications).toEqual(['completed']);
    expect(started).toEqual(['running']);
  });

  it('does not revive when the background concurrency cap is full', async () => {
    registry = new BackgroundTaskRegistry({ maxConcurrentBackgroundAgents: 1 });
    const sessionId = 'session-revive-cap';
    const agentId = 'agent-revive-cap';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Finished research',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Finished research' }] },
      }) + '\n',
      'utf8',
    );

    // Complete the target first (so it doesn't count toward the running cap),
    // then fill the single slot with a live agent.
    registry.register({
      agentId,
      description: 'Finished research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'All done');
    registry.register({
      agentId: 'blocker',
      description: 'blocker',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
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
    const sessionId = 'session-revive-rollback-state';
    const agentId = 'agent-revive-rollback-state';
    const metaPath = getAgentMetaPath(tempDir, sessionId, agentId);
    const outputFile = getAgentJsonlPath(tempDir, sessionId, agentId);

    writeAgentMeta(metaPath, {
      agentId,
      agentType: 'researcher',
      description: 'Finished research',
      parentSessionId: sessionId,
      parentAgentId: null,
      createdAt: '2026-04-20T00:00:00.000Z',
      status: 'completed',
      subagentName: 'researcher',
      resolvedApprovalMode: 'default',
    });
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-20T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Finished research' }] },
      }) + '\n',
      'utf8',
    );

    registry.register({
      agentId,
      description: 'Finished research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile,
      metaPath,
    });
    registry.complete(agentId, 'All done');
    // Populate the pre-revive UI state that must survive a failed revive.
    const activities = [
      { name: 'Read', description: 'read src/index.ts', at: 1 },
      { name: 'Bash', description: 'npm test', at: 2 },
    ];
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
      const lastUpdatedAt = `2026-04-20T00:00:${String(i).padStart(2, '0')}.000Z`;
      writeAgentMeta(getAgentMetaPath(tempDir, sessionId, agentId), {
        agentId,
        agentType: 'researcher',
        description: agentId,
        parentSessionId: sessionId,
        parentAgentId: null,
        createdAt: '2026-04-20T00:00:00.000Z',
        status: 'completed',
        isBackgrounded: true,
        lastUpdatedAt,
        subagentName: 'researcher',
      });
      fs.writeFileSync(
        getAgentJsonlPath(tempDir, sessionId, agentId),
        JSON.stringify({
          uuid: `u-${agentId}`,
          parentUuid: null,
          sessionId,
          timestamp: '2026-04-20T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: agentId }] },
        }) + '\n',
        'utf8',
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
