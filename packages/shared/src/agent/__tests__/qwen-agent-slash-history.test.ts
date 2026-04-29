import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '@craft-agent/core/types';
import { QwenAgent } from '../qwen-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

type QwenHistoryInternals = {
  mergeSlashCommandInvocationMessages: (sessionId: string, messages: Message[], cwd: string) => Message[];
};

const originalRuntimeDir = process.env.QWEN_RUNTIME_DIR;

function createAgent(cwd: string): QwenAgent {
  return new QwenAgent({
    provider: 'qwen',
    workspace: {
      id: 'workspace-qwen',
      name: 'Qwen Workspace',
      slug: 'qwen-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'session-qwen',
      name: 'Qwen Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
  } as BackendConfig);
}

function writeQwenTranscript(runtimeRoot: string, cwd: string, sessionId: string, records: unknown[]): void {
  const projectId = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptDir = join(runtimeRoot, 'projects', projectId, 'chats');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${sessionId}.jsonl`),
    records.map(record => JSON.stringify(record)).join('\n') + '\n',
  );
}

describe('QwenAgent slash command history', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    if (originalRuntimeDir === undefined) {
      delete process.env.QWEN_RUNTIME_DIR;
    } else {
      process.env.QWEN_RUNTIME_DIR = originalRuntimeDir;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds slash command invocations when their result produced output', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'b1e2b1a0-8ea5-4af5-85ba-dff6232c9c02';
    const insightInvocation = '2026-03-25T07:36:47.100Z';
    const insightResult = '2026-03-25T07:36:53.143Z';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'model-invocation',
        sessionId,
        timestamp: '2026-03-25T07:36:39.000Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: { phase: 'invocation', rawCommand: '/model' },
      },
      {
        uuid: 'model-result',
        parentUuid: 'model-invocation',
        sessionId,
        timestamp: '2026-03-25T07:36:40.000Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: { phase: 'result', rawCommand: '/model', outputHistoryItems: [] },
      },
      {
        uuid: 'insight-invocation',
        sessionId,
        timestamp: insightInvocation,
        type: 'system',
        subtype: 'slash_command',
        systemPayload: { phase: 'invocation', rawCommand: '/insight' },
      },
      {
        uuid: 'insight-result',
        parentUuid: 'insight-invocation',
        sessionId,
        timestamp: insightResult,
        type: 'system',
        subtype: 'slash_command',
        systemPayload: {
          phase: 'result',
          rawCommand: '/insight',
          outputHistoryItems: [
            { type: 'info', text: 'This may take a couple minutes. Sit tight!' },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const acpMessages: Message[] = [{
      id: 'qwen-existing-1',
      role: 'assistant',
      content: 'This may take a couple minutes. Sit tight!',
      timestamp: Date.parse(insightResult),
    }];

    const messages = (agent as unknown as QwenHistoryInternals)
      .mergeSlashCommandInvocationMessages(sessionId, acpMessages, cwd);
    agent.destroy();

    expect(messages.map(message => [message.role, message.content, message.timestamp])).toEqual([
      ['user', '/insight', Date.parse(insightInvocation)],
      ['assistant', 'This may take a couple minutes. Sit tight!', Date.parse(insightResult)],
    ]);
  });
});
