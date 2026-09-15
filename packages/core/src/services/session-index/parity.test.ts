/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Output-parity suite: the SQLite sidecar mode must produce byte-identical
// listSessions / readTurnIndexPage results to the file-scan mode across an
// adversarial transcript corpus. This is the load-bearing guarantee for
// enabling the feature flag.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from '../../config/storage.js';
import {
  SessionService,
  type ListSessionsResult,
  type SessionListItem,
} from '../sessionService.js';
import {
  SessionTranscriptReader,
  type SessionTranscriptTurnIndexPage,
} from '../session-transcript-reader.js';
import {
  configureSessionIndexing,
  getSessionIndexStore,
  resetSessionIndexingForTest,
  setSessionIndexDriverForTest,
} from './config.js';
import { sessionIndexDbPath } from './sqlite.js';
import type { SessionIndexMode } from './types.js';

let runtimeDir: string;
let workspaceDir: string;
let chatsDir: string;

const BASE_MS = Date.UTC(2026, 2, 1, 12, 0, 0);

interface RecOptions {
  uuid: string;
  parentUuid?: string | null;
  sessionId: string;
  ts?: number;
  type?: string;
  subtype?: string;
  text?: string;
  provenance?: string;
  systemPayload?: unknown;
  forkedFrom?: { pid: number; startTime: string };
  cwd?: string;
  parts?: unknown[];
}

function rec(o: RecOptions): string {
  const record: Record<string, unknown> = {
    uuid: o.uuid,
    parentUuid: o.parentUuid ?? null,
    sessionId: o.sessionId,
    timestamp: new Date(o.ts ?? BASE_MS).toISOString(),
    type: o.type ?? 'user',
    cwd: o.cwd ?? workspaceDir,
    version: '1.0.0',
    gitBranch: 'main',
    message: {
      role: (o.type ?? 'user') === 'assistant' ? 'model' : 'user',
      parts: o.parts ?? [{ text: o.text ?? `text-${o.uuid}` }],
    },
  };
  if (o.subtype !== undefined) record['subtype'] = o.subtype;
  if (o.provenance !== undefined) record['provenance'] = o.provenance;
  if (o.systemPayload !== undefined) record['systemPayload'] = o.systemPayload;
  if (o.forkedFrom !== undefined) record['forkedFrom'] = o.forkedFrom;
  return JSON.stringify(record);
}

function turnResult(
  uuid: string,
  parentUuid: string,
  sessionId: string,
  promptId: string,
  ts: number,
): string {
  return rec({
    uuid,
    parentUuid,
    sessionId,
    ts,
    type: 'system',
    subtype: 'turn_result',
    systemPayload: {
      promptId,
      state: 'completed',
      endedAt: ts,
    },
  });
}

/** A plain prompt→tools→answer chain of `turns` turns (5 records each). */
function simpleSession(
  sessionId: string,
  turns: number,
  startTs: number,
): string[] {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let t = 0; t < turns; t++) {
    const ts = startTs + t * 60_000;
    const u = `${sessionId}-u${t}`;
    lines.push(
      rec({
        uuid: u,
        parentUuid: parent,
        sessionId,
        ts,
        text: `prompt ${t} of ${sessionId}`,
      }),
    );
    parent = u;
    const a1 = `${sessionId}-a${t}`;
    lines.push(
      rec({
        uuid: a1,
        parentUuid: parent,
        sessionId,
        ts: ts + 1,
        type: 'assistant',
        text: `answer ${t}`,
      }),
    );
    parent = a1;
    const tr = `${sessionId}-tr${t}`;
    lines.push(turnResult(tr, parent, sessionId, `prompt-${t}`, ts + 2));
    parent = tr;
  }
  return lines;
}

async function writeSession(
  sessionId: string,
  lines: string[],
  mtimeMs: number,
): Promise<string> {
  const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
  const d = new Date(mtimeMs);
  await fsp.utimes(filePath, d, d);
  return filePath;
}

const SID = {
  simple1: '11111111-1111-4111-8111-111111111111',
  simple2: '22222222-2222-4222-8222-222222222222',
  branch: '33333333-3333-4333-8333-333333333333',
  realtime: '44444444-4444-4444-8444-444444444444',
  cron: '55555555-5555-4555-8555-555555555555',
  noPrompt: '66666666-6666-4666-8666-666666666666',
  goalOnly: '77777777-7777-4777-8777-777777777777',
  mismatch: '88888888-8888-4888-8888-888888888888',
  titled: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  glued: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

async function buildCorpus(): Promise<void> {
  await fsp.mkdir(chatsDir, { recursive: true });
  await writeSession(
    SID.simple1,
    simpleSession(SID.simple1, 3, BASE_MS),
    BASE_MS + 8 * 60_000,
  );
  await writeSession(
    SID.simple2,
    simpleSession(SID.simple2, 2, BASE_MS),
    BASE_MS + 7 * 60_000,
  );

  // Branch: two chains share a root; the later leaf wins.
  const b = SID.branch;
  await writeSession(
    b,
    [
      rec({
        uuid: `${b}-root`,
        sessionId: b,
        ts: BASE_MS,
        text: 'root prompt',
      }),
      rec({
        uuid: `${b}-a`,
        parentUuid: `${b}-root`,
        sessionId: b,
        ts: BASE_MS + 1,
        type: 'assistant',
        text: 'branch A',
      }),
      rec({
        uuid: `${b}-u2`,
        parentUuid: `${b}-a`,
        sessionId: b,
        ts: BASE_MS + 2,
        text: 'second prompt on A',
      }),
      rec({
        uuid: `${b}-fork`,
        parentUuid: `${b}-root`,
        sessionId: b,
        ts: BASE_MS + 3,
        text: 'forked prompt',
      }),
      rec({
        uuid: `${b}-fork-a`,
        parentUuid: `${b}-fork`,
        sessionId: b,
        ts: BASE_MS + 4,
        type: 'assistant',
        text: 'fork answer',
      }),
    ],
    BASE_MS + 6 * 60_000,
  );

  // Realtime + inherited records.
  const r = SID.realtime;
  await writeSession(
    r,
    [
      rec({ uuid: `${r}-u1`, sessionId: r, ts: BASE_MS, text: 'a prompt' }),
      rec({
        uuid: `${r}-rt`,
        parentUuid: `${r}-u1`,
        sessionId: r,
        ts: BASE_MS + 1,
        subtype: 'realtime_message',
        text: 'realtime question',
      }),
      rec({
        uuid: `${r}-rta`,
        parentUuid: `${r}-rt`,
        sessionId: r,
        ts: BASE_MS + 2,
        type: 'assistant',
        subtype: 'realtime_message',
        text: 'realtime answer',
      }),
      rec({
        uuid: `${r}-u2`,
        parentUuid: `${r}-rta`,
        sessionId: r,
        ts: BASE_MS + 3,
        text: 'after realtime',
        forkedFrom: { pid: 1234, startTime: new Date(BASE_MS).toISOString() },
      }),
    ],
    BASE_MS + 5 * 60_000 + 0,
  );

  // Cron (scheduled) turn.
  const c = SID.cron;
  await writeSession(
    c,
    [
      rec({
        uuid: `${c}-cron`,
        sessionId: c,
        ts: BASE_MS,
        subtype: 'cron',
        systemPayload: { displayText: 'nightly sync job' },
        text: '',
      }),
      rec({
        uuid: `${c}-a1`,
        parentUuid: `${c}-cron`,
        sessionId: c,
        ts: BASE_MS + 1,
        type: 'assistant',
        text: 'did the sync',
      }),
    ],
    BASE_MS + 4 * 60_000,
  );

  // Assistant only (no user prompt at all).
  const np = SID.noPrompt;
  await writeSession(
    np,
    [
      rec({
        uuid: `${np}-a1`,
        sessionId: np,
        ts: BASE_MS,
        type: 'assistant',
        text: 'orphan answer',
      }),
    ],
    BASE_MS + 3 * 60_000,
  );

  // Goal state only (kept deliberately small: the head-records goal branch).
  const go = SID.goalOnly;
  await writeSession(
    go,
    [
      rec({
        uuid: `${go}-gs`,
        sessionId: go,
        ts: BASE_MS,
        type: 'system',
        subtype: 'goal_state',
        systemPayload: {
          v: 2,
          cause: 'proposed',
          snapshot: { activity: 'running' },
          checkpointPending: false,
        },
      }),
    ],
    BASE_MS + 2 * 60_000,
  );

  // Mismatched sessionId inside the file.
  await writeSession(
    SID.mismatch,
    [
      rec({
        uuid: `${SID.mismatch}-u1`,
        sessionId: 'another-session-entirely',
        ts: BASE_MS,
        text: 'foreign record',
      }),
    ],
    BASE_MS + 1 * 60_000,
  );

  // Parent + source metadata + a custom title record: exercises the
  // non-default branches of every SessionListItem label field.
  const t = SID.titled;
  await writeSession(
    t,
    [
      rec({
        uuid: `${t}-ps`,
        sessionId: t,
        ts: BASE_MS,
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId: SID.simple1 },
      }),
      rec({
        uuid: `${t}-ss`,
        sessionId: t,
        ts: BASE_MS + 1,
        type: 'system',
        subtype: 'session_source',
        systemPayload: { sourceType: 'fork', sourceId: 'source-42' },
      }),
      rec({
        uuid: `${t}-u1`,
        sessionId: t,
        ts: BASE_MS + 2,
        text: 'titled prompt',
      }),
      rec({
        uuid: `${t}-ct`,
        sessionId: t,
        ts: BASE_MS + 3,
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { title: 'Titled session' },
      }),
    ],
    BASE_MS + 45 * 60_000,
  );

  // Two complete records glued onto one physical line (torn-append shape).
  const gl = SID.glued;
  await writeSession(
    gl,
    [
      rec({
        uuid: `${gl}-u1`,
        sessionId: gl,
        ts: BASE_MS,
        text: 'first glued prompt',
      }) +
        rec({
          uuid: `${gl}-a1`,
          parentUuid: `${gl}-u1`,
          sessionId: gl,
          ts: BASE_MS + 1,
          type: 'assistant',
          text: 'glued answer',
        }),
      rec({
        uuid: `${gl}-u2`,
        parentUuid: `${gl}-a1`,
        sessionId: gl,
        ts: BASE_MS + 2,
        text: 'second glued prompt',
      }),
    ],
    BASE_MS + 35 * 60_000,
  );

  // Malformed JSON mid-file.
  await writeSession(
    '99999999-9999-4999-8999-999999999999',
    [
      rec({
        uuid: 'mal-u1',
        sessionId: '99999999-9999-4999-8999-999999999999',
        ts: BASE_MS,
        text: 'before bad line',
      }),
      '{"not":"closed"',
      rec({
        uuid: 'mal-a1',
        parentUuid: 'mal-u1',
        sessionId: '99999999-9999-4999-8999-999999999999',
        ts: BASE_MS + 1,
        type: 'assistant',
        text: 'after bad line',
      }),
    ],
    BASE_MS + 30 * 60_000,
  );

  // Non-UUID-named file (listing must ignore it).
  await writeSession(
    'notes-scratch',
    [rec({ uuid: 'n1', sessionId: 'notes-scratch', text: 'scratch' })],
    BASE_MS + 40 * 60_000,
  );

  // Empty file.
  await writeSession(
    '00000000-0000-4000-8000-000000000000',
    [],
    BASE_MS + 50 * 60_000,
  );
}

function setMode(mode: SessionIndexMode): void {
  resetSessionIndexingForTest();
  configureSessionIndexing({ mode });
}

async function paginateSessions(size: number): Promise<SessionListItem[]> {
  const service = new SessionService(workspaceDir, {
    runtimeBaseDir: runtimeDir,
  });
  const items: SessionListItem[] = [];
  let cursor: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page: ListSessionsResult = await service.listSessions({
      size,
      cursor,
    });
    items.push(...page.items);
    if (!page.hasMore || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return items;
}

function comparableItems(items: SessionListItem[]): unknown {
  return items.map((item) => ({
    sessionId: item.sessionId,
    cwd: item.cwd,
    startTime: item.startTime,
    mtime: item.mtime,
    prompt: item.prompt,
    gitBranch: item.gitBranch,
    customTitle: item.customTitle,
    goalObjective: item.goalObjective,
    parentSessionId: item.parentSessionId,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    titleSource: item.titleSource,
    isArchived: item.isArchived,
  }));
}

function comparablePage(page: SessionTranscriptTurnIndexPage): unknown {
  return {
    v: page.v,
    sessionId: page.sessionId,
    snapshot: page.snapshot,
    totalTurns: page.totalTurns,
    start: page.start,
    startTime: page.startTime,
    lastUpdated: page.lastUpdated,
    turns: page.turns,
  };
}

describe('session-index parity: sidecar vs file scan', () => {
  beforeEach(async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'session-index-parity-'),
    );
    runtimeDir = path.join(root, 'runtime');
    workspaceDir = path.join(root, 'workspace');
    await fsp.mkdir(workspaceDir, { recursive: true });
    Storage.setRuntimeBaseDir(runtimeDir, workspaceDir);
    chatsDir = path.join(
      new Storage(workspaceDir, runtimeDir).getProjectDir(),
      'chats',
    );
    await buildCorpus();
  });

  afterEach(async () => {
    resetSessionIndexingForTest();
    Storage.setRuntimeBaseDir(null);
    await fsp.rm(path.dirname(runtimeDir), { recursive: true, force: true });
  });

  it('listSessions pages are identical in both modes', async () => {
    setMode('file');
    const baseline = comparableItems(await paginateSessions(3));

    setMode('sqlite');
    const indexed = comparableItems(await paginateSessions(3));
    expect(indexed).toEqual(baseline);

    // And the sidecar does not perturb the file mode once created.
    setMode('file');
    const after = comparableItems(await paginateSessions(3));
    expect(after).toEqual(baseline);
  });

  it('listSessions first page is identical at a single call granularity', async () => {
    setMode('file');
    const baseline = comparableItems(
      (
        await new SessionService(workspaceDir, {
          runtimeBaseDir: runtimeDir,
        }).listSessions({ size: 5 })
      ).items,
    );
    setMode('sqlite');
    const indexed = comparableItems(
      (
        await new SessionService(workspaceDir, {
          runtimeBaseDir: runtimeDir,
        }).listSessions({ size: 5 })
      ).items,
    );
    expect(indexed).toEqual(baseline);
  });

  it('readTurnIndexPage first page is identical per session', async () => {
    const files = (await fsp.readdir(chatsDir)).filter(
      (f) =>
        f.endsWith('.jsonl') &&
        !f.startsWith(SID.mismatch) &&
        f !== 'notes-scratch.jsonl',
    );
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      setMode('file');
      const baseline = comparablePage(
        await new SessionTranscriptReader(
          workspaceDir,
          undefined,
          runtimeDir,
        ).readTurnIndexPage(sessionId, { limit: 2 }),
      );
      setMode('sqlite');
      const indexed = comparablePage(
        await new SessionTranscriptReader(
          workspaceDir,
          undefined,
          runtimeDir,
        ).readTurnIndexPage(sessionId, { limit: 2 }),
      );
      expect(indexed, `session ${sessionId}`).toEqual(baseline);
    }
  });

  it('snapshot continuation pages are byte-identical across modes', async () => {
    const sessionId = SID.simple1;
    setMode('file');
    const readerFile = new SessionTranscriptReader(
      workspaceDir,
      undefined,
      runtimeDir,
    );
    const page1File = await readerFile.readTurnIndexPage(sessionId, {
      limit: 1,
    });

    setMode('sqlite');
    const readerSqlite = new SessionTranscriptReader(
      workspaceDir,
      undefined,
      runtimeDir,
    );
    const page1Sqlite = await readerSqlite.readTurnIndexPage(sessionId, {
      limit: 1,
    });
    expect(comparablePage(page1Sqlite)).toEqual(comparablePage(page1File));

    // A legacy-mode snapshot must continue on the sidecar path and vice versa.
    const start = page1File.start; // ordinal of the shown page
    if (start > 0) {
      setMode('sqlite');
      const contA = await new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      ).readTurnIndexPage(sessionId, {
        snapshot: page1File.snapshot,
        start: 0,
        limit: start,
      });
      setMode('file');
      const contB = await new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      ).readTurnIndexPage(sessionId, {
        snapshot: page1Sqlite.snapshot,
        start: 0,
        limit: start,
      });
      expect(comparablePage(contA)).toEqual(comparablePage(contB));
    }
  });

  it('mismatched-session errors are identical in both modes', async () => {
    for (const mode of ['file', 'sqlite'] as const) {
      setMode(mode);
      const reader = new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      );
      await expect(
        reader.readTurnIndexPage(SID.mismatch, { limit: 2 }),
        `mode=${mode}`,
      ).rejects.toMatchObject({
        name: 'SessionTranscriptSnapshotUnavailableError',
      });
    }
  });

  it('driver-unavailable mode falls back to file scanning with identical output', async () => {
    setMode('sqlite');
    setSessionIndexDriverForTest(null);
    const items = comparableItems(await paginateSessions(3));

    setMode('file');
    const baseline = comparableItems(await paginateSessions(3));
    expect(items).toEqual(baseline);

    setSessionIndexDriverForTest(undefined);
  });

  it('deleting the sidecar between calls is invisible to callers', async () => {
    setMode('sqlite');
    const first = comparablePage(
      await new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      ).readTurnIndexPage(SID.simple1, { limit: 2 }),
    );
    resetSessionIndexingForTest();
    configureSessionIndexing({ mode: 'sqlite' });
    await fsp.rm(sessionIndexDbPath(path.dirname(chatsDir)), { force: true });
    await fsp.rm(`${sessionIndexDbPath(path.dirname(chatsDir))}-wal`, {
      force: true,
    });
    await fsp.rm(`${sessionIndexDbPath(path.dirname(chatsDir))}-shm`, {
      force: true,
    });
    const rebuilt = comparablePage(
      await new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      ).readTurnIndexPage(SID.simple1, { limit: 2 }),
    );
    expect(rebuilt).toEqual(first);
  });

  it('page metadata (hasMore/nextCursor) is identical page-by-page', async () => {
    async function collectPages(): Promise<
      Array<
        Pick<ListSessionsResult, 'hasMore' | 'nextCursor'> & {
          itemIds: string[];
        }
      >
    > {
      const service = new SessionService(workspaceDir, {
        runtimeBaseDir: runtimeDir,
      });
      const pages: Array<
        Pick<ListSessionsResult, 'hasMore' | 'nextCursor'> & {
          itemIds: string[];
        }
      > = [];
      let cursor: number | undefined;
      for (let guard = 0; guard < 100; guard++) {
        const page = await service.listSessions({ size: 3, cursor });
        pages.push({
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          itemIds: page.items.map((i) => i.sessionId),
        });
        if (!page.hasMore || page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
      return pages;
    }
    setMode('file');
    const baseline = await collectPages();
    setMode('sqlite');
    const indexed = await collectPages();
    expect(indexed).toEqual(baseline);
  });

  it('the sqlite mode run actually exercised the sidecar', async () => {
    setMode('sqlite');
    await paginateSessions(3);
    const projectDir = path.dirname(chatsDir);
    const store = await getSessionIndexStore(projectDir);
    expect(store).not.toBeNull();
    const catalog = store!.catalogRows();
    expect(catalog.length).toBeGreaterThan(5);
    for (const row of catalog.slice(0, 5)) {
      expect(store!.recordRows(row.sessionId)).not.toBeNull();
    }
    // Turn pages populate the durable turn cache on first derivation.
    await new SessionTranscriptReader(
      workspaceDir,
      undefined,
      runtimeDir,
    ).readTurnIndexPage(SID.simple1, { limit: 2 });
    expect(store!.turnIndexCache(SID.simple1)).not.toBeNull();
  });

  it('an appended turn appears identically in both modes (durable cache invalidation)', async () => {
    const sessionId = SID.simple2;
    async function total(): Promise<number> {
      const page = await new SessionTranscriptReader(
        workspaceDir,
        undefined,
        runtimeDir,
      ).readTurnIndexPage(sessionId, { limit: 1 });
      return page.totalTurns;
    }
    setMode('sqlite');
    const beforeSqlite = await total();
    setMode('file');
    const beforeFile = await total();
    expect(beforeFile).toBe(beforeSqlite);

    // Append a fresh turn chain linked to the current leaf.
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as { uuid: string };
    const ts = Date.UTC(2026, 4, 1, 10, 0, 0);
    const appended = [
      rec({
        uuid: `${sessionId}-uX`,
        parentUuid: last.uuid,
        sessionId,
        ts,
        text: 'post-cache prompt',
      }),
      rec({
        uuid: `${sessionId}-aX`,
        parentUuid: `${sessionId}-uX`,
        sessionId,
        ts: ts + 1,
        type: 'assistant',
        text: 'post-cache answer',
      }),
    ];
    await fsp.appendFile(filePath, appended.join('\n') + '\n', 'utf8');

    setMode('sqlite');
    const afterSqlite = await total();
    setMode('file');
    const afterFile = await total();
    expect(afterSqlite).toBe(afterFile);
    expect(afterSqlite).toBe(beforeSqlite + 1);
  });

  it('an unparseable cursor yields an empty page in both modes', async () => {
    for (const mode of ['file', 'sqlite'] as const) {
      setMode(mode);
      const page = await new SessionService(workspaceDir, {
        runtimeBaseDir: runtimeDir,
      }).listSessions({ size: 3, cursor: Number.NaN });
      expect(mode, `mode=${mode}`).toBeTruthy();
      expect(page.items, `mode=${mode}`).toEqual([]);
      expect(page.hasMore, `mode=${mode}`).toBe(false);
    }
  });

  it('a session created between sweeps is visible immediately in sqlite mode', async () => {
    setMode('sqlite');
    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const before = (await service.listSessions({ size: 100 })).items.map(
      (i) => i.sessionId,
    );
    // Create a brand-new session well inside the sweep TTL window.
    const newId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await writeSession(
      newId,
      [rec({ uuid: `${newId}-u1`, sessionId: newId, text: 'fresh prompt' })],
      Date.now(),
    );
    const after = (await service.listSessions({ size: 100 })).items.map(
      (i) => i.sessionId,
    );
    expect(before).not.toContain(newId);
    expect(after[0]).toBe(newId);
  });
});
