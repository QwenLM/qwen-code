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
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

let root: string;
let server: Server;
let requests: ModelRequest[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hosted-prompt-surface-'));
  requests = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finishReason] of [
      [{ role: 'assistant', content: 'HOSTED_PROMPT_OK' }, null],
      [{}, 'stop'],
    ]) {
      res.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'hosted-prompt-fixture',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv('QWEN_HOME', path.join(root, 'config'));
  vi.stubEnv('QWEN_RUNTIME_DIR', path.join(root, 'runtime'));
  vi.stubEnv('OPENAI_API_KEY', 'hosted-prompt-fixture-key');
  vi.stubEnv('OPENAI_BASE_URL', baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'hosted-prompt-fixture');
  vi.stubEnv('QWEN_MODEL', 'hosted-prompt-fixture');
  await mkdir(path.join(root, 'config'));
  await writeFile(
    path.join(root, 'config', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'hosted-prompt-fixture' },
      telemetry: { enabled: false },
      modelProviders: {
        openai: [
          {
            id: 'hosted-prompt-fixture',
            envKey: 'OPENAI_API_KEY',
            baseUrl,
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
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const hostedTools = [
  'read_file',
  'write_file',
  'edit',
  'run_shell_command',
  'monitor',
];

async function request(toolNames?: string[]) {
  const result = await runHostedHarnessTextTurn({
    sessionId: randomUUID(),
    cwd: root,
    history: [],
    prompt: 'hello',
    promptId: randomUUID(),
    signal: AbortSignal.timeout(15_000),
    agentInstructions: 'HOSTED_AGENT_INSTRUCTIONS',
    workspaceContext: { read: () => 'HOSTED_WORKSPACE_CONTEXT' },
    ...(toolNames
      ? {
          toolTurn: {
            declarations: async () =>
              toolNames.map((name) => ({
                name,
                description: `Fixture ${name}`,
                parametersJsonSchema: { type: 'object', properties: {} },
              })),
            execute: async () => {
              throw new Error('Unexpected tool invocation');
            },
            consumeResults: async () => undefined,
            setPromptHookRunner: () => undefined,
          },
        }
      : {}),
  });
  expect(result.text).toBe('HOSTED_PROMPT_OK');
  expect(requests).toHaveLength(1);
  const wire = requests[0]!;
  const system = JSON.stringify(
    wire.messages.find((message) => message.role === 'system')?.content,
  );
  expect(system.indexOf('HOSTED_AGENT_INSTRUCTIONS')).toBeGreaterThan(100);
  expect(system.indexOf('HOSTED_WORKSPACE_CONTEXT')).toBeGreaterThan(
    system.indexOf('HOSTED_AGENT_INSTRUCTIONS'),
  );
  return { wire, system };
}

it('uses the five Hosted declarations to filter the prompt sent to the model', async () => {
  const { wire, system } = await request(hostedTools);
  expect(wire.tools?.map((tool) => tool.function.name)).toEqual(hostedTools);
  expect
    .soft(system.includes("To read files use 'read_file'"), 'read guidance')
    .toBe(true);
  expect
    .soft(system.includes('**Monitor Processes:**'), 'monitor guidance')
    .toBe(true);
  expect
    .soft(
      system.includes("To search for files use 'glob'"),
      'unavailable glob guidance',
    )
    .toBe(false);
  expect
    .soft(
      system.includes("To search the content of files, use 'grep_search'"),
      'unavailable grep guidance',
    )
    .toBe(false);
  expect
    .soft(
      system.includes('**Subagent Delegation:**'),
      'unavailable agent guidance',
    )
    .toBe(false);
  expect
    .soft(
      /\[tool_call:\s*(?:glob|grep_search|agent)\b/.test(system),
      'unavailable tool examples',
    )
    .toBe(false);
});

it('omits tool-specific guidance and worked calls from a no-tool request', async () => {
  const { wire, system } = await request();
  expect(wire.tools ?? []).toEqual([]);
  expect
    .soft(
      system.includes("To read files use 'read_file'"),
      'unavailable read guidance',
    )
    .toBe(false);
  expect
    .soft(
      system.includes('**Background Processes:**'),
      'unavailable shell guidance',
    )
    .toBe(false);
  expect
    .soft(
      system.includes('**Subagent Delegation:**'),
      'unavailable agent guidance',
    )
    .toBe(false);
  expect
    .soft(/\[tool_call:/.test(system), 'tool examples with no declarations')
    .toBe(false);
});
