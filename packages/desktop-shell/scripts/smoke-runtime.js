#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(packageDir, 'runtime', 'qwen-code');
const nodePath =
  process.platform === 'win32'
    ? path.join(runtimeRoot, 'node', 'node.exe')
    : path.join(runtimeRoot, 'node', 'bin', 'node');
const entryPath = path.join(runtimeRoot, 'lib', 'cli-entry.js');
const token = crypto.randomBytes(32).toString('hex');

const child = spawn(
  nodePath,
  [entryPath, 'serve', '--port', '0', '--hostname', '127.0.0.1', '--require-auth', '--workspace', packageDir, '--no-open'],
  {
    cwd: packageDir,
    env: { ...process.env, QWEN_SERVER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
let done = false;
const timeout = setTimeout(() => finish(new Error('Timed out waiting for bundled daemon startup')), 45_000);
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  const match = output.match(/qwen serve listening on (http:\/\/[^\s]+)/);
  if (match) void verify(match[1]);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
child.on('exit', (code) => {
  if (!done) finish(new Error(`Bundled daemon exited before readiness (code ${code})\n${output}`));
});

async function verify(baseUrl) {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok || !text.includes('"status":"ok"')) {
    finish(new Error(`Health check failed: ${response.status} ${text}`));
    return;
  }
  const shell = await fetch(baseUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const html = await shell.text();
  if (!shell.ok || !html.includes('<div id="root"></div>')) {
    finish(new Error(`Web Shell check failed: ${shell.status}`));
    return;
  }
  console.log(`Bundled daemon and Web Shell ready at ${baseUrl}`);
  finish();
}

function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  child.kill('SIGTERM');
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
