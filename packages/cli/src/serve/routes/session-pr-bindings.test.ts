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

beforeEach(async () => {
  runtimeDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-pr-bindings-runtime-'),
  );
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  liveSessions = new Map();
});

afterEach(async () => {
  delete process.env['QWEN_RUNTIME_DIR'];
  await fsp.rm(runtimeDir, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(runtimeDir, 'work-'));
  return await fsp.realpath(cwd);
}

function chatsDirFor(cwd: string): string {
  return path.join(new Storage(cwd).getProjectDir(), 'chats');
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

async function fetchBindings(entries: WorkspaceEntry[]) {
  const { app } = appHarness({ entries });
  const res = await request(app).get('/sessions/pr-bindings');
  expect(res.status).toBe(200);
  return res.body as {
    bindings: Array<{
      sessionId: string;
      workspaceCwd: string;
      sourceType?: string;
      updatedAt?: string;
      prs: Array<{ number: number; url: string; state?: string }>;
    }>;
    partial: boolean;
  };
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

  it('emits a tombstone row for a well-formed empty sidecar', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, []);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(false);
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]?.prs).toEqual([]);
  });

  it('flags an unreadable sidecar as partial instead of an unbind', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);
    await seedTranscript(cwd, SESSION_B);
    await fsp.writeFile(
      path.join(chatsDirFor(cwd), `${SESSION_B}.pr.json`),
      '{not json',
      'utf8',
    );

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
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
      {
        sessionId: SESSION_A,
        workspaceCwd: cwd,
        createdAt: '2026-11-03T08:00:00.000Z',
        sourceType: 'web-shell',
        clientCount: 1,
        hasActivePrompt: false,
      },
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

  it('takes the later of the persisted and live activity timestamps', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A, {
      mtime: new Date('2026-11-02T12:00:00.000Z'),
    });
    await seedBinding(cwd, SESSION_A, [101]);
    liveSessions.set(cwd, [
      {
        sessionId: SESSION_A,
        workspaceCwd: cwd,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-03T09:00:00.000Z',
        clientCount: 1,
        hasActivePrompt: true,
      },
    ]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body.bindings[0]?.updatedAt).toBe('2026-11-03T09:00:00.000Z');
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

  it('scans a draining workspace that still has a runtime', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd), 'draining')]);

    expect(body.partial).toBe(false);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
  });

  it('flags partial when an entry has no current runtime', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);
    await seedBinding(cwd, SESSION_A, [101]);

    const body = await fetchBindings([
      makeEntry(undefined, 'transitioning'),
      makeEntry(makeRuntime(cwd)),
    ]);

    expect(body.partial).toBe(true);
    expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
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
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const body = await fetchBindings([
        makeEntry(makeRuntime(broken)),
        makeEntry(makeRuntime(healthy)),
      ]);
      expect(body.partial).toBe(true);
      expect(body.bindings.map((b) => b.sessionId)).toEqual([SESSION_A]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `PR bindings scan failed for workspace ${broken}`,
        ),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('treats a workspace without any sidecar as an authoritative absence', async () => {
    const cwd = await makeWorkspace();
    await seedTranscript(cwd, SESSION_A);

    const body = await fetchBindings([makeEntry(makeRuntime(cwd))]);

    expect(body).toEqual({ bindings: [], partial: false });
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
