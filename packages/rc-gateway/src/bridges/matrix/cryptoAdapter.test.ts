/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  olmStorePresent,
  shouldWarnOlmMissing,
  setupMatrixCrypto,
  type MatrixCryptoAdapter,
} from './cryptoAdapter.js';
import { olmStoreDir } from './e2ee.js';

describe('olmStorePresent', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-olm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is false when the olm dir does not exist', () => {
    expect(olmStorePresent(dir)).toBe(false);
  });

  it('is false when the olm dir exists but is empty', () => {
    mkdirSync(olmStoreDir(dir), { recursive: true });
    expect(olmStorePresent(dir)).toBe(false);
  });

  it('is true once the olm dir has store files', () => {
    const od = olmStoreDir(dir);
    mkdirSync(od, { recursive: true });
    writeFileSync(join(od, 'matrix-sdk-crypto.sqlite3'), 'x');
    expect(olmStorePresent(dir)).toBe(true);
  });
});

describe('shouldWarnOlmMissing', () => {
  it('warns only when E2EE is enabled AND no store is present', () => {
    expect(
      shouldWarnOlmMissing({ e2eeEnabled: true, olmStorePresent: false }),
    ).toBe(true);
  });

  it('never warns when E2EE is off (no crypto → nothing to re-key)', () => {
    expect(
      shouldWarnOlmMissing({ e2eeEnabled: false, olmStorePresent: false }),
    ).toBe(false);
    expect(
      shouldWarnOlmMissing({ e2eeEnabled: false, olmStorePresent: true }),
    ).toBe(false);
  });

  it('does not warn when a store already exists', () => {
    expect(
      shouldWarnOlmMissing({ e2eeEnabled: true, olmStorePresent: true }),
    ).toBe(false);
  });
});

describe('setupMatrixCrypto (boot safety invariants)', () => {
  const cfg = {
    e2eeEnabled: true,
    homeserverUrl: 'https://hs',
    accessToken: 'tok',
    stateDir: '/tmp/does-not-matter',
  };
  const io = () => {
    const lines: string[] = [];
    return {
      lines,
      log: (m: string) => lines.push(`log:${m}`),
      warn: (m: string) => lines.push(`warn:${m}`),
    };
  };

  it('E2EE OFF → the adapter is NEVER constructed (plain bridge untouched)', async () => {
    let called = false;
    const create = (async () => {
      called = true;
      return null;
    }) as unknown as typeof import('./cryptoAdapter.js').createMatrixCryptoAdapter;
    const r = await setupMatrixCrypto(
      { ...cfg, e2eeEnabled: false },
      io(),
      create,
    );
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('construction failure → degrades to null and does NOT propagate (bridge keeps booting)', async () => {
    const create = (async () => {
      throw new Error('native crypto init failed');
    }) as unknown as typeof import('./cryptoAdapter.js').createMatrixCryptoAdapter;
    const sink = io();
    const r = await setupMatrixCrypto(cfg, sink, create);
    expect(r).toBeNull(); // did not throw
    expect(
      sink.lines.some((l) => l.startsWith('warn:matrix crypto setup failed')),
    ).toBe(true);
  });

  it('adapter constructed → returned, with the honest construction log', async () => {
    const fake: MatrixCryptoAdapter = {
      isReady: () => false,
      joinRoom: async () => ({ ok: true, status: 200 }),
      sendMessage: async () => ({ ok: true, status: 200, eventId: '$e' }),
      start: async () => {},
      stop: async () => {},
    };
    const create = (async () =>
      fake) as unknown as typeof import('./cryptoAdapter.js').createMatrixCryptoAdapter;
    const sink = io();
    const r = await setupMatrixCrypto(cfg, sink, create);
    expect(r).toBe(fake);
    expect(
      sink.lines.some((l) => l.includes('crypto transport constructed')),
    ).toBe(true);
  });
});
