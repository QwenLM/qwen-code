import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent, Message } from '@craft-agent/core/types';
import { QwenAgent } from '../qwen-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

type QwenHistoryInternals = {
  mergeSlashCommandInvocationMessages: (sessionId: string, messages: Message[], cwd: string) => Message[];
  buildHistoryMessages: (sessionId: string, updates: Record<string, unknown>[], cwd: string) => Message[];
  persistQwenTranscriptTextElements: (
    sessionId: string,
    cwd: string,
    sourceElements?: NonNullable<Message['textElements']>,
  ) => void;
  applyQwenTranscriptTextElements: (messages: Message[], sessionId: string, cwd: string) => Message[];
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

type QwenAvailableCommandsInternals = {
  qwenSessionId: string | null;
  _isProcessing: boolean;
  currentTurnId?: string;
  createAcpClient: () => {
    extMethod?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  suppressedSessionUpdates: Set<string>;
  eventQueue: {
    hasPending: boolean;
    drain: () => AsyncGenerator<AgentEvent>;
  };
  ensureProcess: () => Promise<void>;
  callAcp: <T>(
    method: string,
    execute: (connection: {
      loadSession?: (params: unknown) => Promise<unknown>;
      newSession?: (params: unknown) => Promise<unknown>;
    }) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  handleSessionUpdate: (params: unknown) => void;
  flushPendingAvailableCommandsUpdate: (sessionId: string) => void;
};

const originalRuntimeDir = process.env.QWEN_RUNTIME_DIR;

function createAgent(
  cwd: string,
  onSdkSessionIdUpdate?: BackendConfig['onSdkSessionIdUpdate'],
  onMidTurnMessagesDrained?: BackendConfig['onMidTurnMessagesDrained'],
): QwenAgent {
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
    onSdkSessionIdUpdate,
    onMidTurnMessagesDrained,
  } as BackendConfig);
}

function writeQwenTranscript(runtimeRoot: string, cwd: string, sessionId: string, records: unknown[]): void {
  const projectId = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptDir = join(runtimeRoot, 'projects', projectId, 'chats');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${sessionId}.jsonl`),
    records.map(record => JSON.stringify(record)).join('\n') + '\n',
  );
}

function readQwenTranscript(runtimeRoot: string, cwd: string, sessionId: string): Record<string, unknown>[] {
  const projectId = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptPath = join(runtimeRoot, 'projects', projectId, 'chats', `${sessionId}.jsonl`);
  return readFileSync(transcriptPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

async function readNextQueuedEvent(agent: QwenAgent): Promise<AgentEvent | undefined> {
  const queue = (agent as unknown as QwenAvailableCommandsInternals).eventQueue;
  const iterator = queue.drain();
  const next = await iterator.next();
  await iterator.return?.(undefined);
  return next.value;
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

  it('drains queued mid-turn messages through the ACP client extension', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const onMidTurnMessagesDrained = mock(() => {});
    const agent = createAgent(cwd, undefined, onMidTurnMessagesDrained);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'sdk-session-qwen';
    internals._isProcessing = true;

    expect(agent.enqueueMidTurnMessage('please also inspect tests')).toBe(true);

    const client = internals.createAcpClient();
    await expect(
      client.extMethod?.('craft/drainMidTurnQueue', {
        sessionId: 'other-session',
      }),
    ).resolves.toEqual({ messages: [] });
    await expect(
      client.extMethod?.('craft/drainMidTurnQueue', {
        sessionId: 'session-qwen',
      }),
    ).resolves.toEqual({
      messages: ['please also inspect tests'],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenCalledWith([
      'please also inspect tests',
    ]);

    expect(agent.enqueueMidTurnMessage('and summarize findings')).toBe(true);
    await expect(
      client.extMethod?.('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({
      messages: ['and summarize findings'],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenLastCalledWith([
      'and summarize findings',
    ]);
    await expect(
      client.extMethod?.('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({ messages: [] });

    agent.destroy();
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
    expect(messages[0]?.textElements).toBeUndefined();
  });

  it('does not derive text elements from Qwen user history without metadata', () => {
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

    expect(messages[0]?.textElements).toBeUndefined();
  });

  it('marks replayed pre-tool assistant text as commentary, not thought', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const messages = (agent as unknown as QwenHistoryInternals).buildHistoryMessages(
      'session-with-commentary',
      [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I will inspect the available commands.' },
          _meta: { timestamp: 1_000 },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-list',
          kind: 'list',
          title: 'List',
          rawInput: { path: 'packages/cli/src/ui/commands' },
          _meta: { timestamp: 1_001, toolName: 'List' },
        },
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Private reasoning stays internal.' },
          _meta: { timestamp: 1_002 },
        },
      ],
      cwd,
    );
    agent.destroy();

    expect(messages.map(message => [
      message.role,
      message.content,
      message.isIntermediate ?? false,
      message.intermediateKind ?? '',
    ])).toEqual([
      ['assistant', 'I will inspect the available commands.', true, 'commentary'],
      ['tool', 'Running List...', false, ''],
      ['assistant', 'Private reasoning stays internal.', true, 'thought'],
    ]);
  });

  it('writes slash command text elements into the Qwen transcript user record', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'session-with-slash-metadata';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [{
      uuid: 'u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-04-30T08:02:52.927Z',
      type: 'user',
      cwd,
      version: 'test',
      message: { role: 'user', parts: [{ text: '/qc-helper hello' }] },
    }]);

    const agent = createAgent(cwd);
    (agent as unknown as QwenHistoryInternals).persistQwenTranscriptTextElements(
      sessionId,
      cwd,
      [{
        type: 'slash_command',
        byte_range: { start: 0, end: 10 },
        placeholder: '/qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      }],
    );

    const records = readQwenTranscript(runtimeRoot, cwd, sessionId);
    agent.destroy();

    expect(records[0]?.textElements).toEqual([{
      type: 'slash_command',
      byte_range: { start: 0, end: 10 },
      placeholder: '/qc-helper',
      label: 'qc-helper',
      target: 'qc-helper',
    }]);
  });

  it('writes skill text elements into the Qwen transcript user record', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'session-with-skill-metadata';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [{
      uuid: 'u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-04-30T08:02:52.927Z',
      type: 'user',
      cwd,
      version: 'test',
      message: { role: 'user', parts: [{ text: '@qc-helper' }] },
    }]);

    const agent = createAgent(cwd);
    (agent as unknown as QwenHistoryInternals).persistQwenTranscriptTextElements(
      sessionId,
      cwd,
      [{
        type: 'skill',
        byte_range: { start: 0, end: 17 },
        placeholder: '[skill:qc-helper]',
        label: 'qc-helper',
        target: 'qc-helper',
      }],
    );

    const records = readQwenTranscript(runtimeRoot, cwd, sessionId);
    agent.destroy();

    expect(records[0]?.textElements).toEqual([{
      type: 'skill',
      byte_range: { start: 0, end: 10 },
      placeholder: '@qc-helper',
      label: 'qc-helper',
      target: 'qc-helper',
    }]);
  });

  it('loads text elements back from the Qwen transcript', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'session-with-persisted-text-elements';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [{
      uuid: 'u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-04-30T08:02:52.927Z',
      type: 'user',
      cwd,
      version: 'test',
      message: { role: 'user', parts: [{ text: '@qc-helper' }] },
      textElements: [{
        type: 'skill',
        byte_range: { start: 0, end: 10 },
        placeholder: '@qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      }],
    }]);

    const agent = createAgent(cwd);
    const messages = (agent as unknown as QwenHistoryInternals).applyQwenTranscriptTextElements(
      [{
        id: 'message-1',
        role: 'user',
        content: '@qc-helper',
        timestamp: Date.parse('2026-04-30T08:02:52.927Z'),
      }],
      sessionId,
      cwd,
    );
    agent.destroy();

    expect(messages[0]?.textElements).toEqual([{
      type: 'skill',
      byte_range: { start: 0, end: 10 },
      placeholder: '@qc-helper',
      label: 'qc-helper',
      target: 'qc-helper',
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

  it('buffers ACP available command updates until the Qwen session id is recorded', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals._isProcessing = true;

    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review code' },
          { name: 'git:commit', description: 'Commit changes' },
        ],
        _meta: { availableSkills: ['commit'] },
      },
    });

    expect(internals.eventQueue.hasPending).toBe(false);

    internals.qwenSessionId = 'qwen-session';
    internals.flushPendingAvailableCommandsUpdate('qwen-session');

    const event = await readNextQueuedEvent(agent);
    agent.destroy();

    expect(event).toEqual({
      type: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review code' },
        { name: 'git:commit', description: 'Commit changes' },
      ],
      availableSkills: ['commit'],
    });
  });

  it('preserves ACP available command updates emitted during suppressed session load', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'qwen-session';
    internals._isProcessing = true;
    internals.suppressedSessionUpdates.add('qwen-session');

    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
      },
    });

    expect(internals.eventQueue.hasPending).toBe(false);

    internals.suppressedSessionUpdates.delete('qwen-session');
    internals.flushPendingAvailableCommandsUpdate('qwen-session');

    const event = await readNextQueuedEvent(agent);
    agent.destroy();

    expect(event).toEqual({
      type: 'available_commands_update',
      availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
      availableSkills: undefined,
    });
  });

  it('streams ACP thought chunks as intermediate assistant text before the final answer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'qwen-session';
    internals._isProcessing = true;
    internals.currentTurnId = 'qwen-turn-test';

    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'I should inspect the project.' },
      },
    });
    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Here is the answer.' },
      },
    });

    const first = await readNextQueuedEvent(agent);
    const second = await readNextQueuedEvent(agent);
    const third = await readNextQueuedEvent(agent);
    agent.destroy();

    expect(first).toEqual({
      type: 'text_delta',
      text: 'I should inspect the project.',
      turnId: 'qwen-turn-test',
    });
    expect(second).toEqual({
      type: 'text_complete',
      text: 'I should inspect the project.',
      isIntermediate: true,
      intermediateKind: 'thought',
      turnId: 'qwen-turn-test',
    });
    expect(third).toEqual({
      type: 'text_delta',
      text: 'Here is the answer.',
      turnId: 'qwen-turn-test',
    });
  });

  it('flushes ACP text before tool calls so desktop can render progress live', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'qwen-session';
    internals._isProcessing = true;
    internals.currentTurnId = 'qwen-turn-tool';

    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will read the file first.' },
      },
    });
    internals.handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-read-1',
        kind: 'read',
        title: 'Read',
        rawInput: { file_path: 'README.md' },
        _meta: { toolName: 'Read' },
      },
    });

    const first = await readNextQueuedEvent(agent);
    const second = await readNextQueuedEvent(agent);
    const third = await readNextQueuedEvent(agent);
    agent.destroy();

    expect(first).toEqual({
      type: 'text_delta',
      text: 'I will read the file first.',
      turnId: 'qwen-turn-tool',
    });
    expect(second).toEqual({
      type: 'text_complete',
      text: 'I will read the file first.',
      isIntermediate: true,
      intermediateKind: 'commentary',
      turnId: 'qwen-turn-tool',
    });
    expect(third).toMatchObject({
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'tool-read-1',
      turnId: 'qwen-turn-tool',
    });
  });

  it('refreshes available commands by reloading the existing ACP session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    const calledMethods: string[] = [];
    internals.qwenSessionId = 'qwen-session';
    internals.ensureProcess = async () => {};
    internals.callAcp = async (method, execute) => {
      calledMethods.push(method);
      if (method === 'session/load') {
        internals.handleSessionUpdate({
          sessionId: 'qwen-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
          },
        });
      }
      return execute({
        loadSession: async () => ({ models: {}, modes: {} }),
      });
    };

    const snapshot = await agent.refreshAvailableCommands();
    agent.destroy();

    expect(calledMethods).toEqual(['session/load']);
    expect(snapshot?.availableCommands).toEqual([
      { name: 'project:fix', description: 'Run project fix' },
    ]);
  });

  it('deduplicates concurrent ACP session setup during command refresh', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const capturedSessionIds: string[] = [];
    const agent = createAgent(cwd, sessionId => capturedSessionIds.push(sessionId));
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    let newSessionCalls = 0;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (method, execute) => {
      if (method === 'session/new') {
        newSessionCalls += 1;
        await Promise.resolve();
        internals.handleSessionUpdate({
          sessionId: 'qwen-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
          },
        });
        return execute({
          newSession: async () => ({ sessionId: 'qwen-session', models: {}, modes: {} }),
        });
      }
      throw new Error(`Unexpected ACP method ${method}`);
    };

    const [firstSnapshot, secondSnapshot] = await Promise.all([
      agent.refreshAvailableCommands(),
      agent.refreshAvailableCommands(),
    ]);
    agent.destroy();

    expect(newSessionCalls).toBe(1);
    expect(capturedSessionIds).toEqual(['qwen-session']);
    expect(firstSnapshot?.availableCommands).toEqual([
      { name: 'project:fix', description: 'Run project fix' },
    ]);
    expect(secondSnapshot?.availableCommands).toEqual([
      { name: 'project:fix', description: 'Run project fix' },
    ]);
  });

  it('returns available commands captured while loading Qwen history', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (_method, execute) => {
      internals.handleSessionUpdate({
        sessionId: 'qwen-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
          _meta: { availableSkills: ['commit'] },
        },
      });
      internals.handleSessionUpdate({
        sessionId: 'qwen-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
          _meta: { timestamp: 1_000 },
        },
      });
      return execute({
        loadSession: async () => ({ models: {}, modes: {} }),
      });
    };

    const result = await agent.loadSessionMessages('qwen-session', { cwd });
    agent.destroy();

    expect(result.availableCommands).toEqual([
      { name: 'project:fix', description: 'Run project fix' },
    ]);
    expect(result.availableSkills).toEqual(['commit']);
    expect(result.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello'],
    ]);
  });
});
