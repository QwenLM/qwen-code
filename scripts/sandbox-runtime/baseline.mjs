/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const output =
  process.argv[2] ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../.qwen/e2e-tests/runtime-shell-sandbox',
  );
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'qwen-runtime-shell-baseline-'),
);
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
const home = path.join(root, 'home');
const runtime = path.join(root, 'runtime');
await Promise.all([workspace, outside, home, runtime].map((p) => fs.mkdir(p)));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `printf workspace-ok > ${quote(path.join(workspace, 'inside.txt'))}; printf outside-ok > ${quote(path.join(outside, 'outside.txt'))}; printf baseline-executed`;
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const data of req) raw += data;
  const body = JSON.parse(raw);
  const tools = body.messages?.filter((m) => m.role === 'tool') ?? [];
  requests.push({
    url: req.url,
    tools: body.tools?.map((t) => t.function?.name),
    toolResults: tools,
    stream: body.stream,
  });
  const toolCalls = tools.length
    ? undefined
    : [
        {
          id: 'call_baseline_shell',
          type: 'function',
          function: {
            name: 'run_shell_command',
            arguments: JSON.stringify({
              command,
              is_background: false,
              timeout: 10000,
            }),
          },
        },
      ];
  const message = {
    role: 'assistant',
    content: tools.length ? 'BASELINE_COMPLETE' : '',
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
  const common = {
    id: 'chatcmpl-baseline',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };
  const finish = toolCalls ? 'tool_calls' : 'stop';
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...common,
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    );
  } else {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
      );
    send({ role: 'assistant', content: '' });
    if (toolCalls)
      send({ tool_calls: toolCalls.map((t, index) => ({ index, ...t })) });
    else send({ content: message.content });
    send({}, finish, { usage });
    res.end('data: [DONE]\n\n');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const binary = spawnSync('/bin/zsh', ['-lc', 'command -v qwen'], {
  encoding: 'utf8',
}).stdout.trim();
const version = spawnSync(binary, ['--version'], {
  encoding: 'utf8',
}).stdout.trim();
const args = [
  '--bare',
  '--auth-type',
  'openai',
  '--openai-base-url',
  `http://127.0.0.1:${port}/v1`,
  '--openai-api-key',
  'sk-mock',
  '--model',
  'mock-model',
  '--approval-mode',
  'yolo',
  '--output-format',
  'json',
  '-p',
  'Run the disposable fixture check',
];
const env = {
  PATH: process.env.PATH,
  HOME: home,
  QWEN_RUNTIME_DIR: runtime,
  TMPDIR: root,
  LANG: 'en_US.UTF-8',
  TERM: 'dumb',
  NO_PROXY: '127.0.0.1,localhost',
  CI: 'true',
};
let stdout = '',
  stderr = '';
const child = spawn(binary, args, {
  cwd: workspace,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
const result = await new Promise((resolve) =>
  child.on('exit', (code, signal) => resolve({ code, signal })),
);
clearTimeout(timer);
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
const read = async (p) => fs.readFile(p, 'utf8').catch(() => null);
const inside = await read(path.join(workspace, 'inside.txt'));
const outsideValue = await read(path.join(outside, 'outside.txt'));
const report = {
  time: new Date().toISOString(),
  root,
  binary,
  version,
  args,
  env,
  command,
  result,
  requests,
  inside,
  outside: outsideValue,
  pass:
    result.code === 0 &&
    inside === 'workspace-ok' &&
    outsideValue === 'outside-ok' &&
    requests.some((r) => r.toolResults.length),
};
await Promise.all([
  fs.writeFile(
    path.join(output, 'baseline.json'),
    JSON.stringify(report, null, 2),
  ),
  fs.writeFile(path.join(output, 'baseline.stdout.log'), stdout),
  fs.writeFile(path.join(output, 'baseline.stderr.log'), stderr),
]);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
