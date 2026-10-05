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
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

let root: string;
let server: Server;
let requests: Array<{
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
}>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pr12713-model-repro-'));
  requests = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finishReason] of [
      [{ role: 'assistant', content: 'HOSTED_TEXT_OK' }, null],
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
            id: 'pr12713-fixture',
            envKey: 'OPENAI_API_KEY',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
  await rm(root, { recursive: true, force: true });
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
