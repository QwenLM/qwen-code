/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonRestoredSession } from '@qwen-code/sdk';
import { createSessionResumeRoute } from './sessionResume.js';
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

const SID = 'a'.repeat(36);

let gateway: Server | undefined;
const tmpDirs: string[] = [];

/** Real existing directory for tests that exercise the cwd-must-exist check. */
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: Pick<SessionDaemon, 'resumeSession'>,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tkn-owner',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/session/:id/resume', createSessionResumeRoute(daemon, audit));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function pollAudit(
  audit: ReturnType<typeof fakeAudit>,
  action: string,
): Promise<AuditEntry | undefined> {
  const deadline = Date.now() + 2000;
  while (
    !audit.calls.some((c) => c.action === action) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return audit.calls.find((c) => c.action === action);
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A fake pool whose resumeSession echoes back a restored session. */
function fakePool(): Pick<SessionDaemon, 'resumeSession'> & {
  calls: Array<{ sessionId: string; workspaceCwd: string }>;
} {
  const calls: Array<{ sessionId: string; workspaceCwd: string }> = [];
  return {
    calls,
    async resumeSession(sessionId, req) {
      calls.push({ sessionId, workspaceCwd: req.workspaceCwd });
      return {
        sessionId,
        workspaceCwd: req.workspaceCwd,
        attached: true,
        state: {},
      } satisfies DaemonRestoredSession;
    },
  };
}

/** A pool whose resumeSession must never be called (used to prove the
 * cwd-validation 400 fires before any daemon call). */
function unreachablePool(): Pick<SessionDaemon, 'resumeSession'> {
  return {
    async resumeSession() {
      throw new Error('resumeSession must not be called');
    },
  };
}

describe('POST /session/:id/resume', () => {
  it('resumes and returns the reactivated session id + workspace', async () => {
    const projDir = makeTmpDir('qwen-session-resume-proj-');
    const pool = fakePool();
    const url = await mountGateway(pool);

    const res = await fetch(
      `${url}/session/${SID}/resume`,
      post({ cwd: projDir }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      workspaceCwd: string;
    };
    expect(body).toMatchObject({ sessionId: SID, workspaceCwd: projDir });
    expect(pool.calls).toEqual([{ sessionId: SID, workspaceCwd: projDir }]);
  });

  it('rejects a malformed session id with 404 session_not_found before any pool call', async () => {
    const pool = unreachablePool();
    const url = await mountGateway(pool);

    const res = await fetch(
      `${url}/session/${encodeURIComponent('../etc/passwd')}/resume`,
      post({ cwd: '/tmp' }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('rejects a non-existent cwd with 400 invalid_workspace before any pool call', async () => {
    const pool = unreachablePool();
    const url = await mountGateway(pool);

    const res = await fetch(
      `${url}/session/${SID}/resume`,
      post({ cwd: '/does/not/exist' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_workspace');
  });

  it('rejects a missing cwd with 400 invalid_workspace before any pool call', async () => {
    const pool = unreachablePool();
    const url = await mountGateway(pool);

    const res = await fetch(`${url}/session/${SID}/resume`, post({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_workspace');
  });

  it('maps WorkspacePoolFullError to 503 workspace_pool_full', async () => {
    const dir = makeTmpDir('qwen-session-resume-full-');
    const fullPool: Pick<SessionDaemon, 'resumeSession'> = {
      async resumeSession() {
        throw new WorkspacePoolFullError(3);
      },
    };
    const url = await mountGateway(fullPool);

    const res = await fetch(`${url}/session/${SID}/resume`, post({ cwd: dir }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_pool_full');
  });

  it('maps a daemon "not found" error to 404 session_not_found', async () => {
    const dir = makeTmpDir('qwen-session-resume-missing-');
    const notFoundPool: Pick<SessionDaemon, 'resumeSession'> = {
      async resumeSession() {
        const err = new Error('session not found') as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      },
    };
    const url = await mountGateway(notFoundPool);

    const res = await fetch(`${url}/session/${SID}/resume`, post({ cwd: dir }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('returns 502 daemon_unavailable for any other pool failure', async () => {
    const dir = makeTmpDir('qwen-session-resume-err-');
    const brokenPool: Pick<SessionDaemon, 'resumeSession'> = {
      async resumeSession() {
        throw new Error('boom');
      },
    };
    const url = await mountGateway(brokenPool);

    const res = await fetch(`${url}/session/${SID}/resume`, post({ cwd: dir }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });

  it('audits session_resumed with the id + never the cwd path', async () => {
    const secretDir = makeTmpDir('qwen-session-resume-secret-');
    const pool = fakePool();
    const audit = fakeAudit();
    const url = await mountGateway(pool, audit);

    await fetch(`${url}/session/${SID}/resume`, post({ cwd: secretDir }));

    const row = await pollAudit(audit, 'session_resumed');
    expect(row).toBeDefined();
    expect(row!.actorTokenId).toBe('tkn-owner');
    expect(row!.target).toBe(SID);
    // Path hygiene: the cwd must never reach the audit record.
    expect(JSON.stringify(row)).not.toContain(secretDir);
  });
});
