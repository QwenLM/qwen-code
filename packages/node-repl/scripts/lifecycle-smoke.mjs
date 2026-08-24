/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Verifies the server (and its kernel child) shut down when the MCP host closes
// stdin — the way a stdio host signals exit. Run after `npm run build`.
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'index.js');

const server = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: path.join(here, '..'),
});

const send = (obj) => server.stdin.write(JSON.stringify(obj) + '\n');
const kernelChildren = () => {
  try {
    return execSync(`pgrep -P ${server.pid}`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lifecycle', version: '1' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'node_repl', arguments: { code: 'nodeRepl.write("up");' } },
});

await new Promise((resolve) => {
  let buf = '';
  server.stdout.on('data', (c) => {
    buf += c.toString();
    if (buf.includes('"id":2')) resolve();
  });
});

const before = kernelChildren();
check('kernel child spawned', before.length > 0, `pids=${before.join(',')}`);

// Close stdin — this is how a stdio MCP host signals shutdown.
server.stdin.end();

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000);
  server.once('exit', () => {
    clearTimeout(timer);
    resolve(true);
  });
});
check('server exits on stdin EOF', exited);

await new Promise((r) => setTimeout(r, 500));
const stillAlive = before.filter((pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
});
check('kernel child reaped', stillAlive.length === 0, `alive=${stillAlive.join(',') || 'none'}`);

if (!exited) server.kill('SIGKILL');
console.log(failures === 0 ? '\nLIFECYCLE SMOKE PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
