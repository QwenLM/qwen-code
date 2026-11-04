/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage, upsertSessionPr } from '@qwen-code/qwen-code-core';
import type { BridgeSessionSummary } from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  WorkspaceEntry,
  WorkspaceEntryState,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { createWorkspaceGenerationGuard } from '../workspace-registry.js';
import { registerSessionPrBindingsRoutes } from './session-pr-bindings.js';

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';
const SESSION_C = '00000000-0000-4000-8000-00000000000c';

let runtimeDir: string;
let liveSessions: Map<string, BridgeSessionSummary[]>;
let stderrSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
  runtimeDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-pr-bindings-runtime-'),
  );
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  liveSessions = new Map();
});

afterEach(async () => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await fsp.rm(runtimeDir, { recursive: true, force: true });
});

function captureStderr(): string[] {
  const lines: string[] = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: unknown,
  ) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
}

async function makeWorkspace(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(runtimeDir, 'work-'));
  return await fsp.realpath(cwd);
}

function chatsDirFor(cwd: string): string {
  return path.join(new Storage(cwd).getProjectDir(), 'chats');
}

function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(chatsDirFor(cwd), `${sessionId}.jsonl`);
}

function sidecarPath(cwd: string, sessionId: string): string {
  return path.join(chatsDirFor(cwd), `${sessionId}.pr.json`);
}

async function seedTranscript(
  cwd: string,
  sessionId: string,
  opts: {
    sourceType?: string;
    recordCwd?: string;
    archived?: boolean;
    mtime?: Date;
  } = {},
): Promise<string> {
  const dir = opts.archived
    ? path.join(chatsDirFor(cwd), 'archive')
    : chatsDirFor(cwd);
  await fsp.mkdir(dir, { recursive: true });
  const records: Array<Record<string, unknown>> = [
    {
      uuid: `${sessionId}-user-1`,
      parentUuid: null,
      sessionId,
      timestamp: '2026-11-01T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd: opts.recordCwd ?? cwd,
    },
  ];
  if (opts.sourceType !== undefined) {
    records.push({
      uuid: `${sessionId}-source`,
      parentUuid: `${sessionId}-user-1`,
      sessionId,
      timestamp: '2026-11-01T00:00:01.000Z',
      type: 'system',
      subtype: 'session_source',
      systemPayload: { sourceType: opts.sourceType },
      cwd: opts.recordCwd ?? cwd,
    });
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  if (opts.mtime) await fsp.utimes(file, opts.mtime, opts.mtime);
  return file;
}

async function seedBinding(
  cwd: string,
  sessionId: string,
  numbers: number[],
  opts: { archived?: boolean; state?: 'open' | 'merged' | 'closed' } = {},
): Promise<string> {
  const dir = opts.archived
    ? path.join(chatsDirFor(cwd), 'archive')
    : chatsDirFor(cwd);
  await fsp.mkdir(dir, { recursive: true });
  const prPath = path.join(dir, `${sessionId}.pr.json`);
  for (const number of numbers) {
    await upsertSessionPr(prPath, {
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      state: opts.state ?? 'open',
    });
  }
  if (numbers.length === 0) {
    await fsp.writeFile(prPath, JSON.stringify({ prs: [] }), 'utf8');
  }
  return prPath;
}

async function corruptSidecar(cwd: string, sessionId: string): Promise<void> {
  await fsp.mkdir(chatsDirFor(cwd), { recursive: true });
  await fsp.writeFile(sidecarPath(cwd, sessionId), '{not json', 'utf8');
}

function liveSummary(
  cwd: string,
  sessionId: string,
  overrides: Partial<BridgeSessionSummary> = {},
): BridgeSessionSummary {
  return {
    sessionId,
    workspaceCwd: cwd,
    createdAt: '2026-11-03T08:00:00.000Z',
    clientCount: 1,
    hasActivePrompt: false,
    ...overrides,
  };
}

function makeRuntime(
  cwd: string,
  overrides: Partial<{ trusted: boolean; primary: boolean }> = {},
): WorkspaceRuntime {
  return {
    workspaceId: cwd,
    workspaceCwd: cwd,
    sessionRuntimeBaseDir: runtimeDir,
    trusted: true,
    primary: false,
    bridge: {
      listWorkspaceSessions: (workspaceCwd: string) =>
        liveSessions.get(workspaceCwd) ?? [],
    },
    ...overrides,
  } as unknown as WorkspaceRuntime;
}

function makeEntry(
  runtime?: WorkspaceRuntime,
  state: WorkspaceEntryState = 'active',
): WorkspaceEntry {
  return {
    workspaceId: runtime?.workspaceCwd ?? 'ws-absent',
    workspaceCwd: runtime?.workspaceCwd ?? '/ws/absent',
    primary: runtime?.primary ?? false,
    removable: true,
    internal: false,
    registrationIds: [],
    lastGenerationId: 1,
    state,
    ...(runtime
      ? {
          current: {
            generationId: 1,
            policyRevision: 'rev-1',
            runtime,
            guard: createWorkspaceGenerationGuard(),
          },
        }
      : {}),
    configuredRevision: 'rev-1',
    appliedRevision: 'rev-1',
  };
}

function appHarness(opts: {
  entries: WorkspaceEntry[];
  registryError?: Error;
}) {
  const app = express();
  const sendBridgeError = vi.fn(
    (res: express.Response, err: unknown, meta: { route: string }) => {
      res.status(500).json({ error: String(err), route: meta.route });
    },
  );
  registerSessionPrBindingsRoutes(app, {
    workspaceRegistry: {
      listAllEntries: () => {
        if (opts.registryError) throw opts.registryError;
        return opts.entries;
      },
    } as never,
    sendBridgeError: sendBridgeError as never,
  });
  return { app, sendBridgeError };
}

interface BindingsBody {
  bindings: Array<{
    sessionId: string;
    workspaceCwd: string;
    sourceType?: string;
    updatedAt?: string;
    prs: Array<{ number: number; url: string; state?: string }>;
  }>;
  partial: boolean;
}

async function fetchBindings(entries: WorkspaceEntry[]): Promise<BindingsBody> {
  const { app } = appHarness({ entries });
  const res = await request(app).get('/sessions/pr-bindings');
  expect(res.status).toBe(200);
  return res.body as BindingsBody;
}

describe('GET /sessions/pr-bindings', () => {
  it('projects bound sessions from their sidecars with persisted attribution', async () => {
    const cwd = await makeWorkspace();
    const mtime = new Date('2026-11-02T12:00:00.000Z');
    await seedTranscript(cwd, SESSION_A, { sourceType: 'web-shell', mtime });
    await seedBinding(cwd, SESSION_A, [101]);
    await seedTranscript(cwd, SESSION_B);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({
      bindings: [
        {
          sessionId: SESSION_A,
          workspaceCwd: cwd,
          sourceType: 'web-shell',
          updatedAt: mtime.toISOString(),
          prs: [
            {
              number: 101,
              url: 'https://github.com/acme/widgets/pull/101',
              state: 'open',
            },
          ],
        },
      ],
      partial: false,
    });
  });

  it('answers complete for more sessions than one list page', async () => {
    const cwd = await makeWorkspace();
    const ids = Array.from(
      { length: 120 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const [i, id] of ids.entries()) {
      await seedTranscript(cwd, id);
      await seedBinding(cwd, id, [i + 1]);
    }

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(new Set(body.bindings.map((b) => b.sessionId))).toEqual(
      new Set(ids),
    );
  });

  it('emits an unattributed tombstone row for a well-formed empty sidecar', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { sourceType: 'web-shell' });
    await seedBinding(cwd, SESSION_A, []);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({
      bindings: [{ sessionId: SESSION_A, workspaceCwd: cwd, prs: [] }],
      partial: false,
    });
  });

  it('flags an unreadable sidecar as partial instead of an unbind and names it once', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);
    await seedTranscript(cwd, SESSION_B);
    await corruptSidecar(cwd, SESSION_B);
    const lines = captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    const scanLines = lines.filter((line) => line.includes('PR bindings scan'));
    expect(scanLines).toHaveLength(1);
    expect(scanLines[0]).toContain('1 of 2 sessions could not be read');
    expect(scanLines[0]).toContain(cwd);
    expect(scanLines[0]).toContain(SESSION_B);
    expect(scanLines[0]).toContain('invalid JSON');
  });

  it('writes one diagnostic line per workspace scan however many sessions fail', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await corruptSidecar(cwd, SESSION_A);
    await seedTranscript(cwd, SESSION_B);
    await corruptSidecar(cwd, SESSION_B);
    const lines = captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: true });
    const scanLines = lines.filter((line) => line.includes('PR bindings scan'));
    expect(scanLines).toHaveLength(1);
    expect(scanLines[0]).toContain('2 of 2 sessions could not be read');
  });

  it('flags a thrown per-session read as partial and names the session', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);
    // A directory where the sidecar should be makes the read throw (EISDIR).
    await fsp.mkdir(sidecarPath(cwd, SESSION_B), { recursive: true });
    const lines = captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    const scanLines = lines.filter((line) => line.includes('PR bindings scan'));
    expect(scanLines).toHaveLength(1);
    expect(scanLines[0]).toContain(SESSION_B);
  });

  it('flags a present but unreadable transcript as partial and omits the row', async () => {
    const cwd = await makeWorkspace();
    await seedBinding(cwd, SESSION_A, [101]);
    // A directory at the transcript path: stat succeeds, nothing can be read.
    await fsp.mkdir(transcriptPath(cwd, SESSION_A), { recursive: true });
    captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: true });
  });

  it('does not let a machine-owned session with a corrupt sidecar make the answer partial', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { sourceType: 'agent' });
    await corruptSidecar(cwd, SESSION_A);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('preserves merged and closed PR states verbatim', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [7], { state: 'merged' });
    await seedBinding(cwd, SESSION_A, [8], { state: 'closed' });

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.prs.map((pr) => [pr.number, pr.state])).toEqual([
      [7, 'merged'],
      [8, 'closed'],
    ]);
  });

  it('does not list archived sessions', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { archived: true });
    await seedBinding(cwd, SESSION_A, [101], { archived: true });

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('skips an active sidecar left behind by an archived session', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { archived: true });
    await seedBinding(cwd, SESSION_A, [101]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('skips a sidecar whose transcript belongs to another project', async () => {
    const cwd = await makeWorkspace();
    const other = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { recordCwd: other });
    await seedBinding(cwd, SESSION_A, [101]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('lists a binding written before the first transcript flush, attributed from the live session', async () => {
    const cwd = await makeWorkspace();
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, { sourceType: 'web-shell' }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(body.bindings).toEqual([
      expect.objectContaining({
        sessionId: SESSION_A,
        sourceType: 'web-shell',
        updatedAt: '2026-11-03T08:00:00.000Z',
      }),
    ]);
  });

  it('lists a dormant binding with no transcript and no live entry without attribution', async () => {
    const cwd = await makeWorkspace();
    await seedBinding(cwd, SESSION_A, [101]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(body.bindings).toEqual([
      { sessionId: SESSION_A, workspaceCwd: cwd, prs: [expect.any(Object)] },
    ]);
  });

  it('appends a binding the bridge holds but no sidecar has yet', async () => {
    const cwd = await makeWorkspace();
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        sourceType: 'web-shell',
        prs: [
          {
            number: 55,
            url: 'https://github.com/acme/widgets/pull/55',
            state: 'open',
          },
        ],
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({
      bindings: [
        {
          sessionId: SESSION_A,
          workspaceCwd: cwd,
          sourceType: 'web-shell',
          updatedAt: '2026-11-03T08:00:00.000Z',
          prs: [
            {
              number: 55,
              url: 'https://github.com/acme/widgets/pull/55',
              state: 'open',
            },
          ],
        },
      ],
      partial: false,
    });
  });

  it('keeps a listed tombstone row empty even when the bridge still holds bindings', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, []);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [{ number: 55, url: 'https://github.com/acme/widgets/pull/55' }],
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({
      bindings: [{ sessionId: SESSION_A, workspaceCwd: cwd, prs: [] }],
      partial: false,
    });
  });

  it('does not append live-only bindings of machine-owned sessions', async () => {
    const cwd = await makeWorkspace();
    const prs = [
      { number: 55, url: 'https://github.com/acme/widgets/pull/55' },
    ];
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_B, { prs, sourceType: 'agent' }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('decides live-only ownership from the persisted record when the bridge entry carries no source', async () => {
    const cwd = await makeWorkspace();
    // A restored agent task session: persisted sourceType 'agent', no
    // sourceType on its bridge entry, bindings only in bridge memory.
    await seedTranscript(cwd, SESSION_A, { sourceType: 'agent' });
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [{ number: 55, url: 'https://github.com/acme/widgets/pull/55' }],
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('caps the bridge merge like the session list: below the cap the newest live numbers win', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [
          { number: 101, url: 'https://github.com/acme/widgets/pull/101' },
          { number: 102, url: 'https://github.com/acme/widgets/pull/102' },
        ],
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    const numbers = body.bindings[0]?.prs.map((pr) => pr.number);
    expect(numbers).toHaveLength(10);
    expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 101, 102]);
  });

  it('caps the bridge merge like the session list: a full persisted list is not extended', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: Array.from({ length: 10 }, (_, i) => ({
          number: 100 + i,
          url: `https://github.com/acme/widgets/pull/${100 + i}`,
        })),
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.prs.map((pr) => pr.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('answers complete for a registered workspace whose chats directory does not exist yet', async () => {
    const cwd = await makeWorkspace();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('takes the later of the persisted and live activity timestamps', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, {
      mtime: new Date('2026-11-02T12:00:00.000Z'),
    });
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-03T09:00:00.000Z',
        hasActivePrompt: true,
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.updatedAt).toBe('2026-11-03T09:00:00.000Z');
  });

  it('keeps the persisted timestamp when it is newer than the live one', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, {
      mtime: new Date('2026-11-04T12:00:00.000Z'),
    });
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-03T09:00:00.000Z',
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.updatedAt).toBe('2026-11-04T12:00:00.000Z');
  });

  it('ignores an unparseable live timestamp', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, {
      mtime: new Date('2026-11-02T12:00:00.000Z'),
    });
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        createdAt: 'not-a-date',
        updatedAt: 'zzzz',
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.updatedAt).toBe('2026-11-02T12:00:00.000Z');
  });

  it('excludes machine-owned hidden-catalog sessions', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { sourceType: 'agent' });
    await seedBinding(cwd, SESSION_A, [101]);
    await seedTranscript(cwd, SESSION_B, { sourceType: 'channel' });
    await seedBinding(cwd, SESSION_B, [102]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(body.bindings.map((b) => [b.sessionId, b.sourceType])).toEqual([
      [SESSION_B, 'channel'],
    ]);
  });

  it('skips untrusted non-primary workspaces and scans an untrusted primary completely', async () => {
    const untrusted = await makeWorkspace();
    await seedTranscript(untrusted, SESSION_A);
    await seedBinding(untrusted, SESSION_A, [101]);
    const primary = await makeWorkspace();
    await seedTranscript(primary, SESSION_B);
    await seedBinding(primary, SESSION_B, [102]);

    const body = await fetchBindings([
      makeEntry(makeRuntime(untrusted, { trusted: false })),
      makeEntry(makeRuntime(primary, { trusted: false, primary: true })),
    ]);

    expect(body.partial).toBe(false);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_B]);
  });

  it.each(['draining', 'transitioning', 'blocked'] as const)(
    'scans a %s workspace that still has a runtime',
    async (state) => {
      const cwd = await makeWorkspace();
      await seedTranscript(cwd, SESSION_A);
      await seedBinding(cwd, SESSION_A, [101]);

      const body = await fetchBindings([makeEntry(makeRuntime(cwd), state)]);

      expect(body.partial).toBe(false);
      expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    },
  );

  it('flags partial when an entry has no current runtime', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);

    const lines = captureStderr();

    const body = await fetchBindings([
      makeEntry(undefined, 'transitioning'),
      makeEntry(makeRuntime(cwd)),
    ]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    expect(lines).toContainEqual(
      expect.stringContaining(
        'workspace /ws/absent has no runtime (state transitioning)',
      ),
    );
  });

  it('aggregates bindings across workspaces', async () => {
    const a = await makeWorkspace();
    await seedTranscript(a, SESSION_A);
    await seedBinding(a, SESSION_A, [1]);
    const b = await makeWorkspace();
    await seedTranscript(b, SESSION_B);
    await seedBinding(b, SESSION_B, [2]);
    await seedTranscript(b, SESSION_C);
    await seedBinding(b, SESSION_C, [3]);

    const body = await fetchBindings([
      makeEntry(makeRuntime(a)),
      makeEntry(makeRuntime(b)),
    ]);

    expect(body.partial).toBe(false);
    // Directory listing order is filesystem-specific; compare as a set.
    expect(
      new Set(
        body.bindings.map(
          (binding) => `${binding.workspaceCwd}|${binding.sessionId}`,
        ),
      ),
    ).toEqual(
      new Set([`${a}|${SESSION_A}`, `${b}|${SESSION_B}`, `${b}|${SESSION_C}`]),
    );
  });

  it('keeps other workspaces and names the failing one when a chats dir cannot be listed', async () => {
    const broken = await makeWorkspace();
    await fsp.mkdir(path.dirname(chatsDirFor(broken)), { recursive: true });
    await fsp.writeFile(chatsDirFor(broken), 'not a directory', 'utf8');
    const healthy = await makeWorkspace();
    await seedTranscript(healthy, SESSION_A);
    await seedBinding(healthy, SESSION_A, [101]);
    const lines = captureStderr();

    const body = await fetchBindings([
      makeEntry(makeRuntime(broken)),
      makeEntry(makeRuntime(healthy)),
    ]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    expect(lines).toContainEqual(
      expect.stringContaining(
        `PR bindings scan failed for workspace ${broken}`,
      ),
    );
  });

  it('treats a workspace without any sidecar as an authoritative absence', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('flags partial and keeps sidecar rows when the live session list cannot be read', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);
    const runtime = makeRuntime(cwd);
    (
      runtime.bridge as unknown as { listWorkspaceSessions: () => never }
    ).listWorkspaceSessions = () => {
      throw new Error('EACCES: bridge unavailable');
    };
    const lines = captureStderr();

    const body = await fetchBindings([makeEntry(runtime)]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
    expect(lines).toContainEqual(
      expect.stringContaining('live session list unavailable'),
    );
  });

  it('merges bridge-held PR numbers into a listed non-empty row', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [
          { number: 101, url: 'https://github.com/acme/widgets/pull/101' },
          { number: 56, url: 'https://github.com/acme/widgets/pull/56' },
        ],
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]?.prs.map((pr) => pr.number)).toEqual([101, 56]);
  });

  it('does not list an empty sidecar of a machine-owned or archived session as a tombstone', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, { sourceType: 'agent' });
    await seedBinding(cwd, SESSION_A, []);
    await seedTranscript(cwd, SESSION_B, { archived: true });
    await seedBinding(cwd, SESSION_B, []);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('compares timestamps chronologically, not lexicographically', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, {
      mtime: new Date('2026-11-02T05:00:00.000Z'),
    });
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        createdAt: '2026-11-01T00:00:00.000Z',
        // 01:00Z, earlier than the persisted mtime despite sorting after it.
        updatedAt: '2026-11-02T09:00:00+08:00',
      }),
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.updatedAt).toBe('2026-11-02T05:00:00.000Z');
  });

  it('treats a non-empty transcript that yields no records as unreadable', async () => {
    const cwd = await makeWorkspace();
    await seedBinding(cwd, SESSION_A, [101]);
    await fsp.writeFile(transcriptPath(cwd, SESSION_A), 'not jsonl\n', 'utf8');
    captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: true });
  });

  it('resolves session storage from the runtime it was handed, not the ambient base', async () => {
    const cwd = await makeWorkspace();
    const otherBase = await fsp.mkdtemp(path.join(runtimeDir, 'other-base-'));
    const chats = path.join(
      new Storage(cwd, otherBase).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chats, { recursive: true });
    await fsp.writeFile(
      path.join(chats, `${SESSION_A}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_A}-user-1`,
        parentUuid: null,
        sessionId: SESSION_A,
        timestamp: '2026-11-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
        cwd,
      })}\n`,
      'utf8',
    );
    await upsertSessionPr(path.join(chats, `${SESSION_A}.pr.json`), {
      number: 101,
      url: 'https://github.com/acme/widgets/pull/101',
      state: 'open',
    });
    const runtime = {
      ...makeRuntime(cwd),
      sessionRuntimeBaseDir: otherBase,
    } as WorkspaceRuntime;

    const body = await fetchBindings([makeEntry(runtime)]);

    expect(body.partial).toBe(false);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
  });

  it('skips a sidecar that vanishes between the listing and the read', async () => {
    const cwd = await makeWorkspace();
    await fsp.mkdir(chatsDirFor(cwd), { recursive: true });
    // A dangling symlink lists under the sidecar name but reads as ENOENT.
    await fsp.symlink(
      path.join(chatsDirFor(cwd), 'missing-target.pr.json'),
      sidecarPath(cwd, SESSION_A),
    );

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
  });

  it('does not re-list a session with an unreadable sidecar from the bridge subset', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await corruptSidecar(cwd, SESSION_A);
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [{ number: 102, url: 'https://github.com/acme/widgets/pull/102' }],
      }),
    ]);
    captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    // The session's persisted bindings are unknown: listing its live subset
    // would make it look enumerated and cost it the bindings the adapter
    // retains across partial answers.
    expect(body).toEqual({ bindings: [], partial: true });
  });

  it('counts a live-only session in the diagnostic denominator when its transcript is unreadable', async () => {
    const cwd = await makeWorkspace();
    await fsp.mkdir(transcriptPath(cwd, SESSION_A), { recursive: true });
    liveSessions.set(cwd, [
      liveSummary(cwd, SESSION_A, {
        prs: [{ number: 55, url: 'https://github.com/acme/widgets/pull/55' }],
      }),
    ]);
    const lines = captureStderr();

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: true });
    expect(lines).toContainEqual(
      expect.stringContaining('1 of 1 sessions could not be read'),
    );
  });

  it('routes registry failures through sendBridgeError', async () => {
    const { app, sendBridgeError } = appHarness({
      entries: [],
      registryError: new Error('registry down'),
    });

    const res = await request(app).get('/sessions/pr-bindings');

    expect(res.status).toBe(500);
    expect(sendBridgeError).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Error),
      { route: 'GET /sessions/pr-bindings' },
    );
  });
});
