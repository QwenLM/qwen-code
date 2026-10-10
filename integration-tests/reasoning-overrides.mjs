/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* global setTimeout, clearTimeout, console, process */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeOpenAIServer, fakeToolCall } from './fake-openai-server.ts';
const bundle = resolve('dist/cli.js');
const deadline = setTimeout(() => {
  for (const child of children) child.kill('SIGTERM');
  throw new Error('E2E timed out');
}, 180000);
const root = await mkdtemp(join(tmpdir(), 'qwen-reasoning-v2-'));
const children = new Set();
const requests = [];
let held, release;
const chat = await startFakeOpenAIServer(async ({ body }) => {
  requests.push(body);
  if (JSON.stringify(body.messages).includes('HOLD_REASONING') && !held) {
    held = true;
    await new Promise((done) => (release = done));
    return {
      toolCalls: [
        fakeToolCall('agent', {
          description: 'Reasoning snapshot probe',
          prompt: 'CHILD_REASONING',
          run_in_background: false,
        }),
      ],
    };
  }
  return { content: 'REASONING_OK' };
});
const native = createServer(async (req, res) => {
  let input = '';
  for await (const chunk of req) input += chunk;
  const body = JSON.parse(input || '{}');
  if (req.url.includes('countTokens')) return res.end('{"totalTokens":10}');
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = req.url.includes('GenerateContent')
    ? [
        '{"candidates":[{"content":{"role":"model","parts":[{"text":"REASONING_OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}',
      ]
    : req.url.includes('responses')
      ? [
          '{"type":"response.output_text.delta","delta":"REASONING_OK"}',
          '{"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
        ]
      : [
          '{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"alias","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
          '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"REASONING_OK"}}',
          '{"type":"content_block_stop","index":0}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          '{"type":"message_stop"}',
        ];
  for (const data of events) {
    const type = JSON.parse(data).type;
    res.write(`${type ? `event: ${type}\n` : ''}data: ${data}\n\n`);
  }
  res.end();
});
await new Promise((done) => native.listen(0, '127.0.0.1', done));
const nativeUrl = `http://127.0.0.1:${native.address().port}`;
const tiered = (profile, defaultEffort = 'medium') => ({
  profile,
  efforts: ['low', 'medium', 'high'],
  defaultEffort,
});
const model = (id, reasoning, baseUrl = chat.baseUrl) => ({
  id,
  baseUrl,
  envKey: 'REASONING_TEST_KEY',
  capabilities: { reasoning },
});
async function fixture(name, auth, models) {
  const cwd = join(root, name),
    home = join(cwd, 'config');
  await mkdir(home, { recursive: true });
  const settings = {
    $version: 4,
    security: { auth: { selectedType: auth } },
    model: { name: models[0].id },
    modelProviders: { [auth]: models },
    telemetry: { enabled: false },
  };
  const file = join(home, 'settings.json');
  await writeFile(file, JSON.stringify(settings));
  const env = {
    ...process.env,
    QWEN_HOME: home,
    QWEN_RUNTIME_DIR: join(cwd, 'runtime'),
    REASONING_TEST_KEY: 'dummy',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
  };
  return { cwd, file, settings, env };
}
function start(f, args) {
  const child = spawn(process.execPath, [bundle, ...args], {
    cwd: f.cwd,
    env: f.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  children.add(child);
  return { child, error: () => stderr };
}
async function headless(f) {
  const { child, error } = start(f, [
    ...'--approval-mode yolo --output-format json'.split(' '),
    ...'--max-wall-time 30s'.split(' '),
    '-p',
    'Say REASONING_OK',
  ]);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end();
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(code, 0, error());
  assert.match(output, /REASONING_OK/);
}
function acp(f) {
  const { child } = start(f, ['--acp', '--no-chat-recording']);
  const client = new ClientSideConnection(
    () => ({ sessionUpdate() {} }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  return { child, client };
}
const cases = [
  ['openai', 'openai-effort', 'reasoning_effort', 'medium'],
  ['openai', 'openai-reasoning', 'reasoning.effort', 'medium'],
  ['openai', 'deepseek-openai', 'thinking.type', 'enabled'],
  ['openai', 'dashscope-effort', 'reasoning_effort', 'medium'],
  ['openai', 'dashscope-thinking', 'enable_thinking', true],
  [
    'openai',
    'qwen-chat-template',
    'chat_template_kwargs.enable_thinking',
    true,
  ],
  ['anthropic', 'anthropic-manual', 'thinking.type', 'enabled'],
  ['anthropic', 'anthropic-adaptive', 'thinking.type', 'adaptive'],
  ['anthropic', 'deepseek-anthropic', 'output_config.effort', 'medium'],
  [
    'gemini',
    'gemini',
    'generationConfig.thinkingConfig.thinkingLevel',
    'MEDIUM',
  ],
  ['openai-responses', 'openai-reasoning', 'reasoning.effort', 'medium'],
];
try {
  for (const [auth, profile, field, expected] of cases) {
    if (process.argv[2] && !profile.includes(process.argv[2])) continue;
    const declaration =
      profile === 'dashscope-thinking' || profile === 'qwen-chat-template'
        ? { profile }
        : tiered(profile);
    const f = await fixture(profile + auth, auth, [
      model(
        'company-alias',
        declaration,
        auth === 'openai' ? chat.baseUrl : nativeUrl,
      ),
    ]);
    const before = requests.length;
    await headless(f);
    const body = requests.slice(before)[0];
    assert.equal(
      field.split('.').reduce((value, key) => value?.[key], body),
      expected,
    );
    if (profile === 'anthropic-manual')
      assert.ok(body.thinking.budget_tokens > 0);
    console.log('PASS wire', auth, profile);
  }
  const f = await fixture('acp', 'openai', [
    model('qwen3.8-max', tiered('dashscope-effort')),
    model('deepseek-v4-flash', tiered('deepseek-openai', 'high')),
    model('kimi-k2.5', { profile: 'qwen-chat-template' }),
  ]);
  const { client } = acp(f);
  await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await client.newSession({ cwd: f.cwd, mcpServers: [] });
  const sessionId = session.sessionId;
  const option = (result) =>
    result.configOptions.find((opt) => opt.id === 'reasoning_effort');
  assert.equal(option(session).currentValue, 'medium');
  assert.ok(!option(session).options.some((opt) => opt.value === 'default'));
  for (const name of ['deepseek-v4-flash', 'kimi-k2.5', 'qwen3.8-max']) {
    const value = session.models.availableModels.find((m) =>
      m.modelId.includes(name),
    ).modelId;
    const switched = await client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value,
    });
    if (name === 'deepseek-v4-flash')
      assert.equal(option(switched).currentValue, 'high');
    if (name === 'qwen3.8-max')
      assert.equal(option(switched).currentValue, 'medium');
  }
  await client.setSessionConfigOption({
    sessionId,
    configId: 'mode',
    value: 'yolo',
  });
  const before = requests.length;
  const prompt = (text) =>
    client.prompt({ sessionId, prompt: [{ type: 'text', text }] });
  const running = prompt('HOLD_REASONING');
  while (!release) await delay(50);
  for (const effort of ['low', 'high']) {
    const current = JSON.parse(await readFile(f.file, 'utf8'));
    current.modelProviders.openai[0].capabilities.reasoning.defaultEffort =
      effort;
    await writeFile(f.file, JSON.stringify(current));
    await client.extMethod('qwen/control/workspace/reload', {});
    await delay(1000);
  }
  release();
  await running;
  const current = requests.slice(before).filter((b) => b.stream);
  assert.ok(current.length >= 3, 'child and parent continuation must occur');
  assert.ok(
    current.some((b) =>
      b.messages.some(
        (m) =>
          m.role === 'user' &&
          JSON.stringify(m.content).includes('CHILD_REASONING'),
      ),
    ),
  );
  assert.ok(current.every((b) => b.reasoning_effort === 'medium'));
  const after = requests.length;
  await prompt('NEXT_REASONING');
  assert.equal(
    requests.slice(after).find((b) => b.stream).reasoning_effort,
    'high',
  );
  console.log(
    'PASS ACP concrete controls, model switches, two reloads, frozen continuation, next prompt',
  );
} finally {
  clearTimeout(deadline);
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests));
  for (const child of children) child.kill('SIGTERM');
  await chat.close();
  native.closeAllConnections();
  native.close();
  console.log('ARTIFACT', root);
}
