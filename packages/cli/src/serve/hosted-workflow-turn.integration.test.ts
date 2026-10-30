/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHostedWorkflowTurn } from './hosted-workflow-turn.js';

// The workflow child's agents run through the real subagent manager and a
// real per-turn config here; only the model is a fixture. A Harness-only file
// sits in the Harness's cwd: an agent that can read it (P1) or that is shown
// a listing of that directory (P2) carries its name or content to the wire.

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

let root: string;
let cwd: string;
let markerName: string;
let markerContent: string;
let server: Server;
let requests: CapturedRequest[];

function chunk(delta: Record<string, unknown>, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'workflow-fixture',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCall(name: string, args: Record<string, unknown>): string[] {
  return [
    chunk(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID().slice(0, 8)}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    chunk({}, 'tool_calls'),
  ];
}

function text(content: string): string[] {
  return [chunk({ role: 'assistant', content }, null), chunk({}, 'stop')];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hosted-workflow-agents-'));
  cwd = path.join(root, 'harness-cwd');
  await mkdir(path.join(cwd, 'runtime-structure'), { recursive: true });
  markerName = `HARNESS_ONLY_${randomUUID().replace(/-/g, '')}.txt`;
  markerContent = `HARNESS_CONTENT_${randomUUID().replace(/-/g, '')}`;
  await writeFile(path.join(cwd, markerName), markerContent);
  requests = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(
      Buffer.concat(chunks).toString(),
    ) as CapturedRequest;
    requests.push(body);
    const names = (body.tools ?? []).map((tool) => tool.function?.name);
    const last = body.messages[body.messages.length - 1];
    // A tool answer is echoed so whatever a tool returned reaches the
    // workflow result; otherwise the agent reaches for the Harness file
    // with whatever it was given.
    const reply =
      last?.role === 'tool'
        ? text(`ECHO ${JSON.stringify(last.content)}`)
        : names.includes('structured_output')
          ? toolCall('structured_output', { answer: 'SCHEMA_OK' })
          : names.includes('read_file')
            ? toolCall('read_file', { file_path: path.join(cwd, markerName) })
            : text('TEXT_ONLY_OK');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const line of reply) res.write(line);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv('QWEN_HOME', path.join(root, 'config'));
  vi.stubEnv('QWEN_RUNTIME_DIR', path.join(root, 'runtime'));
  vi.stubEnv('OPENAI_API_KEY', 'workflow-fixture-key');
  vi.stubEnv('OPENAI_BASE_URL', baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'workflow-fixture');
  vi.stubEnv('QWEN_MODEL', 'workflow-fixture');
  await mkdir(path.join(root, 'config'));
  await writeFile(
    path.join(root, 'config', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'workflow-fixture' },
      telemetry: { enabled: false },
      modelProviders: {
        openai: [{ id: 'workflow-fixture', envKey: 'OPENAI_API_KEY', baseUrl }],
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

function launch(call: string) {
  const script = `export const meta = { name: "probe", description: "d" };\nreturn await ${call};`;
  return {
    definition: {
      definitionId: 'workflow/probe',
      definitionRevision: 1,
      definitionDigest: createHash('sha256')
        .update(script, 'utf8')
        .digest('hex'),
    },
    script,
    args: null,
  };
}

function run(call: string) {
  return runHostedWorkflowTurn({
    sessionId: randomUUID(),
    cwd,
    launch: launch(call),
    signal: AbortSignal.timeout(30_000),
  });
}

function declaredTools(): string[] {
  return requests.flatMap((request) =>
    (request.tools ?? []).map((tool) => String(tool.function?.name)),
  );
}

function expectNothingOfTheHost(resultText: string): void {
  const wire = JSON.stringify(requests);
  expect(wire).not.toContain(markerName);
  expect(wire).not.toContain(markerContent);
  expect(wire).not.toContain(root);
  expect(resultText).not.toContain(markerName);
  expect(resultText).not.toContain(markerContent);
}

describe('runHostedWorkflowTurn agents on the real subagent manager', () => {
  it.each([
    ['the plain dispatch', 'agent("read the marker")'],
    [
      'a model override',
      'agent("read the marker", { model: "workflow-fixture" })',
    ],
    ['an effort override', 'agent("read the marker", { effort: "low" })'],
  ])(
    'gives %s no tools and nothing of the Harness filesystem',
    async (_name, call) => {
      const result = await run(call);
      expect(requests.length).toBeGreaterThan(0);
      expect(declaredTools()).toEqual([]);
      expect(result.text).toContain('TEXT_ONLY_OK');
      expectNothingOfTheHost(result.text);
    },
  );

  it('keeps only structured_output for a schema dispatch', async () => {
    const result = await run(
      'agent("read the marker", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } })',
    );
    expect(new Set(declaredTools())).toEqual(new Set(['structured_output']));
    expect(result.text).toContain('SCHEMA_OK');
    expectNothingOfTheHost(result.text);
  });
});
