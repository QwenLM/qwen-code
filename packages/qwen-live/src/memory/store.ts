/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryLogger } from './config.js';
import { liveText, type LiveMessageKey } from '../i18n/messages.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { indexText } from './tokenize.js';

export type MemoryKind = 'dialogue' | 'env';

export interface MemoryLibrary {
  version: number;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryLibrarySummary extends MemoryLibrary {
  n_segments?: number;
  n_sessions?: number;
  n_sessions_inactive?: number;
}

export interface StoredVector {
  refId: number;
  vector: Float32Array;
}

export class MemoryStoreError extends Error {
  constructor(readonly messageKey: LiveMessageKey) {
    super(liveText('en', messageKey));
  }
}
export class MemoryLibraryNotFound extends MemoryStoreError {}
export class MemoryValidationError extends MemoryStoreError {}

export function validateLibraryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)
  ) {
    throw new MemoryValidationError('memoryUI.id');
  }
  return value;
}

export function normalizeLibraryName(value: unknown): string {
  if (typeof value !== 'string')
    throw new MemoryValidationError('memoryUI.nameText');
  const name = value.trim();
  if (!name || [...name].length > 80 || /\p{C}/u.test(name)) {
    throw new MemoryValidationError('memoryUI.name');
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRegularFile(path: string): void {
  if (!lstatSync(path).isFile())
    throw new MemoryValidationError('memoryUI.file');
}

export class MemoryStore {
  readonly directory: string;
  readonly defaultId: string;
  readonly log: MemoryLogger;
  private readonly connections = new Map<string, DatabaseSync>();
  private closed = false;

  constructor(options: {
    directory: string;
    defaultId: string;
    log?: MemoryLogger;
  }) {
    this.defaultId = validateLibraryId(options.defaultId);
    this.log = options.log ?? (() => {});
    const directory = options.directory.startsWith('~/')
      ? join(homedir(), options.directory.slice(2))
      : resolve(options.directory);
    this.directory = existsSync(directory)
      ? realpathSync(directory)
      : directory;
  }

  private libraryDirectory(id: string): string {
    return join(this.directory, validateLibraryId(id));
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryStoreError('memoryUI.storeClosed');
  }

  private assertLibraryDirectory(id: string): string {
    const directory = this.libraryDirectory(id);
    if (!existsSync(directory))
      throw new MemoryLibraryNotFound('memoryUI.missing');
    if (!lstatSync(directory).isDirectory())
      throw new MemoryValidationError('memoryUI.directory');
    return directory;
  }

  exists(id: string): boolean {
    try {
      this.getLibrary(id);
      return true;
    } catch (error) {
      if (
        error instanceof MemoryLibraryNotFound ||
        error instanceof MemoryValidationError
      )
        return false;
      throw error;
    }
  }

  ensureDefault(): MemoryLibrary {
    return this.ensureLibrary(this.defaultId);
  }

  ensureLibrary(id: string): MemoryLibrary {
    this.assertOpen();
    try {
      return this.getLibrary(id);
    } catch (error) {
      if (!(error instanceof MemoryLibraryNotFound)) throw error;
      return this.createLibrary(
        id === this.defaultId ? 'Default Memory' : 'Memory',
        id,
      );
    }
  }

  getLibrary(id: string): MemoryLibrary {
    this.assertOpen();
    const path = join(this.assertLibraryDirectory(id), 'meta.json');
    if (!existsSync(path))
      throw new MemoryLibraryNotFound('memoryUI.metaMissing');
    requireRegularFile(path);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new MemoryStoreError('memoryUI.metaUnreadable');
    }
    if (
      !isRecord(data) ||
      data['version'] !== 1 ||
      data['id'] !== id ||
      typeof data['created_at'] !== 'string' ||
      typeof data['updated_at'] !== 'string'
    ) {
      throw new MemoryValidationError('memoryUI.metaInvalid');
    }
    return {
      version: 1,
      id,
      name: normalizeLibraryName(data['name']),
      created_at: data['created_at'],
      updated_at: data['updated_at'],
    };
  }

  createLibrary(name: unknown = 'New Memory', id?: string): MemoryLibrary {
    this.assertOpen();
    const selectedId = validateLibraryId(
      id ?? `lib_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
    );
    const selectedName = normalizeLibraryName(name);
    const directory = this.libraryDirectory(selectedId);
    if (existsSync(directory)) throw new MemoryStoreError('memoryUI.exists');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    mkdirSync(directory, { mode: 0o700 });
    const now = new Date().toISOString();
    const library = {
      version: 1,
      id: selectedId,
      name: selectedName,
      created_at: now,
      updated_at: now,
    };
    this.writeMeta(library);
    this.database(selectedId);
    return library;
  }

  renameLibrary(id: string, name: unknown): MemoryLibrary {
    const library = this.getLibrary(id);
    library.name = normalizeLibraryName(name);
    library.updated_at = new Date().toISOString();
    this.writeMeta(library);
    return library;
  }

  touchLibrary(id: string): void {
    const library = this.getLibrary(id);
    library.updated_at = new Date().toISOString();
    this.writeMeta(library);
  }

  private writeMeta(library: MemoryLibrary): void {
    const directory = this.assertLibraryDirectory(library.id);
    const temporary = join(directory, `.meta.${randomUUID()}.tmp`);
    let descriptor: number | undefined = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify(library, null, 2)}\n`,
        'utf8',
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, join(directory, 'meta.json'));
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  listLibraries(): MemoryLibrarySummary[] {
    this.assertOpen();
    const libraries: MemoryLibrarySummary[] = [];
    if (!existsSync(this.directory)) return libraries;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(entry.name)
      )
        continue;
      try {
        const library = this.getLibrary(entry.name);
        const counters = this.connections
          .get(entry.name)
          ?.prepare(
            'SELECT (SELECT COUNT(*) FROM dialogue_segments) AS n_segments,' +
              ' (SELECT COUNT(*) FROM library_sessions) AS n_sessions,' +
              ' (SELECT COUNT(*) FROM library_sessions WHERE active = 0) AS n_sessions_inactive',
          )
          .get();
        libraries.push(
          counters
            ? {
                ...library,
                n_segments: Number(counters['n_segments']),
                n_sessions: Number(counters['n_sessions']),
                n_sessions_inactive: Number(counters['n_sessions_inactive']),
              }
            : library,
        );
      } catch {
        this.log('memory.store.library_unreadable', { libraryId: entry.name });
      }
    }
    return libraries.sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        right.id.localeCompare(left.id),
    );
  }

  database(id: string): DatabaseSync {
    this.assertOpen();
    validateLibraryId(id);
    const cached = this.connections.get(id);
    if (cached) return cached;
    this.getLibrary(id);
    const path = join(this.assertLibraryDirectory(id), 'dialogue.db');
    if (existsSync(path)) requireRegularFile(path);
    const database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;',
      );
      const hasMeta = database
        .prepare("SELECT 1 FROM sqlite_master WHERE name='schema_meta'")
        .get();
      const version = hasMeta
        ? Number(
            database
              .prepare("SELECT v FROM schema_meta WHERE k='version'")
              .get()?.['v'] ?? 0,
          )
        : 0;
      if (
        !Number.isInteger(version) ||
        version < 0 ||
        version > SCHEMA_VERSION
      ) {
        throw new MemoryStoreError('memoryUI.schema');
      }
      if (version < SCHEMA_VERSION) {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(SCHEMA_SQL);
          database
            .prepare(
              "INSERT OR REPLACE INTO schema_meta(k,v) VALUES('version',?)",
            )
            .run(String(SCHEMA_VERSION));
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
      this.connections.set(id, database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  listLibrarySessions(id: string): Array<Record<string, unknown>> {
    return this.database(id)
      .prepare(
        'SELECT * FROM library_sessions ORDER BY last_seen_at DESC, session_id',
      )
      .all();
  }

  deactivateSession(
    id: string,
    sessionId: string,
    reason = 'session_deleted',
  ): boolean {
    const database = this.database(id);
    const session = database
      .prepare('SELECT active FROM library_sessions WHERE session_id=?')
      .get(sessionId);
    if (!session || !Number(session['active'])) return false;
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          'DELETE FROM dialogue_fts WHERE seg_id IN (SELECT id FROM dialogue_segments WHERE session_id=?)',
        )
        .run(sessionId);
      database
        .prepare(
          'DELETE FROM env_fts WHERE env_id IN (SELECT id FROM stm_env WHERE src_session=?)',
        )
        .run(sessionId);
      database
        .prepare(
          'UPDATE stm_env SET active=0,expired_at=? WHERE src_session=? AND active=1',
        )
        .run(new Date().toISOString().slice(0, 10), sessionId);
      database
        .prepare(
          'UPDATE library_sessions SET active=0,deactivated_at=?,deactivate_reason=? WHERE session_id=?',
        )
        .run(new Date().toISOString(), reason, sessionId);
      database.exec('COMMIT');
      return true;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  deactivateSessionEverywhere(sessionId: string): string[] {
    return this.listLibraries()
      .filter((library) => this.deactivateSession(library.id, sessionId))
      .map((library) => library.id);
  }

  reactivateSession(id: string, sessionId: string): boolean {
    const database = this.database(id);
    const session = database
      .prepare('SELECT active FROM library_sessions WHERE session_id=?')
      .get(sessionId);
    if (!session || Number(session['active'])) return false;
    database.exec('BEGIN IMMEDIATE');
    try {
      const segments = database
        .prepare('SELECT id,body FROM dialogue_segments WHERE session_id=?')
        .all(sessionId);
      for (const row of segments) {
        database
          .prepare('DELETE FROM dialogue_fts WHERE seg_id=?')
          .run(row['id']!);
        database
          .prepare('INSERT INTO dialogue_fts(index_text,seg_id) VALUES(?,?)')
          .run(indexText(row['body']), row['id']!);
      }
      // Restore observations only when their retirement coincides with this
      // session's deactivation, not independently expired observations.
      const stamp = database
        .prepare(
          'SELECT substr(deactivated_at,1,10) AS day FROM library_sessions WHERE session_id=?',
        )
        .get(sessionId)?.['day'];
      const observations = database
        .prepare(
          'SELECT id,content FROM stm_env WHERE src_session=? AND active=0 AND expired_at=?',
        )
        .all(sessionId, stamp ?? null);
      for (const row of observations) {
        database.prepare('DELETE FROM env_fts WHERE env_id=?').run(row['id']!);
        database
          .prepare('INSERT INTO env_fts(index_text,env_id) VALUES(?,?)')
          .run(indexText(row['content']), row['id']!);
        database
          .prepare('UPDATE stm_env SET active=1,expired_at=NULL WHERE id=?')
          .run(row['id']!);
      }
      database
        .prepare(
          'UPDATE library_sessions SET active=1,deactivated_at=NULL,deactivate_reason=NULL WHERE session_id=?',
        )
        .run(sessionId);
      database.exec('COMMIT');
      return true;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  writeVector(
    id: string,
    kind: MemoryKind,
    refId: number,
    vector: ArrayLike<number>,
    model: string,
  ): boolean {
    const database = this.database(id);
    const owner =
      kind === 'dialogue'
        ? database
            .prepare(
              'SELECT 1 FROM dialogue_segments s LEFT JOIN library_sessions l ON l.session_id=s.session_id WHERE s.id=? AND COALESCE(l.active,1)=1',
            )
            .get(refId)
        : database
            .prepare(
              'SELECT 1 FROM stm_env e LEFT JOIN library_sessions l ON l.session_id=e.src_session WHERE e.id=? AND e.active=1 AND COALESCE(l.active,1)=1',
            )
            .get(refId);
    if (!owner || vector.length < 1 || vector.length > 65536) return false;
    const blob = Buffer.alloc(vector.length * 4);
    let norm = 0;
    for (let index = 0; index < vector.length; index++) {
      const value = vector[index]!;
      if (!Number.isFinite(value)) return false;
      norm += value * value;
    }
    if (!Number.isFinite(norm) || norm <= 0) return false;
    norm = Math.sqrt(norm);
    for (let index = 0; index < vector.length; index++)
      blob.writeFloatLE(vector[index]! / norm, index * 4);
    database
      .prepare(
        'INSERT INTO embeddings(kind,ref_id,dim,model,vec,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,ref_id) DO UPDATE SET dim=excluded.dim,model=excluded.model,vec=excluded.vec,created_at=excluded.created_at',
      )
      .run(kind, refId, vector.length, model, blob, new Date().toISOString());
    return true;
  }

  vectorRows(id: string, kind: MemoryKind, model: string): StoredVector[] {
    const rows = this.database(id)
      .prepare(
        'SELECT ref_id,dim,vec FROM embeddings WHERE kind=? AND model=? ORDER BY ref_id',
      )
      .all(kind, model);
    const vectors: StoredVector[] = [];
    for (const row of rows) {
      const dimension = Number(row['dim']);
      const bytes = row['vec'];
      if (
        !Number.isInteger(dimension) ||
        dimension < 1 ||
        dimension > 65536 ||
        !(bytes instanceof Uint8Array) ||
        bytes.length !== dimension * 4
      )
        continue;
      const blob = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const vector = new Float32Array(dimension);
      let valid = true;
      for (let index = 0; index < dimension; index++) {
        vector[index] = blob.readFloatLE(index * 4);
        if (!Number.isFinite(vector[index])) valid = false;
      }
      if (valid) vectors.push({ refId: Number(row['ref_id']), vector });
    }
    return vectors;
  }

  missingVectorSegments(
    id: string,
    model: string,
    limit = 500,
  ): Array<{ id: number; body: string }> {
    return this.database(id)
      .prepare(
        "SELECT s.id,s.body FROM dialogue_segments s LEFT JOIN embeddings e ON e.kind='dialogue' AND e.ref_id=s.id AND e.model=? LEFT JOIN library_sessions l ON l.session_id=s.session_id WHERE e.ref_id IS NULL AND COALESCE(l.active,1)=1 ORDER BY s.id LIMIT ?",
      )
      .all(model, Math.max(1, Math.min(4096, Math.floor(limit))))
      .map((row) => ({ id: Number(row['id']), body: String(row['body']) }));
  }

  lastConsolidation(id: string): Record<string, unknown> | null {
    const row = this.database(id)
      .prepare(
        'SELECT session_id,created_at,status,attempts,report_json,detail FROM updater_log ORDER BY created_at DESC,session_id DESC LIMIT 1',
      )
      .get();
    if (!row) return null;
    let report: unknown = null;
    try {
      report = JSON.parse(String(row['report_json'] ?? 'null'));
    } catch {
      /* A damaged audit row does not block reading the library. */
    }
    return {
      session_id: row['session_id'],
      at: row['created_at'],
      status: row['status'],
      attempts: Number(row['attempts']),
      detail: row['detail'] ?? '',
      report,
    };
  }

  close(): void {
    this.closed = true;
    const errors: unknown[] = [];
    for (const [id, database] of this.connections) {
      try {
        database.close();
        this.connections.delete(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Memory database close failed.');
  }
}
