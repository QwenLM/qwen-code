/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSubagentSessionDir,
  Storage,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import type { WorkspaceRuntime } from './workspace-registry.js';
import {
  createVirtualSubagentSessionId,
  parseVirtualSubagentSessionId,
  preferTerminalTaskStatus,
  VirtualSubagentSessions,
} from './virtual-subagent-sessions.js';

const tempDirs: string[] = [];

it.each(['running', 'paused'])(
  'keeps a terminal task status over non-terminal %s metrics',
  (metricsStatus) => {
    expect(preferTerminalTaskStatus(metricsStatus, 'completed')).toBe(
      'completed',
    );
  },
);

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function record(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  text: string,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 'parent-session',
    timestamp: new Date().toISOString(),
    type,
    cwd: '/workspace',
    version: 'test',
    message: {
      role: type === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    },
  };
}

function activeTarget(sessions: VirtualSubagentSessions): {
  refreshLive: () => Promise<void>;
  subscribers: number;
} {
  const targets = (
    sessions as unknown as {
      targets: Map<
        string,
        { refreshLive: () => Promise<void>; subscribers: number }
      >;
    }
  ).targets;
  const target = targets.values().next().value;
  if (!target) throw new Error('Expected an active virtual subagent target');
  return target;
}

describe('VirtualSubagentSessions', () => {
  it('rejects id parts that the parser cannot accept', () => {
    expect(() =>
      createVirtualSubagentSessionId('parent session', 'agent-1'),
    ).toThrow('valid id parts');
    expect(() =>
      createVirtualSubagentSessionId('parent-session', 'agent/1'),
    ).toThrow('valid id parts');
  });

  it('resolves, fully loads, and independently streams an agent transcript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n${JSON.stringify(
        {
          ...record('two', 'one', 'assistant', 'first'),
          timestamp: new Date(1_000).toISOString(),
          agentRunId: 'run-one',
          agentRound: 1,
        },
      )}\n`,
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-one',
        round: 1,
        text: 'completed round duplicate',
        thought: false,
        timestamp: 500,
      })}\n${JSON.stringify({
        v: 1,
        runId: 'run-one',
        round: 2,
        text: 'already streaming',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );

    const runtime = {
      workspaceId: 'workspace-1',
      workspaceCwd: '/workspace',
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-call-1',
              label: 'agent: research',
              description: 'research',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              stats: {
                totalTokens: 321,
                toolUses: 2,
                durationMs: 4_500,
              },
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-1',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-1',
    );

    expect(resolved?.title).toBe('agent: research');
    expect(resolved).toMatchObject({
      taskId: 'general-purpose-call-1',
      status: 'running',
      durationMs: 4_500,
      totalTokens: 321,
    });
    expect(parseVirtualSubagentSessionId(resolved!.sessionId)).toEqual({
      parentSessionId: 'parent-session',
      agentId: 'general-purpose-call-1',
    });

    const loaded = await sessions.load(runtime, resolved!.sessionId, 'detail');
    expect(loaded).toMatchObject({
      sessionId: resolved!.sessionId,
      attached: true,
      clientId: 'detail',
      historyHasMore: false,
    });
    expect(loaded?.compactedReplay.length).toBeGreaterThan(0);
    expect(JSON.stringify(loaded?.compactedReplay)).toContain(
      'already streaming',
    );
    expect(JSON.stringify(loaded?.compactedReplay)).not.toContain(
      'completed round duplicate',
    );

    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded?.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');
    await fs.rm(`${outputFile}.stream`);
    await activeTarget(sessions).refreshLive();
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-two',
        round: 1,
        text: `resumed round live ${'x'.repeat(512)}`,
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const streamed = await iterator.next();
    const reloaded = await sessions.load(runtime, resolved!.sessionId);
    await fs.writeFile(
      outputFile,
      `${JSON.stringify({
        ...record('replacement', null, 'assistant', 'replacement canonical'),
        timestamp: new Date(100).toISOString(),
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const replaced = await iterator.next();
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        text: 'stream after rewind',
        thought: false,
        timestamp: 200,
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const afterRewind = await iterator.next();
    abort.abort();
    await iterator.return?.();
    expect(streamed?.value).toMatchObject({ type: 'session_update' });
    expect(JSON.stringify(reloaded?.compactedReplay)).toContain(
      'resumed round live',
    );
    expect(JSON.stringify(replaced?.value)).toContain('replacement canonical');
    expect(JSON.stringify(afterRewind.value)).toContain('stream after rewind');
  });

  it('releases the subscriber count when the initial refresh fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'not-a-file');
    await fs.mkdir(outputFile);
    const runtime = {
      workspaceId: 'workspace-refresh-error',
      workspaceCwd: '/workspace',
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-error',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-error',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const sessionId = createVirtualSubagentSessionId(
      'parent-session',
      'agent-error',
    );
    const stream = await sessions.subscribe(runtime, sessionId, {
      signal: new AbortController().signal,
    });

    await expect(stream![Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(activeTarget(sessions).subscribers).toBe(0);
  });

  it('isolates cached targets by workspace runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const makeRuntime = async (workspaceId: string, text: string) => {
      const outputFile = path.join(dir, `${workspaceId}.jsonl`);
      await fs.writeFile(
        outputFile,
        `${JSON.stringify(record('one', null, 'user', text))}\n`,
      );
      await fs.writeFile(
        `${outputFile}.stream`,
        `${JSON.stringify({
          v: 1,
          round: 1,
          text: `${text} stale stream`,
          thought: false,
          timestamp: Date.now(),
        })}\n`,
      );
      return {
        workspaceId,
        workspaceCwd: `/workspace/${workspaceId}`,
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: {
          getSessionTasksStatus: async () => ({
            v: 1 as const,
            sessionId: 'parent-session',
            now: Date.now(),
            tasks: [
              {
                kind: 'agent' as const,
                id: 'agent-1',
                label: 'agent',
                description: 'agent',
                status: 'completed' as const,
                startTime: Date.now(),
                runtimeMs: 1,
                outputFile,
                isBackgrounded: false,
                toolUseId: 'call-1',
              },
            ],
          }),
        },
      } as unknown as WorkspaceRuntime;
    };
    const firstRuntime = await makeRuntime('workspace-1', 'first workspace');
    const secondRuntime = await makeRuntime('workspace-2', 'second workspace');
    const sessionId = 'subagent.cGFyZW50LXNlc3Npb24.YWdlbnQtMQ';
    const sessions = new VirtualSubagentSessions();

    const first = await sessions.load(firstRuntime, sessionId);
    const second = await sessions.load(secondRuntime, sessionId);

    expect(first?.workspaceCwd).toBe('/workspace/workspace-1');
    expect(second?.workspaceCwd).toBe('/workspace/workspace-2');
    expect(JSON.stringify(second?.compactedReplay)).toContain(
      'second workspace',
    );
    expect(JSON.stringify(second?.compactedReplay)).not.toContain(
      'first workspace',
    );
    expect(JSON.stringify(second?.compactedReplay)).not.toContain(
      'stale stream',
    );
  });

  it('keeps later canonical rounds when one streamed round is reconciled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n`,
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-batch',
        round: 1,
        text: 'streamed first round',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const runtime = {
      workspaceId: 'workspace-batch',
      workspaceCwd: '/workspace',
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-batch',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-batch',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-batch',
    );
    const loaded = await sessions.load(runtime, resolved!.sessionId);
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');

    await fs.appendFile(
      outputFile,
      `${JSON.stringify({
        ...record('two', 'one', 'assistant', 'streamed first round'),
        agentRunId: 'run-batch',
        agentRound: 1,
      })}\n${JSON.stringify({
        ...record('three', 'two', 'assistant', 'canonical second round'),
        agentRunId: 'run-batch',
        agentRound: 2,
      })}\n`,
    );

    const update = await iterator.next();
    abort.abort();
    await iterator.return?.();
    expect(JSON.stringify(update.value)).toContain('canonical second round');
  });

  it('does not replay a second load snapshot again on subscribe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n`,
    );
    const runtime = {
      workspaceId: 'workspace-reload',
      workspaceCwd: '/workspace',
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-reload',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-reload',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-reload',
    );
    await sessions.load(runtime, resolved!.sessionId);
    await fs.appendFile(
      outputFile,
      `${JSON.stringify({
        ...record('two', 'one', 'assistant', 'between snapshots'),
        agentRunId: 'run-reload',
        agentRound: 1,
      })}\n`,
    );

    const loaded = await sessions.load(runtime, resolved!.sessionId);
    expect(JSON.stringify(loaded!.compactedReplay)).toContain(
      'between snapshots',
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-reload',
        round: 1,
        text: 'between snapshots',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    const replayed: unknown[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.value?.type === 'replay_complete') break;
      replayed.push(next.value);
    }
    abort.abort();
    await iterator.return?.();
    expect(JSON.stringify(replayed)).not.toContain('between snapshots');
  });

  it('keeps task status while supplementing terminal metrics', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-subagent-runtime-'),
    );
    tempDirs.push(runtimeDir);
    const workspaceCwd = path.join(runtimeDir, 'workspace');
    const projectDir = Storage.runWithRuntimeBaseDir(
      runtimeDir,
      workspaceCwd,
      () => new Storage(workspaceCwd).getProjectDir(),
    );
    const parentSessionId = 'running-parent';
    const toolCallId = 'call-running';
    const outputFile = path.join(runtimeDir, 'running-agent.jsonl');
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'chats', `${parentSessionId}.jsonl`),
      `${JSON.stringify({
        ...record('result', null, 'user', ''),
        sessionId: parentSessionId,
        type: 'tool_result',
        toolCallResult: {
          callId: toolCallId,
          status: 'success',
          resultDisplay: {
            type: 'task_execution',
            status: 'running',
            executionSummary: { totalTokens: 999 },
          },
        },
      })}\n`,
    );
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('child', null, 'user', 'task'))}\n`,
    );
    let taskStatus: 'running' | 'completed' = 'running';
    const runtime = {
      workspaceId: 'running-workspace',
      workspaceCwd,
      env: {
        mode: 'runtime-overlay',
        overlayKeys: ['QWEN_RUNTIME_DIR'],
        effectiveEnv: { QWEN_RUNTIME_DIR: runtimeDir },
      },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: parentSessionId,
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-running',
              label: 'running agent',
              description: 'running agent',
              status: taskStatus,
              startTime: Date.now(),
              runtimeMs: 1,
              stats: { totalTokens: 123, toolUses: 1, durationMs: 500 },
              outputFile,
              isBackgrounded: false,
              toolUseId: toolCallId,
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;

    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      parentSessionId,
      toolCallId,
    );

    expect(resolved).toMatchObject({
      status: 'running',
      durationMs: 500,
      totalTokens: 123,
    });
    const loaded = await sessions.load(runtime, resolved!.sessionId);
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');

    taskStatus = 'completed';
    await fs.appendFile(
      outputFile,
      `${JSON.stringify(
        record('final', 'child', 'assistant', 'final canonical output'),
      )}\n`,
    );
    expect(
      await sessions.resolve(runtime, parentSessionId, toolCallId),
    ).toMatchObject({ status: 'completed', totalTokens: 999 });
    await activeTarget(sessions).refreshLive();
    const finalUpdate = await iterator.next();
    expect(JSON.stringify(finalUpdate?.value)).toContain(
      'final canonical output',
    );

    await fs.appendFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        round: 1,
        text: 'must not be polled after completion',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const next = iterator.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    vi.useRealTimers();
    abort.abort();
    await next;
    await iterator.return?.();
  });

  it('keeps terminal legacy sidecar status over the background launch result', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-subagent-runtime-'),
    );
    tempDirs.push(runtimeDir);
    const workspaceCwd = path.join(runtimeDir, 'workspace');
    const projectDir = Storage.runWithRuntimeBaseDir(
      runtimeDir,
      workspaceCwd,
      () => new Storage(workspaceCwd).getProjectDir(),
    );
    const parentSessionId = 'legacy-parent';
    const toolCallId = 'call-old';
    const prompt = 'legacy launch prompt';
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'chats', `${parentSessionId}.jsonl`),
      `${JSON.stringify({
        ...record('root', null, 'assistant', ''),
        sessionId: parentSessionId,
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: toolCallId,
                name: 'agent',
                args: {
                  description: 'legacy task',
                  prompt,
                  subagent_type: 'general-purpose',
                },
              },
            },
          ],
        },
      })}\n${JSON.stringify({
        ...record('result', 'root', 'user', ''),
        sessionId: parentSessionId,
        type: 'tool_result',
        toolCallResult: {
          callId: toolCallId,
          status: 'success',
          resultDisplay: {
            type: 'task_execution',
            status: 'background',
            tokenCount: 123,
            executionSummary: {
              totalDurationMs: 88_610,
              totalTokens: 1_234,
              inputTokens: 1_000,
              outputTokens: 234,
              cachedTokens: 800,
            },
          },
        },
      })}\n`,
    );
    const sessionDir = getSubagentSessionDir(projectDir, parentSessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const outputFile = path.join(
      sessionDir,
      'agent-general-purpose-random.jsonl',
    );
    await fs.writeFile(
      outputFile,
      `${JSON.stringify({
        ...record('child', null, 'user', prompt),
        sessionId: parentSessionId,
      })}\n`,
    );
    await fs.writeFile(
      outputFile.replace(/\.jsonl$/, '.meta.json'),
      JSON.stringify({
        agentId: 'general-purpose-random',
        agentType: 'general-purpose',
        description: 'legacy task',
        parentSessionId,
        parentAgentId: null,
        createdAt: new Date().toISOString(),
        status: 'completed',
      }),
    );
    const runtime = {
      workspaceId: 'legacy-workspace',
      workspaceCwd,
      env: {
        mode: 'runtime-overlay',
        overlayKeys: ['QWEN_RUNTIME_DIR'],
        effectiveEnv: { QWEN_RUNTIME_DIR: runtimeDir },
      },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: parentSessionId,
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-random',
              label: 'legacy task',
              description: 'legacy task',
              status: 'completed' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: true,
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;

    const resolved = await new VirtualSubagentSessions().resolve(
      runtime,
      parentSessionId,
      toolCallId,
    );

    expect(parseVirtualSubagentSessionId(resolved!.sessionId)?.agentId).toBe(
      'general-purpose-random',
    );
    expect(resolved).toMatchObject({
      status: 'completed',
      durationMs: 88_610,
      totalTokens: 1_234,
      inputTokens: 1_000,
      outputTokens: 234,
      cachedTokens: 800,
    });
  });
});
