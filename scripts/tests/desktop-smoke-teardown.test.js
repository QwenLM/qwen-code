/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const smokeScript = path.join(
  repoRoot,
  'packages',
  'desktop-shell',
  'scripts',
  'smoke-packaged.js',
);

// A packaged-app stand-in that passes the smoke's real assertions (readiness
// line, unauthenticated shell boundary, token-gated API) and then behaves like
// the CI failure mode: it ignores SIGTERM and keeps writing under $HOME while
// it "drains", so teardown races a live writer.
const FAKE_APP = `#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const home = process.env.HOME;
const debugDir = path.join(home, '.qwen', 'debug', 'daemon');
fs.mkdirSync(debugDir, { recursive: true });
const server = http.createServer((req, res) => {
  if (req.url === '/' && (req.headers['sec-fetch-mode'] === 'navigate' || (req.headers['accept'] || '').includes('text/html'))) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>shell</title>');
    return;
  }
  res.writeHead(401);
  res.end('unauthorized');
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const logRoot =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', 'com.alibaba.qwen-code')
      : path.join(process.env.XDG_STATE_HOME || home, 'com.alibaba.qwen-code', 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  fs.appendFileSync(path.join(logRoot, 'desktop-runtime.log'),
    \`qwen serve listening on http://127.0.0.1:\${port}\\n\`);
});
process.on('SIGTERM', () => {});
setInterval(() => {
  try {
    fs.appendFileSync(path.join(debugDir, 'trace.log'), Date.now() + '\\n');
  } catch {}
}, 100).unref();
setInterval(() => {}, 1 << 30);
`;

let fixtureRoot;
let fakeApp;

function workspaces() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('qwen-desktop-smoke-'));
}

function runSmoke(executable) {
  const before = new Set(workspaces());
  const result = spawnSync(process.execPath, [smokeScript, executable], {
    encoding: 'utf8',
    env: { ...process.env, QWEN_CODE_COMMIT: 'smoke-test-commit' },
    timeout: 60_000,
  });
  return {
    ...result,
    created: workspaces().filter((name) => !before.has(name)),
  };
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fixture-'));
  const binDir = path.join(fixtureRoot, 'bin');
  fs.mkdirSync(binDir);
  fakeApp = path.join(binDir, 'fake-app.js');
  fs.writeFileSync(fakeApp, FAKE_APP);
  fs.chmodSync(fakeApp, 0o755);
  const manifestDir = path.join(
    fixtureRoot,
    'Resources',
    'runtime',
    'qwen-code',
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'manifest.json'),
    JSON.stringify({ qwenCodeCommit: 'smoke-test-commit' }),
  );
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('smoke-packaged teardown', () => {
  it('passes and removes its workspace when the app outlives readiness', () => {
    const result = runSmoke(fakeApp);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Packaged desktop runtime ready');
    for (const name of result.created) {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
    expect(result.created).toEqual([]);
  });

  it('keeps the workspace for debugging when the app dies before readiness', () => {
    const deadApp = path.join(fixtureRoot, 'bin', 'fake-dead.js');
    fs.writeFileSync(deadApp, '#!/usr/bin/env node\nprocess.exit(3);\n');
    fs.chmodSync(deadApp, 0o755);
    const result = runSmoke(deadApp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exited before readiness');
    expect(result.created.length).toBe(1);
    expect(result.stderr).toContain(
      `Smoke workspace: ${path.join(os.tmpdir(), result.created[0])}`,
    );
    fs.rmSync(path.join(os.tmpdir(), result.created[0]), {
      recursive: true,
      force: true,
    });
  });
});

describe('smoke-packaged startup failures', () => {
  it('reports a non-executable binary as a failed start, not a crash', () => {
    const noExec = path.join(fixtureRoot, 'bin', 'fake-noexec.js');
    fs.writeFileSync(noExec, '#!/usr/bin/env node\n');
    const result = runSmoke(noExec);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed to start');
    for (const name of result.created) {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  });
});
