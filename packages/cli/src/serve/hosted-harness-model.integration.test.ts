/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedContextCompression } from './hosted-context-compression.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

let root: string;
let server: Server;
let reply: string;
let promptTokens: number;
let requests: Array<{
  model?: string;
  messages: Array<{
    role: string;
    content: unknown;
    reasoning_content?: string;
  }>;
  tools?: unknown[];
}>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pr12713-model-repro-'));
  requests = [];
  reply = 'HOSTED_TEXT_OK';
  promptTokens = 37;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (body.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          model: 'pr12713-fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: reply },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 11,
            total_tokens: promptTokens + 11,
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finishReason] of [
      [{ role: 'assistant', reasoning_content: 'HOSTED_REASONING_OK' }, null],
      [{ content: reply }, null],
      [{}, 'stop'],
    ]) {
      res.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'pr12713-fixture',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'pr12713-fixture',
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 11,
          total_tokens: promptTokens + 11,
        },
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  vi.stubEnv('QWEN_HOME', path.join(root, 'config'));
  vi.stubEnv('QWEN_RUNTIME_DIR', path.join(root, 'runtime'));
  vi.stubEnv('OPENAI_API_KEY', 'pr12713-fixture-key');
  vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
  vi.stubEnv('OPENAI_MODEL', 'pr12713-fixture');
  vi.stubEnv('QWEN_MODEL', 'pr12713-fixture');
  await mkdir(path.join(root, 'config'));
  await writeFile(
    path.join(root, 'config', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'pr12713-fixture' },
      telemetry: { enabled: false },
      modelProviders: {
        openai: [
          {
            id: 'definition-model',
            envKey: 'OPENAI_API_KEY',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            generationConfig: { contextWindowSize: 32_768 },
          },
          {
            id: 'pr12713-fixture',
            envKey: 'OPENAI_API_KEY',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            generationConfig: { contextWindowSize: 65_536 },
          },
        ],
      },
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

function record(type: 'user' | 'assistant', text: string): ChatRecord {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    cwd: process.cwd(),
    version: 'hosted-harness/1',
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text }],
    },
  };
}

function turn(history: ChatRecord[] = []) {
  return runHostedHarnessTextTurn({
    sessionId: randomUUID(),
    cwd: root,
    history,
    prompt: 'CURRENT_PROMPT',
    promptId: randomUUID(),
    signal: AbortSignal.timeout(15_000),
  });
}

it('completes a real hosted no-tool text turn', async () => {
  await expect(turn()).resolves.toMatchObject({ text: 'HOSTED_TEXT_OK' });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.tools ?? []).toEqual([]);
});

it('uses the real compression engine and restores its journal snapshot in the next provider request after reopening', async () => {
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'definition',
    Buffer.from('{}'),
  );
  const options = {
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'manual-transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
  };
  let managed = await openManagedSession({
    ...options,
    create: {
      definitionRef,
      rootSnapshotRef: definitionRef,
      createdBy: 'test',
    },
  });
  try {
    const promptId = randomUUID();
    for (const type of ['user', 'assistant'] as const)
      await managed.sink.write({
        ...record(type, 'RAW_BEFORE_COMPRESSION '.repeat(1_000)),
        sessionId: sessionKey.sessionId,
        daemonPromptId: promptId,
      });
    await managed.sink.write({
      ...record('user', ''),
      sessionId: sessionKey.sessionId,
      type: 'system',
      subtype: 'turn_result',
      message: undefined,
      systemPayload: {
        promptId,
        state: 'completed',
        stopReason: 'end_turn',
        endedAt: Date.now(),
      },
    });
    const compression = new HostedContextCompression({
      session: managed,
      cwd: root,
      instructions: async () => 'Remember the requested color.',
      busy: () => false,
      hasPendingHooks: () => false,
    });
    const operationId = randomUUID();
    reply =
      '<state_snapshot><overall_goal>MANUAL_MEMORY_BLUE</overall_goal></state_snapshot>';
    promptTokens = 12_000;
    await compression.admit({ operationId, expectedCompactionRevision: 0 });
    await compression.wait();
    expect(compression.status(operationId)).toMatchObject({
      outcome: 'compressed',
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('RAW_BEFORE_COMPRESSION');
    await managed.close();
    managed = await openManagedSession({ ...options, workerId: 'replacement' });
    reply = 'HOSTED_TEXT_OK';
    promptTokens = 37;
    const result = await runHostedHarnessTextTurn({
      sessionId: sessionKey.sessionId,
      cwd: root,
      history: await managed.sink.projectModelRecords(),
      prompt: 'Use the remembered color.',
      promptId: randomUUID(),
      signal: AbortSignal.timeout(15_000),
    });
    expect(result.text).toBe('HOSTED_TEXT_OK');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('MANUAL_MEMORY_BLUE');
    expect(JSON.stringify(requests[1])).not.toContain('RAW_BEFORE_COMPRESSION');
    expect(
      (await managed.sink.project()).filter(
        (entry) => entry.type === 'user' || entry.type === 'assistant',
      ),
    ).toHaveLength(2);
  } finally {
    await managed.close();
  }
}, 30_000);

it('persists normalized provider prompt usage with the resolved configured capacity', async () => {
  const complete = vi.fn().mockResolvedValue(undefined);
  await runHostedHarnessTextTurn({
    sessionId: randomUUID(),
    cwd: root,
    history: [],
    prompt: 'CURRENT_PROMPT',
    promptId: randomUUID(),
    signal: AbortSignal.timeout(15_000),
    modelScope: {
      bindBudget: vi.fn(),
      evaluate: vi.fn(),
      beginMainAttempt: vi.fn().mockResolvedValue(complete),
    },
  });
  expect(complete).toHaveBeenCalledWith(true, [
    expect.objectContaining({
      promptTokenCount: 37,
      candidatesTokenCount: 11,
      totalTokenCount: 48,
      contextWindowSize: 65_536,
    }),
  ]);
});

it('changes the next request model and capacity while retaining Session history', async () => {
  const sessionId = randomUUID();
  const first = await runHostedHarnessTextTurn({
    sessionId,
    cwd: root,
    history: [],
    prompt: 'FIRST_MODEL_MESSAGE',
    promptId: randomUUID(),
    signal: AbortSignal.timeout(15_000),
  });
  const complete = vi.fn().mockResolvedValue(undefined);
  const result = await runHostedHarnessTextTurn({
    sessionId,
    cwd: root,
    history: [
      record('user', 'FIRST_MODEL_MESSAGE'),
      record('assistant', first.text),
    ],
    prompt: 'SECOND_MODEL_MESSAGE',
    promptId: randomUUID(),
    signal: AbortSignal.timeout(15_000),
    modelSelection: { modelId: 'definition-model', revision: 1 },
    modelScope: {
      bindBudget: vi.fn(),
      evaluate: vi.fn(),
      beginMainAttempt: vi.fn().mockResolvedValue(complete),
    },
  });
  expect(result.model).toBe('definition-model');
  expect(requests.map((request) => request.model)).toEqual([
    'pr12713-fixture',
    'definition-model',
  ]);
  expect(requests[1]?.messages).toContainEqual({
    role: 'user',
    content: [{ type: 'text', text: 'FIRST_MODEL_MESSAGE' }],
  });
  expect(requests[1]?.messages).toContainEqual({
    role: 'assistant',
    content: 'HOSTED_TEXT_OK',
  });
  expect(complete).toHaveBeenCalledWith(true, [
    expect.objectContaining({
      promptTokenCount: 37,
      contextWindowSize: 32_768,
    }),
  ]);
});

it('retains real provider reasoning Parts for the next no-tool request', async () => {
  const result = await turn();
  expect(result.parts).toEqual([
    { text: 'HOSTED_REASONING_OK', thought: true },
    { text: 'HOSTED_TEXT_OK' },
  ]);
  const assistant = record('assistant', '');
  assistant.message!.parts = result.parts;
  await turn([record('user', 'OLD_PROMPT'), assistant]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages).toContainEqual({
    role: 'assistant',
    content: 'HOSTED_TEXT_OK',
    reasoning_content: 'HOSTED_REASONING_OK',
  });
});

it.each([
  [
    'unanswered turn',
    [record('user', 'OLD_UNANSWERED_PROMPT')],
    ['OLD_UNANSWERED_PROMPT'],
    [],
  ],
  [
    'two unanswered turns',
    [record('user', 'FIRST_UNANSWERED'), record('user', 'SECOND_UNANSWERED')],
    ['FIRST_UNANSWERED', 'SECOND_UNANSWERED'],
    [],
  ],
  [
    'completed turn with an empty answer',
    [record('user', 'EMPTY_ANSWER_PROMPT'), record('assistant', '')],
    ['EMPTY_ANSWER_PROMPT'],
    [],
  ],
  [
    'completed turn before an empty answer',
    [
      record('user', 'OLD_PROMPT'),
      record('assistant', 'OLD_RESPONSE'),
      record('user', 'EMPTY_ANSWER_PROMPT'),
      record('assistant', ''),
    ],
    ['EMPTY_ANSWER_PROMPT'],
    ['OLD_PROMPT', 'OLD_RESPONSE'],
  ],
  [
    'completed turn',
    [record('user', 'OLD_PROMPT'), record('assistant', 'OLD_RESPONSE')],
    [],
    ['OLD_PROMPT', 'OLD_RESPONSE'],
  ],
  [
    'completed turn following an unanswered turn',
    [
      record('user', 'OLD_UNANSWERED_PROMPT'),
      record('user', 'OLD_PROMPT'),
      record('assistant', 'OLD_RESPONSE'),
    ],
    ['OLD_UNANSWERED_PROMPT'],
    ['OLD_PROMPT', 'OLD_RESPONSE'],
  ],
  [
    'completed turn with queued guidance following an unanswered turn',
    [
      record('user', 'OLD_UNANSWERED_PROMPT'),
      record('user', 'OLD_PROMPT'),
      {
        ...record('user', 'FIRST_GUIDANCE'),
        subtype: 'mid_turn_user_message' as const,
      },
      {
        ...record('user', 'SECOND_GUIDANCE'),
        subtype: 'mid_turn_user_message' as const,
      },
      record('assistant', 'OLD_RESPONSE'),
    ],
    ['OLD_UNANSWERED_PROMPT'],
    ['OLD_PROMPT', 'FIRST_GUIDANCE', 'SECOND_GUIDANCE', 'OLD_RESPONSE'],
  ],
  [
    'completed turn with guidance after an initial answer',
    [
      record('user', 'OLD_PROMPT'),
      record('assistant', 'INITIAL_RESPONSE'),
      {
        ...record('user', 'LATE_GUIDANCE'),
        subtype: 'mid_turn_user_message' as const,
      },
      record('assistant', 'FINAL_RESPONSE'),
    ],
    [],
    ['OLD_PROMPT', 'INITIAL_RESPONSE', 'LATE_GUIDANCE', 'FINAL_RESPONSE'],
  ],
])(
  'sends the current prompt after a %s',
  async (_label, history, omitted, retained) => {
    await expect(turn(history)).resolves.toMatchObject({
      text: 'HOSTED_TEXT_OK',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toEqual([]);
    const lastUser = requests[0]?.messages
      .filter((m) => m.role === 'user')
      .at(-1);
    expect(JSON.stringify(lastUser?.content)).toContain('CURRENT_PROMPT');
    for (const text of omitted) {
      expect(JSON.stringify(requests[0]?.messages)).not.toContain(text);
    }
    for (const text of retained) {
      expect(JSON.stringify(requests[0]?.messages)).toContain(text);
    }
  },
);

it('sends the selected model and preserves core, agent and project instruction order on the wire', async () => {
  await runHostedHarnessTextTurn({
    sessionId: randomUUID(),
    cwd: root,
    history: [],
    prompt: 'hello',
    promptId: randomUUID(),
    signal: new AbortController().signal,
    agentDefinition: {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
      model: { id: 'definition-model' },
    },
    agentInstructions: 'D8_AGENT_INSTRUCTION',
    workspaceContext: { read: () => 'D8_PROJECT_CONTEXT' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.model).toBe('definition-model');
  const system = JSON.stringify(
    requests[0]?.messages.find((m) => m.role === 'system')?.content,
  );
  const agent = system.indexOf('D8_AGENT_INSTRUCTION');
  expect(agent).toBeGreaterThan(100);
  expect(system.indexOf('D8_PROJECT_CONTEXT')).toBeGreaterThan(agent);
});
