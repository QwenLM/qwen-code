/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drive a built `qwen serve` daemon through a fixed scenario set and capture
 * each endpoint's JSON response to `<outDir>/<scenario>.json`. Run once against
 * the PR-base build and once against the PR-head build; serve-ab-diff.mjs then
 * diffs the two capture dirs per scenario.
 *
 * Deterministic + credential-free: `/health` needs no auth; `/capabilities`
 * uses the local `--token`. No model is contacted (dummy OpenAI creds), so the
 * responses are stable and safe to diff. Scenarios that mutate state (create a
 * session, etc.) can be added here later — mask their volatile fields in
 * serve-ab-diff.mjs.
 *
 *   node serve-ab-drive.mjs <cliEntry> <outDir>
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The fixed scenarios. `auth` sends the bearer token; anything mutating the
// daemon would push requests here in order.
export const SCENARIOS = [
  { name: 'health', method: 'GET', path: '/health', auth: false },
  { name: 'health-deep', method: 'GET', path: '/health?deep=1', auth: false },
  { name: 'capabilities', method: 'GET', path: '/capabilities', auth: true },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}

export async function driveCli(cliEntry, outDir) {
  mkdirSync(outDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'serve-ab-home-'));
  const token = 'serve-ab-token';
  const port = await freePort();
  const daemon = spawn(
    'node',
    [
      cliEntry,
      'serve',
      '--port',
      String(port),
      '--token',
      token,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      home,
    ],
    {
      // No real model: dummy OpenAI creds so session auth never contacts a
      // backend. HOME/QWEN_HOME isolate any on-disk state per run.
      env: {
        ...process.env,
        HOME: home,
        QWEN_HOME: join(home, '.qwen'),
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
    for (const s of SCENARIOS) {
      const headers = s.auth ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${base}${s.path}`, {
        method: s.method,
        headers,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { _status: res.status, _nonJson: text.slice(0, 500) };
      }
      writeFileSync(
        join(outDir, `${s.name}.json`),
        JSON.stringify(json, null, 2) + '\n',
      );
      process.stderr.write(`  captured ${s.name} (HTTP ${res.status})\n`);
    }
  } finally {
    daemon.kill('SIGTERM');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cliEntry, outDir] = process.argv.slice(2);
  if (!cliEntry || !outDir) {
    process.stderr.write('usage: serve-ab-drive.mjs <cliEntry> <outDir>\n');
    process.exit(2);
  }
  driveCli(cliEntry, outDir).catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
