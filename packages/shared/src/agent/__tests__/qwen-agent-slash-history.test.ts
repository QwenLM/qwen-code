import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '@craft-agent/core/types';
import { QwenAgent } from '../qwen-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

type QwenHistoryInternals = {
  mergeSlashCommandInvocationMessages: (sessionId: string, messages: Message[], cwd: string) => Message[];
  buildHistoryMessages: (sessionId: string, updates: Record<string, unknown>[], cwd: string) => Message[];
};

type QwenPromptBlock = {
  type: string;
  text?: string;
  resource?: {
    uri?: string;
    mimeType?: string | null;
    text?: string;
  };
  _meta?: Record<string, unknown> | null;
};

type QwenPromptInternals = {
  buildPromptBlocks: (message: string) => QwenPromptBlock[];
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

  it('sends slash commands as raw ACP prompts', () => {
    const blocks = (QwenAgent.prototype as unknown as QwenPromptInternals)
      .buildPromptBlocks('  /context  ');

    expect(blocks).toEqual([{ type: 'text', text: '/context' }]);
  });

  it('does not prepend Craft context to Qwen prompts while disabled', () => {
    const blocks = (QwenAgent.prototype as unknown as QwenPromptInternals)
      .buildPromptBlocks('hello');

    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
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
    expect(messages[0]?.badges).toEqual([{
      type: 'command',
      label: 'insight',
      rawText: '/insight',
      start: 0,
      end: 8,
    }]);
  });

  it('derives file badges from Qwen user history without a Craft metadata sidecar', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const messages = (agent as unknown as QwenHistoryInternals).buildHistoryMessages(
      'session-with-files',
      [{
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'text',
          text: 'please inspect @packages/shared/src/agent/qwen-agent.ts:42',
        },
        _meta: { timestamp: 1234 },
      }],
      cwd,
    );
    agent.destroy();

    expect(messages[0]?.badges).toEqual([{
      type: 'file',
      label: 'qwen-agent.ts',
      rawText: '@packages/shared/src/agent/qwen-agent.ts:42',
      start: 15,
      end: 58,
      filePath: join(cwd, 'packages/shared/src/agent/qwen-agent.ts'),
    }]);
  });

  it('formats slash command JSON output as a markdown json block', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'a72a15d5-5096-4a15-b256-e7553763d94c';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'doctor-invocation',
        sessionId,
        timestamp: '2026-04-29T05:30:26.198Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: { phase: 'invocation', rawCommand: '/doctor' },
      },
      {
        uuid: 'doctor-result',
        parentUuid: 'doctor-invocation',
        sessionId,
        timestamp: '2026-04-29T05:30:26.335Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: {
          phase: 'result',
          rawCommand: '/doctor',
          outputHistoryItems: [
            {
              type: 'assistant',
              text: JSON.stringify({
                checks: [
                  {
                    category: 'System',
                    name: 'Node.js version',
                    status: 'pass',
                    message: 'v22.22.1',
                  },
                ],
                summary: { pass: 1, warn: 0, fail: 0 },
              }, null, 2),
            },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const messages = (agent as unknown as QwenHistoryInternals)
      .mergeSlashCommandInvocationMessages(sessionId, [], cwd);
    agent.destroy();

    expect(messages.map(message => [message.role, message.content])).toEqual([
      ['user', '/doctor'],
      [
        'assistant',
        [
          '```json',
          '{',
          '  "checks": [',
          '    {',
          '      "category": "System",',
          '      "name": "Node.js version",',
          '      "status": "pass",',
          '      "message": "v22.22.1"',
          '    }',
          '  ],',
          '  "summary": {',
          '    "pass": 1,',
          '    "warn": 0,',
          '    "fail": 0',
          '  }',
          '}',
          '```',
        ].join('\n'),
      ],
    ]);
  });

  it('restores structured doctor slash command output', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'a72a15d5-5096-4a15-b256-e7553763d94d';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'doctor-invocation',
        sessionId,
        timestamp: '2026-04-29T05:30:26.198Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: { phase: 'invocation', rawCommand: '/doctor' },
      },
      {
        uuid: 'doctor-result',
        parentUuid: 'doctor-invocation',
        sessionId,
        timestamp: '2026-04-29T05:30:26.335Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: {
          phase: 'result',
          rawCommand: '/doctor',
          outputHistoryItems: [
            {
              type: 'doctor',
              checks: [
                {
                  category: 'System',
                  name: 'Node.js version',
                  status: 'pass',
                  message: 'v24.11.1',
                },
              ],
              summary: { pass: 1, warn: 0, fail: 0 },
            },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const messages = (agent as unknown as QwenHistoryInternals)
      .mergeSlashCommandInvocationMessages(sessionId, [], cwd);
    agent.destroy();

    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toContain('```json\n{');
    expect(messages[1]?.content).toContain('"message": "v24.11.1"');
  });

  it('does not send Craft context while Qwen prompt context is disabled', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const blocks = (agent as unknown as QwenPromptInternals).buildPromptBlocks('Fix session names');
    agent.destroy();

    const textBlock = blocks.find(block => block.type === 'text');
    expect(textBlock?.text?.trim()).toBe('Fix session names');
    expect(textBlock?.text).not.toContain('<craft_agent_context>');

    const resourceBlock = blocks.find(block => block.type === 'resource');
    expect(resourceBlock).toBeUndefined();
  });
});
