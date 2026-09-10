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
  openSessionIndexStore,
  resetSessionIndexDatabase,
  sessionIndexDbPath,
  SESSION_INDEX_DB_FILE,
  SESSION_INDEX_SCHEMA_VERSION,
  type SqliteDriver,
} from './sqlite.js';
import type { SessionIndexStore } from './types.js';

let driver: SqliteDriver | undefined;
try {
  const specifier = 'node:sqlite';
  driver = (await import(specifier)) as unknown as SqliteDriver;
} catch {
  driver = undefined;
}

const describeWithDriver = driver ? describe : describe.skip;

let root: string;
let projectDir: string;
let chatsDir: string;

function writeRecord(overrides: {
  uuid: string;
  parentUuid?: string | null;
  sessionId: string;
  timestamp?: string;
  type?: string;
  subtype?: string;
  cwd?: string;
  parts?: unknown[];
  systemPayload?: unknown;
  forkedFrom?: string;
  provenance?: string;
}): string {
  const record: Record<string, unknown> = {
    uuid: overrides.uuid,
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    type: overrides.type ?? 'user',
    cwd: overrides.cwd ?? '/tmp/workspace',
    version: '1.0.0',
    message: {
      role: (overrides.type ?? 'user') === 'assistant' ? 'model' : 'user',
      parts: overrides.parts ?? [{ text: `text-${overrides.uuid}` }],
    },
  };
  if (overrides.subtype !== undefined) record['subtype'] = overrides.subtype;
  if (overrides.systemPayload !== undefined)
    record['systemPayload'] = overrides.systemPayload;
  if (overrides.forkedFrom !== undefined)
    record['forkedFrom'] = overrides.forkedFrom;
  if (overrides.provenance !== undefined)
    record['provenance'] = overrides.provenance;
  return JSON.stringify(record);
}

async function writeLines(
  filePath: string,
  lines: string[],
  mtime?: Date,
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
  if (mtime) await fsp.utimes(filePath, mtime, mtime);
}

describeWithDriver('session-index/sqlite', () => {
  let store: SessionIndexStore;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-index-'));
    projectDir = path.join(root, 'project');
    chatsDir = path.join(projectDir, 'chats');
    await fsp.mkdir(chatsDir, { recursive: true });
    store = openSessionIndexStore(driver!, projectDir);
  });

  afterEach(async () => {
    store.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('indexes a file and rows round-trip with turn columns', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [
      writeRecord({
        uuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-01-01T00:00:00.000Z',
        parts: [{ text: 'hello world' }],
        provenance: 'real_user',
      }),
      writeRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        type: 'assistant',
        parts: [{ text: 'reply' }],
      }),
    ]);

    await store.syncFile(filePath);

    const session = store.sessionRow('s1');
    expect(session).not.toBeNull();
    expect(session!.fileName).toBe('s1.jsonl');
    expect(session!.recordCount).toBe(2);
    expect(session!.startTime).toBe('2026-01-01T00:00:00.000Z');
    expect(session!.firstRecordUuid).toBe('u1');
    expect(session!.indexedBytes).toBeGreaterThan(0);
    expect(session!.status).toBe('ok');

    const rows = store.recordRows('s1');
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(rows![0].navKind).toBe('prompt');
    expect(rows![0].conversation).toBe(true);
    expect(rows![1].assistantPreview).toBe(true);
    expect(rows![1].parentUuid).toBe('u1');
  });

  it('syncFile is a no-op when mtime and size are unchanged', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [writeRecord({ uuid: 'u1', sessionId: 's1' })]);
    await store.syncFile(filePath);
    const before = store.sessionRow('s1')!;
    await store.syncFile(filePath);
    const after = store.sessionRow('s1')!;
    expect(after.indexedBytes).toBe(before.indexedBytes);
    expect(after.recordCount).toBe(1);
  });

  it('incremental sync indexes only the appended tail', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [writeRecord({ uuid: 'u1', sessionId: 's1' })]);
    await store.syncFile(filePath);
    const first = store.sessionRow('s1')!;

    await fsp.appendFile(
      filePath,
      writeRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        type: 'assistant',
      }) + '\n',
      'utf8',
    );
    await store.syncFile(filePath);
    const second = store.sessionRow('s1')!;
    expect(second.indexedBytes).toBeGreaterThan(first.indexedBytes);
    expect(second.recordCount).toBe(2);
    expect(store.recordRows('s1')!.map((r) => r.uuid)).toEqual(['u1', 'a1']);
  });

  it('excludes a partial trailing line until it is completed', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    const complete = writeRecord({ uuid: 'u1', sessionId: 's1' });
    await writeLines(filePath, [complete]);
    await store.syncFile(filePath);

    await fsp.appendFile(filePath, '{"uuid":"u2","sessionId":"s1"', 'utf8');
    await store.syncFile(filePath);
    expect(store.recordRows('s1')!.map((r) => r.uuid)).toEqual(['u1']);

    await fsp.appendFile(
      filePath,
      ',"parentUuid":null,"timestamp":"t","type":"user","message":{}}\n',
      'utf8',
    );
    await store.syncFile(filePath);
    expect(store.recordRows('s1')!.map((r) => r.uuid)).toEqual(['u1', 'u2']);
  });

  it('rewinds and rebuilds when the file shrinks', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [
      writeRecord({ uuid: 'u1', sessionId: 's1' }),
      writeRecord({ uuid: 'u2', parentUuid: 'u1', sessionId: 's1' }),
    ]);
    await store.syncFile(filePath);
    expect(store.sessionRow('s1')!.recordCount).toBe(2);

    await writeLines(filePath, [writeRecord({ uuid: 'v1', sessionId: 's1' })]);
    await store.syncFile(filePath);
    expect(store.sessionRow('s1')!.recordCount).toBe(1);
    expect(store.recordRows('s1')!.map((r) => r.uuid)).toEqual(['v1']);
  });

  it('flags mismatched sessionId and withholds record rows', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [
      writeRecord({ uuid: 'u1', sessionId: 'OTHER' }),
    ]);
    await store.syncFile(filePath);
    expect(store.sessionRow('s1')!.status).toBe('mismatch');
    expect(store.recordRows('s1')).toBeNull();
  });

  it('rebuilds the database when the schema version differs', async () => {
    const dbPath = sessionIndexDbPath(projectDir);
    store.close();
    const raw = new driver!.DatabaseSync(dbPath);
    raw.exec(
      "INSERT INTO meta(key, value) VALUES ('schema_version', '999') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    raw.close();

    store = openSessionIndexStore(driver!, projectDir);
    const version = store.sessionRow('anything') === null; // store opened fine
    expect(version).toBe(true);

    const rawCheck = new driver!.DatabaseSync(dbPath);
    const row = rawCheck
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    rawCheck.close();
    expect(Number(row.value)).toBe(SESSION_INDEX_SCHEMA_VERSION);
    expect(SESSION_INDEX_DB_FILE).toBe('sessions.index.sqlite');
  });

  it('syncDirectory indexes new files, skips unchanged, and GCs removed ones', async () => {
    await writeLines(path.join(chatsDir, 'a.jsonl'), [
      writeRecord({ uuid: 'u1', sessionId: 'a' }),
    ]);
    await writeLines(path.join(chatsDir, 'b.jsonl'), [
      writeRecord({ uuid: 'u1', sessionId: 'b' }),
    ]);

    const examined = await store.syncDirectory(chatsDir, 0);
    expect(examined).toBe(2);
    expect(
      store
        .catalogRows()
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual(['a', 'b']);

    const skipped = await store.syncDirectory(chatsDir, 60_000);
    expect(skipped).toBe(-1);

    await fsp.rm(path.join(chatsDir, 'b.jsonl'));
    const afterGc = await store.syncDirectory(chatsDir, 0);
    expect(afterGc).toBeGreaterThanOrEqual(1);
    expect(store.catalogRows().map((r) => r.sessionId)).toEqual(['a']);
    expect(store.sessionRow('b')).toBeNull();
  });

  it('extracts catalog label fields (prompt, cwd, gitBranch, creation metadata)', async () => {
    const filePath = path.join(chatsDir, 's1.jsonl');
    await writeLines(filePath, [
      writeRecord({
        uuid: 'sys1',
        sessionId: 's1',
        type: 'system',
        subtype: 'parent_session',
        cwd: '/work/proj',
        systemPayload: { parentSessionId: 'parent-1' },
      }),
      writeRecord({
        uuid: 'sys2',
        sessionId: 's1',
        type: 'system',
        subtype: 'session_source',
        cwd: '/work/proj',
        systemPayload: { sourceType: 'fork', sourceId: 'src-1' },
      }),
      writeRecord({
        uuid: 'u1',
        sessionId: 's1',
        cwd: '/work/proj',
        parts: [{ text: 'the first prompt text' }],
      }),
      writeRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        type: 'assistant',
      }),
    ]);
    await store.syncFile(filePath);

    const row = store.catalogRows()[0];
    expect(row.firstPrompt).toBe('the first prompt text');
    expect(row.cwd).toBe('/work/proj');
    expect(row.parentSessionId).toBe('parent-1');
    expect(row.sourceType).toBe('fork');
    expect(row.sourceId).toBe('src-1');
  });

  it('resetSessionIndexDatabase clears a corrupted database file so the store reopens empty', async () => {
    store.close();
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(
      sessionIndexDbPath(projectDir),
      'not a sqlite database at all',
      'utf8',
    );
    await resetSessionIndexDatabase(projectDir);
    store = openSessionIndexStore(driver!, projectDir);
    expect(store.catalogRows()).toEqual([]);
  });

  it('drops turns_cache rows when a session file is GCed', async () => {
    const filePath = path.join(chatsDir, 'gc.jsonl');
    await writeLines(filePath, [writeRecord({ uuid: 'u1', sessionId: 'gc' })]);
    await store.syncFile(filePath);
    store.putTurnIndexCache('gc', {
      indexedBytes: 10,
      leafUuid: 'u1',
      startTime: null,
      totalTurns: 1,
      turns: [{ turnId: 'u1', replayPosition: 0, kind: 'prompt' }],
    });
    expect(store.turnIndexCache('gc')).not.toBeNull();
    await fsp.rm(filePath);
    await store.syncDirectory(chatsDir, 0);
    expect(store.sessionRow('gc')).toBeNull();
    expect(store.turnIndexCache('gc')).toBeNull();
  });

  it('drops turns_cache rows when a file is rewind-rebuilt', async () => {
    const filePath = path.join(chatsDir, 'rw.jsonl');
    await writeLines(filePath, [
      writeRecord({ uuid: 'u1', sessionId: 'rw' }),
      writeRecord({ uuid: 'u2', parentUuid: 'u1', sessionId: 'rw' }),
    ]);
    await store.syncFile(filePath);
    store.putTurnIndexCache('rw', {
      indexedBytes: 10,
      leafUuid: 'u2',
      startTime: null,
      totalTurns: 2,
      turns: [{ turnId: 'u1', replayPosition: 0, kind: 'prompt' }],
    });
    expect(store.turnIndexCache('rw')).not.toBeNull();
    await writeLines(filePath, [writeRecord({ uuid: 'v1', sessionId: 'rw' })]);
    await store.syncFile(filePath);
    expect(store.turnIndexCache('rw')).toBeNull();
  });

  it('converges firstPrompt after an empty-prompt first sync (startup race)', async () => {
    const filePath = path.join(chatsDir, 'race.jsonl');
    // First sync sees only the system record (a listing raced session startup)
    await writeLines(filePath, [
      writeRecord({
        uuid: 'sys1',
        sessionId: 'race',
        type: 'system',
        subtype: 'checkpoint',
      }),
    ]);
    await store.syncFile(filePath);
    expect(store.catalogRows()[0].firstPrompt).toBe('');
    // The first user prompt lands afterwards — still inside the head window
    await fsp.appendFile(
      filePath,
      writeRecord({
        uuid: 'u1',
        sessionId: 'race',
        parts: [{ text: 'late prompt' }],
      }) + '\n',
      'utf8',
    );
    await store.syncFile(filePath);
    expect(store.catalogRows()[0].firstPrompt).toBe('late prompt');
  });

  it('indexes later fragments of the same uuid as their own rows', async () => {
    const filePath = path.join(chatsDir, 'frag.jsonl');
    const base = {
      uuid: 'shared',
      parentUuid: null,
      sessionId: 'frag',
      timestamp: new Date().toISOString(),
      type: 'assistant',
      cwd: '/tmp/workspace',
      version: '1.0.0',
      message: { role: 'model', parts: [{ text: 'original' }] },
    };
    const amended = {
      ...base,
      message: { role: 'model', parts: [{ text: 'amended patch' }] },
      usageMetadata: { outputTokenCount: 5 },
    };
    await writeLines(filePath, [JSON.stringify(base), JSON.stringify(amended)]);
    await store.syncFile(filePath);
    const rows = store.recordRows('frag')!;
    const shared = rows.filter((r) => r.uuid === 'shared');
    expect(shared.length).toBe(2);
    expect(shared[0].assistantPreview).toBe(true);
    expect(new Set(shared.map((r) => r.offset)).size).toBe(2);
  });

  it('orders catalog rows by mtime descending', async () => {
    const t = (n: number) => new Date(Date.UTC(2026, 0, n));
    await writeLines(
      path.join(chatsDir, 'old.jsonl'),
      [writeRecord({ uuid: 'u1', sessionId: 'old' })],
      t(1),
    );
    await writeLines(
      path.join(chatsDir, 'new.jsonl'),
      [writeRecord({ uuid: 'u1', sessionId: 'new' })],
      t(3),
    );
    await writeLines(
      path.join(chatsDir, 'mid.jsonl'),
      [writeRecord({ uuid: 'u1', sessionId: 'mid' })],
      t(2),
    );
    await store.syncDirectory(chatsDir, 0);
    expect(store.catalogRows().map((r) => r.sessionId)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });
});
