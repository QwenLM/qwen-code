/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configureSessionIndexing,
  getSessionIndexMode,
  getSessionIndexStore,
  resetSessionIndexingForTest,
  setSessionIndexDriverForTest,
} from './config.js';
import {
  SESSION_INDEX_DB_FILE,
  sessionIndexDbPath,
  type SqliteDriver,
} from './sqlite.js';

describe('session-index/config', () => {
  let projectDir: string;

  beforeEach(async () => {
    resetSessionIndexingForTest();
    projectDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'session-index-cfg-'),
    );
  });

  afterEach(async () => {
    resetSessionIndexingForTest();
    await fsp.rm(projectDir, { recursive: true, force: true });
  });

  it('defaults to file mode and yields no store', async () => {
    expect(getSessionIndexMode()).toBe('file');
    expect(await getSessionIndexStore(projectDir)).toBeNull();
  });

  it('returns null when the driver is unavailable', async () => {
    configureSessionIndexing({ mode: 'sqlite' });
    setSessionIndexDriverForTest(null);
    expect(await getSessionIndexStore(projectDir)).toBeNull();
  });

  it('opens, memoizes, and closes stores per project directory', async () => {
    let driver: SqliteDriver | undefined;
    try {
      const specifier = 'node:sqlite';
      driver = (await import(specifier)) as unknown as SqliteDriver;
    } catch {
      // runtime without node:sqlite: probing must report unavailable
    }
    configureSessionIndexing({ mode: 'sqlite' });
    if (!driver) {
      setSessionIndexDriverForTest(null);
      expect(await getSessionIndexStore(projectDir)).toBeNull();
      return;
    }
    const first = await getSessionIndexStore(projectDir);
    const second = await getSessionIndexStore(projectDir);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    first!.close();
  });

  it('recovers from a corrupted database instead of throwing', async () => {
    let driver: SqliteDriver | undefined;
    try {
      const specifier = 'node:sqlite';
      driver = (await import(specifier)) as unknown as SqliteDriver;
    } catch {
      // skip on runtimes without node:sqlite
    }
    if (!driver) return;
    configureSessionIndexing({ mode: 'sqlite' });
    await fsp.writeFile(
      sessionIndexDbPath(projectDir),
      'garbage, not sqlite',
      'utf8',
    );
    const store = await getSessionIndexStore(projectDir);
    expect(store).not.toBeNull();
    expect(store!.catalogRows()).toEqual([]);
  });

  it('concurrent first calls share exactly one store construction', async () => {
    let realDriver: SqliteDriver | undefined;
    try {
      const specifier = 'node:sqlite';
      realDriver = (await import(specifier)) as unknown as SqliteDriver;
    } catch {
      // skip on runtimes without node:sqlite
    }
    if (!realDriver) return;
    const Backend = realDriver.DatabaseSync;
    let constructions = 0;
    class CountingDatabase extends Backend {
      constructor(dbPath: string) {
        super(dbPath);
        constructions++;
      }
    }
    configureSessionIndexing({ mode: 'sqlite' });
    setSessionIndexDriverForTest({ DatabaseSync: CountingDatabase });
    const [a, b] = await Promise.all([
      getSessionIndexStore(projectDir),
      getSessionIndexStore(projectDir),
    ]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(constructions).toBe(1);
  });

  it('db file name is stable', () => {
    expect(SESSION_INDEX_DB_FILE).toBe('sessions.index.sqlite');
    expect(sessionIndexDbPath('/p')).toBe(
      path.join('/p', 'sessions.index.sqlite'),
    );
  });
});
