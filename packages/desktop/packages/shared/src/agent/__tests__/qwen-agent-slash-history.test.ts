import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent, Message } from '@craft-agent/core/types';
import { QwenAgent } from '../qwen-agent.ts';
import type { FileAttachment } from '../../utils/files.ts';

type QwenAgentConfig = ConstructorParameters<typeof QwenAgent>[0];

type QwenHistoryInternals = {
  mergeSlashCommandInvocationMessages: (
    sessionId: string,
    messages: Message[],
    cwd: string,
  ) => Message[];
  buildHistoryMessages: (
    sessionId: string,
    updates: Array<Record<string, unknown>>,
    cwd: string,
  ) => Message[];
  persistQwenTranscriptTextElements: (
    sessionId: string,
    cwd: string,
    sourceElements?: NonNullable<Message['textElements']>,
  ) => void;
  applyQwenTranscriptTextElements: (
    messages: Message[],
    sessionId: string,
    cwd: string,
  ) => Message[];
};

type QwenPromptBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri?: string;
    mimeType?: string | null;
    text?: string;
  };
  _meta?: Record<string, unknown> | null;
};

type QwenPromptInternals = {
  buildPromptBlocks: (
    message: string,
    attachments?: FileAttachment[],
  ) => QwenPromptBlock[];
};

type QwenAvailableCommandsInternals = {
  acpLease?: {
    isActive: () => boolean;
    release: () => void;
  } | null;
  connection?: {
    signal: { aborted: boolean };
  } | null;
  qwenSessionId: string | null;
  _isProcessing: boolean;
  currentTurnId?: string;
  handleExtMethod: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  suppressedSessionUpdates: Set<string>;
  eventQueue: {
    hasPending: boolean;
    drain: () => AsyncGenerator<AgentEvent>;
  };
  ensureProcess: () => Promise<void>;
  startProcess: () => Promise<void>;
  callAcp: <T>(
    method: string,
    execute: (connection: {
      extMethod?: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      loadSession?: (params: unknown) => Promise<unknown>;
      newSession?: (params: unknown) => Promise<unknown>;
    }) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  handleSessionUpdate: (params: unknown) => void;
  flushPendingAvailableCommandsUpdate: (sessionId: string) => void;
};

type QwenSpawnInternals = {
  buildSpawnCommand: (
    qwenCliPath: string,
    nodePath: string,
  ) => { command: string; args: string[] };
};

const originalRuntimeDir = process.env.QWEN_RUNTIME_DIR;

function createAgent(
  cwd: string,
  onSdkSessionIdUpdate?: QwenAgentConfig['onSdkSessionIdUpdate'],
  onMidTurnMessagesDrained?: QwenAgentConfig['onMidTurnMessagesDrained'],
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
  } as QwenAgentConfig);
}

function writeQwenTranscript(
  runtimeRoot: string,
  cwd: string,
  sessionId: string,
  records: unknown[],
): void {
  const projectId = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptDir = join(runtimeRoot, 'projects', projectId, 'chats');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

function readQwenTranscript(
  runtimeRoot: string,
  cwd: string,
  sessionId: string,
): Array<Record<string, unknown>> {
  const projectId = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptPath = join(
    runtimeRoot,
    'projects',
    projectId,
    'chats',
    `${sessionId}.jsonl`,
  );
  return readFileSync(transcriptPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readNextQueuedEvent(
  agent: QwenAgent,
): Promise<AgentEvent | undefined> {
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
    const blocks = (
      QwenAgent.prototype as unknown as QwenPromptInternals
    ).buildPromptBlocks('  /context  ');

    expect(blocks).toEqual([{ type: 'text', text: '/context' }]);
  });

  it('starts Qwen ACP with the desktop channel', () => {
    const command = (
      QwenAgent.prototype as unknown as QwenSpawnInternals
    ).buildSpawnCommand('/opt/qwen/dist/cli.js', '/usr/local/bin/node');

    expect(command).toEqual({
      command: '/usr/local/bin/node',
      args: ['/opt/qwen/dist/cli.js', '--acp', '--channel=desktop'],
    });
  });

  it('does not prepend Craft context to Qwen prompts while disabled', () => {
    const blocks = (
      QwenAgent.prototype as unknown as QwenPromptInternals
    ).buildPromptBlocks('hello');

    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('drains queued mid-turn messages through the ACP extension handler', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const onMidTurnMessagesDrained = mock(() => {});
    const agent = createAgent(cwd, undefined, onMidTurnMessagesDrained);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'sdk-session-qwen';
    internals._isProcessing = true;

    expect(
      agent.enqueueMidTurnMessage('please also inspect tests', undefined, {
        messageId: 'queued-1',
      }),
    ).toBe(true);

    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'other-session',
      }),
    ).resolves.toEqual({});
    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'session-qwen',
      }),
    ).resolves.toEqual({
      messages: ['please also inspect tests'],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenCalledWith(['queued-1']);

    expect(
      agent.enqueueMidTurnMessage('and summarize findings', undefined, {
        messageId: 'queued-2',
      }),
    ).toBe(true);
    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({
      messages: ['and summarize findings'],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenLastCalledWith(['queued-2']);
    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({ messages: [] });

    agent.destroy();
  });

  it('acknowledges drained mid-turn messages without metadata by text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const onMidTurnMessagesDrained = mock(() => {});
    const agent = createAgent(cwd, undefined, onMidTurnMessagesDrained);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'sdk-session-qwen';
    internals._isProcessing = true;

    expect(agent.enqueueMidTurnMessage('legacy queued message')).toBe(true);

    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({
      messages: ['legacy queued message'],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenCalledWith([
      'legacy queued message',
    ]);

    agent.destroy();
  });

  it('drains queued mid-turn image attachments as ACP content blocks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const onMidTurnMessagesDrained = mock(() => {});
    const agent = createAgent(cwd, undefined, onMidTurnMessagesDrained);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'sdk-session-qwen';
    internals._isProcessing = true;

    const attachment: FileAttachment = {
      type: 'image',
      path: join(cwd, 'screenshot.png'),
      name: 'screenshot.png',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      size: 8,
    };
    expect(
      agent.enqueueMidTurnMessage('please inspect this image', [attachment], {
        messageId: 'queued-image',
      }),
    ).toBe(true);

    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({
      items: [
        {
          content: [
            { type: 'text', text: 'please inspect this image' },
            {
              type: 'image',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
            },
          ],
          displayText: 'please inspect this image',
        },
      ],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenCalledWith(['queued-image']);

    agent.destroy();
  });

  it('acknowledges image-only mid-turn messages by optimistic id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const onMidTurnMessagesDrained = mock(() => {});
    const agent = createAgent(cwd, undefined, onMidTurnMessagesDrained);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.qwenSessionId = 'sdk-session-qwen';
    internals._isProcessing = true;

    const attachment: FileAttachment = {
      type: 'image',
      path: join(cwd, 'screenshot.png'),
      name: 'screenshot.png',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      size: 8,
    };
    expect(
      agent.enqueueMidTurnMessage('', [attachment], {
        optimisticMessageId: 'optimistic-image',
      }),
    ).toBe(true);

    await expect(
      internals.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 'sdk-session-qwen',
      }),
    ).resolves.toEqual({
      items: [
        {
          content: [
            { type: 'text', text: '' },
            {
              type: 'image',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
            },
          ],
          displayText: '[User message with attachments]',
        },
      ],
    });
    expect(onMidTurnMessagesDrained).toHaveBeenCalledWith([
      'optimistic-image',
    ]);

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
        systemPayload: {
          phase: 'result',
          rawCommand: '/model',
          outputHistoryItems: [],
        },
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
            {
              type: 'info',
              text: 'This may take a couple minutes. Sit tight!',
            },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const acpMessages: Message[] = [
      {
        id: 'qwen-existing-1',
        role: 'assistant',
        content: 'This may take a couple minutes. Sit tight!',
        timestamp: Date.parse(insightResult),
      },
    ];

    const messages = (
      agent as unknown as QwenHistoryInternals
    ).mergeSlashCommandInvocationMessages(sessionId, acpMessages, cwd);
    agent.destroy();

    expect(
      messages.map((message) => [
        message.role,
        message.content,
        message.timestamp,
      ]),
    ).toEqual([
      ['user', '/insight', Date.parse(insightInvocation)],
      [
        'assistant',
        'This may take a couple minutes. Sit tight!',
        Date.parse(insightResult),
      ],
    ]);
    expect(messages[0]?.textElements).toBeUndefined();
  });

  it('does not derive text elements from Qwen user history without metadata', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const messages = (
      agent as unknown as QwenHistoryInternals
    ).buildHistoryMessages(
      'session-with-files',
      [
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: 'please inspect @packages/shared/src/agent/qwen-agent.ts:42',
          },
          _meta: { timestamp: 1234 },
        },
      ],
      cwd,
    );
    agent.destroy();

    expect(messages[0]?.textElements).toBeUndefined();
  });

  it('marks replayed pre-tool assistant text as commentary, not thought', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const messages = (
      agent as unknown as QwenHistoryInternals
    ).buildHistoryMessages(
      'session-with-commentary',
      [
        {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'I will inspect the available commands.',
          },
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

    expect(
      messages.map((message) => [
        message.role,
        message.content,
        message.isIntermediate ?? false,
        message.intermediateKind ?? '',
      ]),
    ).toEqual([
      [
        'assistant',
        'I will inspect the available commands.',
        true,
        'commentary',
      ],
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
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-30T08:02:52.927Z',
        type: 'user',
        cwd,
        version: 'test',
        message: { role: 'user', parts: [{ text: '/qc-helper hello' }] },
      },
    ]);

    const agent = createAgent(cwd);
    (
      agent as unknown as QwenHistoryInternals
    ).persistQwenTranscriptTextElements(sessionId, cwd, [
      {
        type: 'slash_command',
        byte_range: { start: 0, end: 10 },
        placeholder: '/qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      },
    ]);

    const records = readQwenTranscript(runtimeRoot, cwd, sessionId);
    agent.destroy();

    expect(records[0]?.textElements).toEqual([
      {
        type: 'slash_command',
        byte_range: { start: 0, end: 10 },
        placeholder: '/qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      },
    ]);
  });

  it('writes skill text elements into the Qwen transcript user record', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'session-with-skill-metadata';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-30T08:02:52.927Z',
        type: 'user',
        cwd,
        version: 'test',
        message: { role: 'user', parts: [{ text: '@qc-helper' }] },
      },
    ]);

    const agent = createAgent(cwd);
    (
      agent as unknown as QwenHistoryInternals
    ).persistQwenTranscriptTextElements(sessionId, cwd, [
      {
        type: 'skill',
        byte_range: { start: 0, end: 17 },
        placeholder: '[skill:qc-helper]',
        label: 'qc-helper',
        target: 'qc-helper',
      },
    ]);

    const records = readQwenTranscript(runtimeRoot, cwd, sessionId);
    agent.destroy();

    expect(records[0]?.textElements).toEqual([
      {
        type: 'skill',
        byte_range: { start: 0, end: 10 },
        placeholder: '@qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      },
    ]);
  });

  it('loads text elements back from the Qwen transcript', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(runtimeRoot, cwd);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'session-with-persisted-text-elements';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-04-30T08:02:52.927Z',
        type: 'user',
        cwd,
        version: 'test',
        message: { role: 'user', parts: [{ text: '@qc-helper' }] },
        textElements: [
          {
            type: 'skill',
            byte_range: { start: 0, end: 10 },
            placeholder: '@qc-helper',
            label: 'qc-helper',
            target: 'qc-helper',
          },
        ],
      },
    ]);

    const agent = createAgent(cwd);
    const messages = (
      agent as unknown as QwenHistoryInternals
    ).applyQwenTranscriptTextElements(
      [
        {
          id: 'message-1',
          role: 'user',
          content: '@qc-helper',
          timestamp: Date.parse('2026-04-30T08:02:52.927Z'),
        },
      ],
      sessionId,
      cwd,
    );
    agent.destroy();

    expect(messages[0]?.textElements).toEqual([
      {
        type: 'skill',
        byte_range: { start: 0, end: 10 },
        placeholder: '@qc-helper',
        label: 'qc-helper',
        target: 'qc-helper',
      },
    ]);
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
              text: JSON.stringify(
                {
                  checks: [
                    {
                      category: 'System',
                      name: 'Node.js version',
                      status: 'pass',
                      message: 'v22.22.1',
                    },
                  ],
                  summary: { pass: 1, warn: 0, fail: 0 },
                },
                null,
                2,
              ),
            },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const messages = (
      agent as unknown as QwenHistoryInternals
    ).mergeSlashCommandInvocationMessages(sessionId, [], cwd);
    agent.destroy();

    expect(messages.map((message) => [message.role, message.content])).toEqual([
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
    const messages = (
      agent as unknown as QwenHistoryInternals
    ).mergeSlashCommandInvocationMessages(sessionId, [], cwd);
    agent.destroy();

    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toContain('```json\n{');
    expect(messages[1]?.content).toContain('"message": "v24.11.1"');
  });

  it('does not send Craft context while Qwen prompt context is disabled', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const blocks = (agent as unknown as QwenPromptInternals).buildPromptBlocks(
      'Fix session names',
    );
    agent.destroy();

    const textBlock = blocks.find((block) => block.type === 'text');
    expect(textBlock?.text?.trim()).toBe('Fix session names');
    expect(textBlock?.text).not.toContain('<craft_agent_context>');

    const resourceBlock = blocks.find((block) => block.type === 'resource');
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
        _meta: {
          availableSkills: ['commit'],
          availableSkillDetails: [
            {
              name: 'commit',
              description: 'Commit changes',
              body: 'Commit instructions',
              filePath: '/skills/commit/SKILL.md',
              level: 'user',
            },
          ],
        },
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
      availableSkillDetails: [
        {
          name: 'commit',
          description: 'Commit changes',
          body: 'Commit instructions',
          filePath: '/skills/commit/SKILL.md',
          level: 'user',
        },
      ],
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
        availableCommands: [
          { name: 'project:fix', description: 'Run project fix' },
        ],
      },
    });

    expect(internals.eventQueue.hasPending).toBe(false);

    internals.suppressedSessionUpdates.delete('qwen-session');
    internals.flushPendingAvailableCommandsUpdate('qwen-session');

    const event = await readNextQueuedEvent(agent);
    agent.destroy();

    expect(event).toEqual({
      type: 'available_commands_update',
      availableCommands: [
        { name: 'project:fix', description: 'Run project fix' },
      ],
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
            availableCommands: [
              { name: 'project:fix', description: 'Run project fix' },
            ],
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

  it('invalidates cached available commands after installing a skill', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals & {
      latestAvailableCommandsSnapshot: {
        availableCommands: Array<{ name: string; description?: string }>;
        availableSkills?: string[];
      } | null;
    };
    const calledMethods: string[] = [];
    internals.qwenSessionId = 'qwen-session';
    internals.latestAvailableCommandsSnapshot = {
      availableCommands: [{ name: 'old:command' }],
      availableSkills: ['old-skill'],
    };
    internals.ensureProcess = async () => {};
    internals.callAcp = async (method, execute) => {
      calledMethods.push(method);
      if (method === 'qwen/skills/install') {
        return execute({
          extMethod: async () => ({
            slug: 'pptx',
            installed: true,
          }),
        });
      }
      if (method === 'session/load') {
        internals.handleSessionUpdate({
          sessionId: 'qwen-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'project:fix' }],
            _meta: { availableSkills: ['pptx'] },
          },
        });
        return execute({
          loadSession: async () => ({ models: {}, modes: {} }),
        });
      }
      throw new Error(`Unexpected ACP method ${method}`);
    };

    await agent.installSkill({
      id: 'pptx',
      slug: 'pptx',
      name: 'PPTX',
      description: 'Create and edit PowerPoint slide decks.',
      sourceUrl:
        'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
      scope: 'global',
    });
    const snapshot = await agent.refreshAvailableCommands();
    agent.destroy();

    expect(calledMethods).toEqual(['qwen/skills/install', 'session/load']);
    expect(snapshot?.availableSkills).toEqual(['pptx']);
  });

  it('deduplicates concurrent ACP session setup during command refresh', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const capturedSessionIds: string[] = [];
    const agent = createAgent(cwd, (sessionId) =>
      capturedSessionIds.push(sessionId),
    );
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
            availableCommands: [
              { name: 'project:fix', description: 'Run project fix' },
            ],
          },
        });
        return execute({
          newSession: async () => ({
            sessionId: 'qwen-session',
            models: {},
            modes: {},
          }),
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
          availableCommands: [
            { name: 'project:fix', description: 'Run project fix' },
          ],
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
    expect(
      result.messages.map((message) => [message.role, message.content]),
    ).toEqual([['user', 'hello']]);
  });

  it('loads Qwen history updates through ACP extension before session/load fallback', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    const calledMethods: string[] = [];
    internals.callAcp = async (method, execute) => {
      calledMethods.push(method);
      return execute({
        extMethod: async (extMethod, params) => {
          expect(extMethod).toBe('qwen/session/loadUpdates');
          expect(params).toEqual({ sessionId: 'qwen-session', cwd });
          return {
            updates: [
              {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'from extension' },
                timestamp: 1_000,
              },
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'loaded' },
                timestamp: 2_000,
              },
            ],
          };
        },
        loadSession: async () => {
          throw new Error('session/load should not be used');
        },
      });
    };

    const result = await agent.loadSessionMessages('qwen-session', { cwd });
    agent.destroy();

    expect(calledMethods).toEqual(['ext/qwen/session/loadUpdates']);
    expect(
      result.messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'from extension'],
      ['assistant', 'loaded'],
    ]);
    expect(result.messages.map((message) => message.timestamp)).toEqual([
      1_000, 2_000,
    ]);
  });

  it('restores Qwen transcript API aborts as interrupted info', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    tempRoots.push(cwd, runtimeRoot);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'qwen-session';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'user-1',
        sessionId,
        timestamp: '2026-05-31T02:22:59.803Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi' }] },
      },
      {
        uuid: 'abort-1',
        sessionId,
        timestamp: '2026-05-31T02:23:01.005Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_error',
            error_message: 'Request was aborted.',
            error_type: 'APIUserAbortError',
          },
        },
      },
    ]);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        extMethod: async () => ({ updates: [] }),
        loadSession: async () => ({ models: {}, modes: {} }),
      });

    const result = await agent.loadSessionMessages(sessionId, { cwd });
    agent.destroy();

    expect(
      result.messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'hi'],
      ['info', 'Response interrupted'],
    ]);
  });

  it('restores cancelled Qwen transcript tool results as interrupted tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    tempRoots.push(cwd, runtimeRoot);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'qwen-session';
    const commandArgs = {
      command: 'curl -s --max-time 10 https://api.github.com 2>&1',
      description: 'Test GitHub API connectivity',
      timeout: 15000,
    };

    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'user-1',
        sessionId,
        timestamp: '2026-05-31T02:11:24.862Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Open PRs?' }] },
      },
      {
        uuid: 'assistant-1',
        sessionId,
        timestamp: '2026-05-31T02:15:02.868Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'Let me try a different approach.', thought: true },
            {
              functionCall: {
                id: 'call-curl',
                name: 'run_shell_command',
                args: commandArgs,
              },
            },
          ],
        },
      },
      {
        uuid: 'tool-telemetry-1',
        sessionId,
        timestamp: '2026-05-31T02:15:06.203Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            function_name: 'run_shell_command',
            function_args: commandArgs,
            status: 'success',
            success: true,
          },
        },
      },
      {
        uuid: 'tool-result-1',
        sessionId,
        timestamp: '2026-05-31T02:15:06.267Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-curl',
                name: 'run_shell_command',
                response: {
                  output:
                    'Command was cancelled by user before it could complete. There was no output before it was cancelled.',
                },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-curl',
          status: 'success',
          resultDisplay: 'Command cancelled by user.',
        },
      },
    ]);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        extMethod: async () => ({
          updates: [
            {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-curl',
              kind: 'execute',
              title: 'run_shell_command',
              rawInput: commandArgs,
              _meta: {
                toolName: 'run_shell_command',
                timestamp: Date.parse('2026-05-31T02:15:02.868Z'),
              },
            },
          ],
        }),
        loadSession: async () => ({ models: {}, modes: {} }),
      });

    const result = await agent.loadSessionMessages(sessionId, { cwd });
    agent.destroy();

    const toolMessages = result.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: 'tool',
      toolUseId: 'call-curl',
      toolName: 'Bash',
      toolStatus: 'error',
      toolResult: 'Interrupted',
      isError: true,
    });
    expect(result.messages.at(-1)).toMatchObject({
      role: 'info',
      content: 'Response interrupted',
    });
  });

  it('closes dangling Qwen transcript tool calls as terminal errors', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    tempRoots.push(cwd, runtimeRoot);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'qwen-session';
    const commandArgs = {
      command: 'cd /repo && gh pr list',
      description: 'List open PRs',
    };

    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'user-1',
        sessionId,
        timestamp: '2026-05-31T02:50:53.210Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Open PRs?' }] },
      },
      {
        uuid: 'assistant-1',
        sessionId,
        timestamp: '2026-05-31T02:51:06.736Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'Let me check.', thought: true },
            {
              functionCall: {
                id: 'call-gh',
                name: 'run_shell_command',
                args: commandArgs,
              },
            },
          ],
        },
      },
    ]);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        extMethod: async () => ({
          updates: [
            {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-gh',
              kind: 'execute',
              title: 'run_shell_command',
              rawInput: commandArgs,
              _meta: {
                toolName: 'run_shell_command',
                timestamp: Date.parse('2026-05-31T02:51:06.736Z'),
              },
            },
          ],
        }),
        loadSession: async () => ({ models: {}, modes: {} }),
      });

    const result = await agent.loadSessionMessages(sessionId, { cwd });
    agent.destroy();

    const toolMessages = result.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: 'tool',
      toolUseId: 'call-gh',
      toolName: 'Bash',
      toolStatus: 'error',
      toolResult: 'Tool result was not recorded.',
      isError: true,
    });
    expect(result.messages.some((message) => message.role === 'info')).toBe(
      false,
    );
  });

  it('supplements Qwen history with transcript subagent telemetry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-runtime-'));
    tempRoots.push(cwd, runtimeRoot);
    process.env.QWEN_RUNTIME_DIR = runtimeRoot;

    const sessionId = 'qwen-session';
    const parentToolUseId = 'call-agent-1';
    writeQwenTranscript(runtimeRoot, cwd, sessionId, [
      {
        uuid: 'user-1',
        sessionId,
        timestamp: '2026-05-09T16:38:15.505Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: '调用 sub agent 帮我看看仓库' }],
        },
      },
      {
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId,
        timestamp: '2026-05-09T16:38:21.458Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: parentToolUseId,
                name: 'agent',
                args: {
                  description: 'Explore repository structure',
                  prompt: 'Inspect the repo',
                  subagent_type: 'Explore',
                },
              },
            },
          ],
        },
      },
      {
        uuid: 'child-read-1',
        parentUuid: 'assistant-1',
        sessionId,
        timestamp: '2026-05-09T16:38:25.836Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            function_name: 'read_file',
            function_args: { file_path: `${cwd}/package.json` },
            status: 'success',
            success: true,
            content_length: 7136,
            prompt_id: `${sessionId}#Explore-iyza6j#0`,
          },
        },
      },
    ]);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;
    internals.ensureProcess = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        loadSession: async () => ({ models: {}, modes: {} }),
      });

    const result = await agent.loadSessionMessages(sessionId, { cwd });
    agent.destroy();

    const parent = result.messages.find(
      (message) => message.toolUseId === parentToolUseId,
    );
    const child = result.messages.find(
      (message) => message.toolUseId === 'child-read-1',
    );

    expect(parent).toMatchObject({
      role: 'tool',
      toolName: 'agent',
      toolStatus: 'completed',
      toolResult: 'Completed',
      toolInput: { subagent_type: 'Explore' },
    });
    expect(child).toMatchObject({
      role: 'tool',
      toolName: 'Read',
      toolStatus: 'completed',
      parentToolUseId,
      toolResult: 'Completed (7136 bytes)',
    });
  });

  it('shares concurrent Qwen ACP process startup for one agent instance', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    tempRoots.push(cwd);

    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenAvailableCommandsInternals;

    let startCalls = 0;
    let releaseStart!: () => void;
    const startStarted = new Promise<void>((resolve) => {
      internals.startProcess = async () => {
        startCalls += 1;
        resolve();
        await new Promise<void>((release) => {
          releaseStart = release;
        });
        internals.acpLease = {
          isActive: () => true,
          release: () => {},
        };
        internals.connection = { signal: { aborted: false } };
      };
    });

    const first = internals.ensureProcess();
    await startStarted;
    const second = internals.ensureProcess();
    releaseStart();

    await Promise.all([first, second]);
    agent.destroy();

    expect(startCalls).toBe(1);
  });
});
