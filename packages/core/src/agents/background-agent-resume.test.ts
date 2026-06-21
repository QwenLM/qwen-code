/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { BackgroundTaskRegistry } from './background-tasks.js';
import { BackgroundAgentResumeService } from './background-agent-resume.js';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  writeAgentMeta,
} from './agent-transcript.js';
import { AgentTerminateMode } from './runtime/agent-types.js';
import { AgentEventEmitter } from './runtime/agent-events.js';
import { AgentHeadless } from './runtime/agent-headless.js';
import {
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

  function createService(options: { stopHookBlockingCap?: number } = {}) {
    const subagentManager = {
      loadSubagent: vi.fn(async (name: string) =>
        name === 'researcher'
          ? {
              name: 'researcher',
              color: 'cyan',
            }
          : null,
      ),
      createAgentHeadless: vi.fn(),
    };
    const hookSystem = {
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
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
      stop: vi.fn().mockResolvedValue(undefined),
      warmAll: vi.fn().mockResolvedValue(undefined),
      getDeferredToolSummary: vi.fn().mockReturnValue([]),
      isDeferredToolRevealed: vi.fn().mockReturnValue(false),
      getMcpServerInstructions: vi.fn().mockReturnValue(new Map()),
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
      getProjectRoot: () => tempDir,
      getCliVersion: () => 'test-version',
      getGeminiClient: () => undefined,
      getSkillManager: () => undefined,
      getSkipStartupContext: () => true,
      getTranscriptPath: () => path.join(tempDir, 'session.jsonl'),
      getToolRegistry: () => stubToolRegistry,
      createToolRegistry: vi.fn().mockResolvedValue(stubToolRegistry),
    } as unknown as Config;

    return {
      service: new BackgroundAgentResumeService(config),
      subagentManager,
      hookSystem,
      monitorRegistry,
    };
  }

  it('loads only interrupted running background agents as paused entries', async () => {
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
      '',
      'utf8',
    );

    const { service, subagentManager } = createService();
    const recovered = await service.loadPausedBackgroundAgents(sessionId);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId: runningAgentId,
      status: 'paused',
      description: 'Investigate retry handling',
      subagentType: 'researcher',
      prompt: 'Investigate retry handling',
      metaPath: runningMetaPath,
      outputFile: getAgentJsonlPath(tempDir, sessionId, runningAgentId),
    });
    expect(registry.get(runningAgentId)?.status).toBe('paused');
    expect(registry.get(completedAgentId)).toBeUndefined();
    expect(subagentManager.loadSubagent).toHaveBeenCalledTimes(1);
    expect(subagentManager.loadSubagent).toHaveBeenCalledWith('researcher');
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

    const execute = vi.fn(
      async (_context: { get: (key: string) => unknown }) => undefined,
    );
    const setExternalMessageProvider = vi.fn();
    const subagent = {
      execute,
      setExternalMessageProvider,
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
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

    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
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
    await vi.waitFor(() => {
      expect(registry.get(agentId)?.status).toBe('completed');
    });
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
        maxSessionTurns: 7,
        maxToolCalls: 11,
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
    expect(overriddenConfig.getApprovalMode()).toBe('auto-edit');
    expect(overriddenConfig.getBareMode()).toBe(true);
    expect(overriddenConfig.getSandbox()).toEqual({
      command: 'docker',
      image: 'qwen-code-sandbox',
    });
    expect(overriddenConfig.getScreenReader()).toBe(true);
    expect(overriddenConfig.getModel()).toBe('agent-model');
    expect(overriddenConfig.getMaxSessionTurns()).toBe(7);
    expect(overriddenConfig.getMaxToolCalls()).toBe(11);
  }, 20000);

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
    const subagent = {
      execute,
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
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
    expect(provider?.()).toEqual(['second message']);
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
      getExecutionSummary: () => ({ totalTokens: 0, totalDurationMs: 0 }),
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
      getExecutionSummary: () => ({ totalTokens: 0, totalDurationMs: 0 }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'done',
    };
    const { service, subagentManager, monitorRegistry } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.resumeBackgroundAgent(agentId, 'continue'),
    ).resolves.toBeUndefined();

    expect(subagent.execute).not.toHaveBeenCalled();
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

  it('resumes fork agents from transcript bootstrap instead of current parent config', async () => {
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
            systemInstruction: {
              role: 'system',
              parts: [{ text: 'persisted system instruction' }],
            },
            tools: [{ name: 'Bash' }, { name: 'Read' }],
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

    const execute = vi.fn(async (_context: unknown) => undefined);
    const subagent = {
      execute,
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({
        totalTokens: 0,
        totalDurationMs: 0,
      }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'done',
    };

    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockResolvedValue(subagent as unknown as AgentHeadless);
    const { service, subagentManager } = createService();
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeDefined();
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const createArgs = createSpy.mock.calls[0];
    expect(createArgs).toBeDefined();
    expect(createArgs![2]).toMatchObject({
      renderedSystemPrompt: {
        role: 'system',
        parts: [{ text: 'persisted system instruction' }],
      },
      initialMessages: [
        { role: 'user', parts: [{ text: 'bootstrap env' }] },
        { role: 'model', parts: [{ text: 'bootstrap ack' }] },
        { role: 'user', parts: [{ text: buildChildMessage(launchPrompt) }] },
        { role: 'model', parts: [{ text: 'Working silently' }] },
      ],
    });
    expect(createArgs?.[5]).toEqual({
      tools: [{ name: 'Bash' }, { name: 'Read' }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const executeCall = execute.mock.calls[0];
    expect(executeCall).toBeDefined();
    const contextArg = executeCall?.[0] as
      | { get(key: string): unknown }
      | undefined;
    expect(contextArg).toBeDefined();
    if (!contextArg) {
      throw new Error('Expected resume execute context');
    }
    expect(contextArg.get('task_prompt')).toBe('continue');
    createSpy.mockRestore();
  });

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
    const { service } = createService();
    const resumed = await service.resumeBackgroundAgent(agentId, 'continue');

    expect(resumed).toBeUndefined();
    expect(registry.get(agentId)?.status).toBe('paused');
    expect(registry.get(agentId)?.resumeBlockedReason).toContain(
      'bootstrap transcript is missing',
    );
    expect(registry.get(agentId)?.error).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('keeps fork tasks paused when bootstrap capabilities are missing', async () => {
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
      'runtime constraints are missing',
    );
    expect(createSpy).not.toHaveBeenCalled();
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

  it('preserves pending trailing user text in history and sends continuation as the new turn', async () => {
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
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.100Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'working' }] },
        }),
        JSON.stringify({
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId,
          timestamp: '2026-04-20T00:00:00.200Z',
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
            { role: 'model', parts: [{ text: 'working' }] },
            { role: 'user', parts: [{ text: 'and another thing' }] },
          ],
        },
      }),
    );
  });

  it('revives a completed background agent from its transcript and bumps resumeCount', async () => {
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
      getExecutionSummary: () => ({ totalTokens: 0, totalDurationMs: 0 }),
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'iterated',
    };

    const { service, subagentManager } = createService();
    subagentManager.createAgentHeadless.mockResolvedValue({
      subagent,
      dispose: vi.fn().mockResolvedValue(undefined),
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

    await expect(
      service.reviveCompletedBackgroundAgent(missingMetaAgentId, 'go'),
    ).resolves.toBeUndefined();
    await expect(
      service.reviveCompletedBackgroundAgent(missingOutputAgentId, 'go'),
    ).resolves.toBeUndefined();

    expect(registry.get(missingMetaAgentId)?.status).toBe('completed');
    expect(registry.get(missingMetaAgentId)?.result).toBe('done');
    expect(registry.get(missingOutputAgentId)?.status).toBe('completed');
    expect(registry.get(missingOutputAgentId)?.result).toBe('done');
    expect(subagentManager.createAgentHeadless).not.toHaveBeenCalled();
  });

  it('emits exactly one new terminal notification when a completed agent is revived', async () => {
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

    const subagent = {
      execute: vi.fn(async () => undefined),
      setExternalMessageProvider: vi.fn(),
      getCore: () => ({ getEventEmitter: () => new AgentEventEmitter() }),
      getExecutionSummary: () => ({ totalTokens: 0, totalDurationMs: 0 }),
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
});

function readMetaStatus(metaPath: string): string | undefined {
  const raw = fs.readFileSync(metaPath, 'utf8');
  return JSON.parse(raw).status;
}
