#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const runtimeRoot = path.join(packageDir, 'runtime', 'qwen-code');
const nodePath =
  process.platform === 'win32'
    ? path.join(runtimeRoot, 'node', 'node.exe')
    : path.join(runtimeRoot, 'node', 'bin', 'node');
const entryPath = path.join(runtimeRoot, 'lib', 'cli-entry.js');
const token = crypto.randomBytes(32).toString('hex');

verifyRuntimeIntegrity();

const child = spawn(
  nodePath,
  [
    entryPath,
    'serve',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
    '--require-auth',
    '--workspace',
    packageDir,
    '--no-open',
  ],
  {
    cwd: packageDir,
    env: { ...process.env, QWEN_SERVER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
let done = false;
let verifying = false;
const timeout = setTimeout(
  () => finish(new Error('Timed out waiting for bundled daemon startup')),
  45_000,
);
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  const match = output.match(/qwen serve listening on (http:\/\/[^\s]+)/);
  if (match && !verifying) {
    verifying = true;
    void verify(match[1]).catch(finish);
  }
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
child.on('exit', (code) => {
  if (!done)
    finish(
      new Error(
        `Bundled daemon exited before readiness (code ${code})\n${output}`,
      ),
    );
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
  // The shallow health probe triggers the deferred runtime start. Wait for
  // deep health (served by the runtime app) before asserting the
  // unauthenticated shell, which the delegating app 401s until the runtime
  // is mounted.
  await waitForDeepHealth(baseUrl);
  const shell = await fetch(baseUrl, {
    headers: { Accept: 'text/html' },
  });
  const html = await shell.text();
  if (!shell.ok || !html.includes('<div id="root"></div>')) {
    finish(new Error(`Web Shell check failed: ${shell.status}`));
    return;
  }
  console.log(`Bundled daemon and Web Shell ready at ${baseUrl}`);
  finish();
}

async function waitForDeepHealth(baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/health?deep=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for runtime deep health');
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

function verifyRuntimeIntegrity() {
  const required = [
    'manifest.json',
    'checksums.json',
    'LICENSE',
    'NOTICE',
    'node/LICENSE',
    'lib/cli-entry.js',
    'lib/web-shell/index.html',
  ];
  for (const relative of required) {
    const file = path.join(runtimeRoot, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Bundled runtime file is missing: ${relative}`);
    }
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'manifest.json'), 'utf8'),
  );
  for (const field of [
    'desktopVersion',
    'qwenCodeVersion',
    'qwenCodeCommit',
    'target',
    'node',
    'builtAt',
  ]) {
    if (!manifest[field])
      throw new Error(`Runtime manifest is missing ${field}`);
  }
  const checksums = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'checksums.json'), 'utf8'),
  );
  for (const [relative, expected] of Object.entries(checksums)) {
    const file = path.join(runtimeRoot, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Checksummed runtime file is missing: ${relative}`);
    }
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(`Bundled runtime checksum mismatch: ${relative}`);
    }
  }
}
