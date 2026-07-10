/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { VapidStore, CREDENTIAL_REDACT_RE } from './vapid.js';

const ENV_KEY = 'QWEN_RC_WEBPUSH_SUBJECT';
let savedSubject: string | undefined;

afterEach(() => {
  if (savedSubject === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedSubject;
});

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-vapid-')), 'vapid.pem');
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

  it('persists the key in PEM format (SEC1)', async () => {
    const path = tempPath();
    await VapidStore.open(path);
    const raw = readFileSync(path, 'utf8');
    expect(raw.trim()).toMatch(/^-----BEGIN EC PRIVATE KEY-----/);
    expect(raw.trim()).toMatch(/-----END EC PRIVATE KEY-----$/);
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
    writeFileSync(path, 'not valid pem');
    const store = await VapidStore.open(path);
    expect(store.getApplicationServerKey()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.getKeys().privateKey.length).toBeGreaterThan(0);
  });

  it('migrates legacy JSON format to PEM on first open', async () => {
    const path = tempPath();
    // Generate a real keypair first, then write it as legacy JSON format
    const store1 = await VapidStore.open(path);
    const realKeys = store1.getKeys();
    writeFileSync(
      path,
      JSON.stringify({
        publicKey: realKeys.publicKey,
        privateKey: realKeys.privateKey,
      }),
    );
    // Open again — should migrate JSON → PEM
    const store2 = await VapidStore.open(path);
    expect(store2.getApplicationServerKey()).toBe(realKeys.publicKey);
    // Now the file should be PEM
    const raw = readFileSync(path, 'utf8');
    expect(raw.trim()).toMatch(/^-----BEGIN EC PRIVATE KEY-----/);
  });

  it('rotate() generates new keys and fires the onRotated callback', async () => {
    const path = tempPath();
    const store = await VapidStore.open(path);
    const oldPub = store.getApplicationServerKey();

    let rotatedNew: string | undefined;
    let rotatedOld: string | undefined;
    const newPub = await store.rotate({
      onRotated: (np, op) => {
        rotatedNew = np;
        rotatedOld = op;
      },
    });

    expect(newPub).not.toBe(oldPub);
    expect(rotatedNew).toBe(newPub);
    expect(rotatedOld).toBe(oldPub);
    expect(store.getApplicationServerKey()).toBe(newPub);
  });

  it('rotate() persists new keys in PEM format at mode 0600', async () => {
    const path = tempPath();
    const store = await VapidStore.open(path);
    await store.rotate();

    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const raw = readFileSync(path, 'utf8');
    expect(raw.trim()).toMatch(/^-----BEGIN EC PRIVATE KEY-----/);
  });

  it('rotate() new keypair survives a re-open', async () => {
    const path = tempPath();
    const store = await VapidStore.open(path);
    const newPub = await store.rotate();

    const reopened = await VapidStore.open(path);
    expect(reopened.getApplicationServerKey()).toBe(newPub);
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

describe('CREDENTIAL_REDACT_RE', () => {
  it('matches common credential key patterns', () => {
    const cases = [
      'api_key=sk-live-abc123',
      'apiKey=sk-live-abc123',
      'api-key=sk-live-abc123',
      'private_key=SUPERSECRET',
      'privateKey=SUPERSECRET',
      'secret=mysecret',
      'password=hunter2',
      'auth=Bearer_token_xyz',
      'credential=abc',
      'token=jwt123',
    ];
    for (const c of cases) {
      CREDENTIAL_REDACT_RE.lastIndex = 0;
      expect(CREDENTIAL_REDACT_RE.test(c), `expected match: ${c}`).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    CREDENTIAL_REDACT_RE.lastIndex = 0;
    expect(CREDENTIAL_REDACT_RE.test('API_KEY=abc')).toBe(true);
    CREDENTIAL_REDACT_RE.lastIndex = 0;
    expect(CREDENTIAL_REDACT_RE.test('SECRET=xyz')).toBe(true);
  });

  it('can be used to redact values from a string', () => {
    const input = 'api_key=sk-live-abc123 and password=hunter2';
    const redacted = input.replace(CREDENTIAL_REDACT_RE, (m) => {
      const eqIdx = m.indexOf('=') !== -1 ? m.indexOf('=') : m.indexOf(':');
      return m.slice(0, eqIdx + 1) + '•••';
    });
    expect(redacted).not.toContain('sk-live-abc123');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('api_key=');
    expect(redacted).toContain('password=');
  });
});
