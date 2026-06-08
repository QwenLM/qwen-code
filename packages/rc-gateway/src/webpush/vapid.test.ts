/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { VapidStore } from './vapid.js';

const ENV_KEY = 'QWEN_RC_WEBPUSH_SUBJECT';
let savedSubject: string | undefined;

afterEach(() => {
  if (savedSubject === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedSubject;
});

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-vapid-')), 'vapid.json');
}

describe('VapidStore', () => {
  it('generates and persists a keypair with mode 0600', async () => {
    const path = tempPath();
    const store = await VapidStore.open(path);

    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const pub = store.getApplicationServerKey();
    expect(pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pub.length).toBeGreaterThan(0);
    expect(store.getKeys().privateKey.length).toBeGreaterThan(0);
  });

  it('reuses the same keypair on a second open (no regeneration)', async () => {
    const path = tempPath();
    const first = await VapidStore.open(path);
    const second = await VapidStore.open(path);
    expect(second.getApplicationServerKey()).toBe(
      first.getApplicationServerKey(),
    );
    expect(second.getKeys().privateKey).toBe(first.getKeys().privateKey);
  });

  it('regenerates when the file is corrupt', async () => {
    const path = tempPath();
    await VapidStore.open(path);
    writeFileSync(path, 'not json');
    const store = await VapidStore.open(path);
    expect(store.getApplicationServerKey()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.getKeys().privateKey.length).toBeGreaterThan(0);
  });

  it('honors the env subject and falls back to mailto:noreply@<hostname>', async () => {
    savedSubject = process.env[ENV_KEY];

    process.env[ENV_KEY] = 'mailto:ops@example.com';
    const withEnv = await VapidStore.open(tempPath());
    expect(withEnv.getSubject()).toBe('mailto:ops@example.com');

    delete process.env[ENV_KEY];
    const fallback = await VapidStore.open(tempPath());
    expect(fallback.getSubject()).toBe(`mailto:noreply@${hostname()}`);
  });
});
