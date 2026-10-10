/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLibraryNotFound,
  MemoryStore,
  MemoryValidationError,
  normalizeLibraryName,
  validateLibraryId,
} from './store.js';
import { indexText } from './tokenize.js';

describe('MemoryStore', () => {
  let temporary: string;
  let store: MemoryStore;
  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'qwen-live-memory-store-'));
    store = new MemoryStore({
      directory: join(temporary, 'memories'),
      defaultId: 'default',
    });
  });
  afterEach(() => {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('does not create directories or databases just to show disabled settings', () => {
    expect(store.listLibraries()).toEqual([]);
    expect(existsSync(store.directory)).toBe(false);
    expect(() => store.getLibrary('missing')).toThrow(MemoryLibraryNotFound);
    expect(existsSync(store.directory)).toBe(false);
  });

  it('retains only failed database handles for close retry while refusing new work', () => {
    store.ensureDefault();
    const other = store.createLibrary('Other');
    const database = store.database('default');
    const otherDatabase = store.database(other.id);
    const close = vi.spyOn(database, 'close').mockImplementationOnce(() => {
      throw new Error('Database is busy');
    });
    const closeOther = vi.spyOn(otherDatabase, 'close');
    expect(() => store.close()).toThrow('Memory database close failed.');
    expect(close).toHaveBeenCalledOnce();
    expect(closeOther).toHaveBeenCalledOnce();
    expect(() => store.database('default')).toThrow('closed');
    expect(() => store.close()).not.toThrow();
    store.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(closeOther).toHaveBeenCalledOnce();
  });

  it('keeps identity stable on rename and persists private prototype metadata', () => {
    const library = store.ensureDefault();
    const renamed = store.renameLibrary(library.id, '  工作记忆  ');
    expect(renamed.name).toBe('工作记忆');
    expect(renamed.id).toBe('default');
    expect(renamed.created_at).toBe(library.created_at);
    const directory = join(store.directory, 'default');
    expect(
      JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')),
    ).toEqual(renamed);
    expect(existsSync(join(directory, 'dialogue.db'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, 'meta.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, 'dialogue.db')).mode & 0o777).toBe(0o600);
    }
    expect(store.ensureDefault()).toEqual(renamed);
  });

  it('creates safe independent libraries and rejects duplicate identities', () => {
    const first = store.createLibrary('Work');
    const second = store.createLibrary('Life');
    expect(first.id).not.toBe(second.id);
    expect(validateLibraryId(first.id)).toBe(first.id);
    expect(
      store
        .listLibraries()
        .map((library) => library.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    expect(() => store.createLibrary('Duplicate', first.id)).toThrow(
      /already exists/u,
    );
    expect(() => store.renameLibrary('missing', 'New')).toThrow(
      MemoryLibraryNotFound,
    );
  });

  it('reads metadata without opening all SQLite files', () => {
    store.ensureDefault();
    store.close();
    store = new MemoryStore({
      directory: join(temporary, 'memories'),
      defaultId: 'default',
    });
    const database = vi.spyOn(store, 'database');
    expect(store.listLibraries()).toEqual([
      expect.objectContaining({ id: 'default', name: 'Default Memory' }),
    ]);
    expect(database).not.toHaveBeenCalled();
    expect(store.listLibraries()[0]).not.toHaveProperty('n_segments');
  });

  it('creates every table and original column needed by prototype v1 libraries', () => {
    store.ensureDefault();
    const database = store.database('default');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row['name']);
    expect(tables).toEqual(
      expect.arrayContaining([
        'library_sessions',
        'turns',
        'dialogue_segments',
        'dialogue_fts',
        'embeddings',
        'schema_meta',
        'wm_snapshots',
        'ltm_entries',
        'stm_items',
        'preload_log',
        'stm_env',
        'env_fts',
        'updater_log',
      ]),
    );
    expect(
      database.prepare("SELECT v FROM schema_meta WHERE k='version'").get()?.[
        'v'
      ],
    ).toBe('1');
    expect(
      database
        .prepare('PRAGMA table_info(stm_items)')
        .all()
        .map((row) => row['name']),
    ).toEqual([
      'id',
      'content',
      'status',
      'created_at',
      'created_ts',
      'event_date',
      'expires_at',
      'src_session',
      'active',
      'expired_at',
    ]);
    expect(
      database
        .prepare('PRAGMA table_info(wm_snapshots)')
        .all()
        .map((row) => row['name']),
    ).toEqual([
      'id',
      'session_id',
      'seq',
      'wm_json',
      'ops_json',
      'applied_json',
      'created_at',
    ]);
  });

  it('reopens v1 data without replaying the schema or changing stored values', () => {
    store.ensureDefault();
    store
      .database('default')
      .exec(
        "INSERT INTO ltm_entries(field,content,created_at,updated_at) VALUES('name','Ada','2026-01-01','2026-01-01'); CREATE TABLE existing_extension(value TEXT)",
      );
    store.close();
    store = new MemoryStore({
      directory: join(temporary, 'memories'),
      defaultId: 'default',
    });
    expect(
      store
        .database('default')
        .prepare('SELECT content FROM ltm_entries')
        .get()?.['content'],
    ).toBe('Ada');
    expect(
      store
        .database('default')
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='existing_extension'",
        )
        .get(),
    ).toBeDefined();
  });

  it('refuses future schemas instead of silently writing incompatible data', () => {
    store.ensureDefault();
    store
      .database('default')
      .exec("UPDATE schema_meta SET v='999' WHERE k='version'");
    store.close();
    store = new MemoryStore({
      directory: join(temporary, 'memories'),
      defaultId: 'default',
    });
    expect(() => store.database('default')).toThrow(/schema version/u);
  });

  it('rejects symbolic-link library and database targets', () => {
    if (process.platform === 'win32') return;
    const outside = join(temporary, 'outside');
    mkdirSync(outside);
    mkdirSync(store.directory);
    symlinkSync(outside, join(store.directory, 'alias'));
    expect(() => store.getLibrary('alias')).toThrow(MemoryValidationError);
    expect(store.listLibraries()).toEqual([]);
    store.ensureDefault();
    store.close();
    const path = join(store.directory, 'default', 'dialogue.db');
    rmSync(path);
    writeFileSync(join(outside, 'data'), 'outside');
    symlinkSync(join(outside, 'data'), path);
    store = new MemoryStore({
      directory: join(temporary, 'memories'),
      defaultId: 'default',
    });
    expect(() => store.database('default')).toThrow(MemoryValidationError);
    expect(readFileSync(join(outside, 'data'), 'utf8')).toBe('outside');
  });

  function seed(
    id: string,
    sessionId: string,
    text = '辣椒要保持三十厘米间距',
  ): number {
    store.ensureLibrary(id);
    const database = store.database(id);
    database
      .prepare(
        'INSERT INTO library_sessions(session_id,first_seen_at,last_seen_at) VALUES(?,?,?)',
      )
      .run(sessionId, '2026-09-05', '2026-09-05');
    const result = database
      .prepare(
        'INSERT INTO dialogue_segments(session_id,turn_from,turn_to,n_turns,start_ts,end_ts,start_epoch,end_epoch,body,cut_reason,n_chars) VALUES(?,0,0,1,?,?,1,2,?,?,?)',
      )
      .run(
        sessionId,
        '2026-09-05',
        '2026-09-05',
        text,
        'session_end',
        text.length,
      );
    const segmentId = Number(result.lastInsertRowid);
    database
      .prepare('INSERT INTO dialogue_fts(index_text,seg_id) VALUES(?,?)')
      .run(indexText(text), segmentId);
    return segmentId;
  }

  it('deactivates all selected libraries without deleting transcripts', () => {
    seed('default', 'session');
    seed('work', 'session');
    seed('default', 'another');
    expect(store.deactivateSessionEverywhere('session').sort()).toEqual([
      'default',
      'work',
    ]);
    expect(
      store
        .database('default')
        .prepare('SELECT COUNT(*) AS n FROM dialogue_segments')
        .get()?.['n'],
    ).toBe(2);
    expect(
      store
        .database('default')
        .prepare('SELECT COUNT(*) AS n FROM dialogue_fts')
        .get()?.['n'],
    ).toBe(1);
    expect(store.deactivateSession('default', 'session')).toBe(false);
    expect(store.reactivateSession('default', 'session')).toBe(true);
    expect(
      store
        .database('default')
        .prepare('SELECT COUNT(*) AS n FROM dialogue_fts')
        .get()?.['n'],
    ).toBe(2);
  });

  it('keeps vectors isolated by library, source and model with little-endian float32 blobs', () => {
    const first = seed('default', 'first');
    const second = seed('work', 'second');
    expect(
      store.writeVector('default', 'dialogue', first, [3, 4], 'embedding-a'),
    ).toBe(true);
    expect(
      store.writeVector('work', 'dialogue', second, [0, 2], 'embedding-a'),
    ).toBe(true);
    expect(store.vectorRows('default', 'dialogue', 'embedding-b')).toEqual([]);
    expect(store.vectorRows('default', 'env', 'embedding-a')).toEqual([]);
    expect(
      store.vectorRows('default', 'dialogue', 'embedding-a')[0]?.vector[0],
    ).toBeCloseTo(0.6);
    expect(
      store.vectorRows('work', 'dialogue', 'embedding-a')[0]?.vector[0],
    ).toBe(0);
    const blob = store
      .database('default')
      .prepare('SELECT vec FROM embeddings')
      .get()?.['vec'];
    expect(Buffer.from(blob as Uint8Array).readFloatLE(4)).toBeCloseTo(0.8);
    expect(store.missingVectorSegments('default', 'embedding-a')).toEqual([]);
    expect(store.missingVectorSegments('default', 'embedding-b')).toEqual([
      { id: first, body: '辣椒要保持三十厘米间距' },
    ]);
    store.deactivateSession('default', 'first');
    expect(
      store.writeVector('default', 'dialogue', first, [1, 0], 'embedding-b'),
    ).toBe(false);
    expect(store.missingVectorSegments('default', 'embedding-b')).toEqual([]);
  });

  it('does not reopen after shutdown', () => {
    store.ensureDefault();
    store.close();
    expect(() => store.database('default')).toThrow(/closed/u);
    expect(() => store.createLibrary('Later')).toThrow(/closed/u);
    store.close();
  });
});

describe('memory identity validation', () => {
  it.each([
    '..',
    '../outside',
    'a/b',
    'a\\b',
    '.hidden',
    '-dash',
    '',
    '名字',
    'a'.repeat(65),
  ])('rejects unsafe id %s', (id) => {
    expect(() => validateLibraryId(id)).toThrow(MemoryValidationError);
  });
  it('counts Unicode characters and accepts names independent of path restrictions', () => {
    expect(normalizeLibraryName(' 😀 Work / Life ')).toBe('😀 Work / Life');
    expect(normalizeLibraryName('😀'.repeat(80))).toHaveLength(160);
    for (const name of [
      '',
      ' '.repeat(3),
      'x'.repeat(81),
      'a\u0000b',
      'a\u202Eb',
    ])
      expect(() => normalizeLibraryName(name)).toThrow(MemoryValidationError);
  });
});
