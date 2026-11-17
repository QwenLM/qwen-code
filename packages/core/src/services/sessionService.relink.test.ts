/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import * as processLiveness from '../utils/process-liveness.js';
import { SessionService } from './sessionService.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('SessionService project relinking', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeFixture(name = 'old-project') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-relink-'));
    roots.push(root);
    const runtimeBaseDir = path.join(root, 'runtime');
    const oldCwd = path.join(root, name);
    // Keep the destination at a different depth so an external cwd would
    // visibly change if remapRelinkPath lost its parent-path guard.
    const newCwd = path.join(root, 'moved', 'project');
    fs.mkdirSync(oldCwd);
    fs.mkdirSync(newCwd, { recursive: true });
    const oldStorage = new Storage(oldCwd, runtimeBaseDir);
    const oldChatsDir = path.join(oldStorage.getProjectDir(), 'chats');
    fs.mkdirSync(oldChatsDir, { recursive: true });
    const transcriptPath = path.join(oldChatsDir, `${SESSION_ID}.jsonl`);
    const records = [
      {
        sessionId: SESSION_ID,
        uuid: 'first',
        parentUuid: null,
        type: 'user',
        cwd: oldCwd,
        timestamp: '2026-09-24T00:00:00.000Z',
        message: { role: 'user', parts: [{ text: 'keep every field' }] },
        unknownFutureField: { preserved: true },
      },
      {
        sessionId: SESSION_ID,
        uuid: 'second',
        parentUuid: 'first',
        type: 'assistant',
        cwd: path.join(oldCwd, 'packages', 'app'),
        timestamp: '2026-09-24T00:00:01.000Z',
        message: { role: 'model', parts: [{ text: 'done' }] },
      },
      {
        sessionId: SESSION_ID,
        uuid: 'third',
        parentUuid: 'second',
        type: 'assistant',
        cwd: path.join(root, 'unrelated-project'),
        timestamp: '2026-09-24T00:00:02.000Z',
        message: { role: 'model', parts: [{ text: 'external path' }] },
      },
    ];
    fs.writeFileSync(
      transcriptPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    return {
      root,
      runtimeBaseDir,
      oldCwd,
      newCwd,
      oldStorage,
      oldChatsDir,
      transcriptPath,
      service: new SessionService(newCwd, { runtimeBaseDir }),
    };
  }

  it('moves a unique session and its sidecars while preserving its contents', async () => {
    const fixture = makeFixture();
    const runtimePath = path.join(
      fixture.oldChatsDir,
      `${SESSION_ID}.runtime.json`,
    );
    const worktreePath = path.join(
      fixture.oldChatsDir,
      `${SESSION_ID}.worktree.json`,
    );
    const prPath = path.join(fixture.oldChatsDir, `${SESSION_ID}.pr.json`);
    const ledgerPath = path.join(
      fixture.oldChatsDir,
      `${SESSION_ID}.ledger.jsonl`,
    );
    const titlePath = path.join(
      fixture.oldChatsDir,
      `${SESSION_ID}.title.json`,
    );
    fs.writeFileSync(
      runtimePath,
      JSON.stringify({
        schema_version: 1,
        pid: 2147483647,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
      }),
    );
    fs.writeFileSync(
      worktreePath,
      JSON.stringify({
        worktreePath: path.join(fixture.oldCwd, '.qwen', 'worktrees', 'one'),
        originalCwd: fixture.oldCwd,
        workspaceCwd: path.join(fixture.oldCwd, 'packages', 'app'),
      }),
    );
    fs.writeFileSync(prPath, '{"number":42}\n');
    fs.writeFileSync(ledgerPath, '{"event":"terminal"}\n');
    fs.writeFileSync(
      titlePath,
      '{"version":1,"displayName":"kept title","source":"manual","updatedAt":"2026-09-24T00:00:00.000Z"}\n',
    );
    const projectTempDir = fixture.oldStorage.getProjectTempDir();
    fs.mkdirSync(projectTempDir, { recursive: true });
    const tempSentinel = path.join(projectTempDir, 'unrelated-project-data');
    fs.writeFileSync(tempSentinel, 'leave me');
    fs.rmSync(fixture.oldCwd, { recursive: true });

    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    await expect(
      fixture.service.relinkSession(lookup.candidate),
    ).resolves.toEqual({ status: 'relinked' });

    const newChatsDir = path.dirname(
      fixture.service.getSessionTranscriptPath(SESSION_ID),
    );
    expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(prPath)).toBe(false);
    expect(fs.existsSync(ledgerPath)).toBe(false);
    expect(fs.existsSync(titlePath)).toBe(false);
    expect(fs.readFileSync(tempSentinel, 'utf8')).toBe('leave me');

    const migratedRecords = fs
      .readFileSync(path.join(newChatsDir, `${SESSION_ID}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(migratedRecords[0]['cwd']).toBe(fixture.newCwd);
    expect(migratedRecords[0]['unknownFutureField']).toEqual({
      preserved: true,
    });
    expect(migratedRecords[1]['cwd']).toBe(
      path.join(fixture.newCwd, 'packages', 'app'),
    );
    expect(migratedRecords[2]['cwd']).toBe(
      path.join(fixture.root, 'unrelated-project'),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(newChatsDir, `${SESSION_ID}.runtime.json`),
          'utf8',
        ),
      ).work_dir,
    ).toBe(fixture.newCwd);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(newChatsDir, `${SESSION_ID}.worktree.json`),
          'utf8',
        ),
      ).workspaceCwd,
    ).toBe(path.join(fixture.newCwd, 'packages', 'app'));
    expect(
      fs.readFileSync(path.join(newChatsDir, `${SESSION_ID}.pr.json`), 'utf8'),
    ).toBe('{"number":42}\n');
    expect(
      fs.readFileSync(
        path.join(newChatsDir, `${SESSION_ID}.ledger.jsonl`),
        'utf8',
      ),
    ).toBe('{"event":"terminal"}\n');
    expect(
      fs.readFileSync(
        path.join(newChatsDir, `${SESSION_ID}.title.json`),
        'utf8',
      ),
    ).toContain('"displayName":"kept title"');
    await expect(
      fixture.service.loadSession(SESSION_ID),
    ).resolves.toBeDefined();
  });

  it('refuses to relink while the recorded source directory still exists', async () => {
    const fixture = makeFixture();
    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'source_directory_exists',
      recordedCwd: fixture.oldCwd,
    });
  });

  it('rewrites ownership in place when old and new paths share a storage key', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-relink-collision-'),
    );
    roots.push(root);
    const runtimeBaseDir = path.join(root, 'runtime');
    const oldCwd = path.join(root, 'project-one');
    const newCwd = path.join(root, 'project', 'one');
    fs.mkdirSync(oldCwd);
    fs.mkdirSync(newCwd, { recursive: true });
    const oldStorage = new Storage(oldCwd, runtimeBaseDir);
    const newStorage = new Storage(newCwd, runtimeBaseDir);
    expect(oldStorage.getProjectDir()).toBe(newStorage.getProjectDir());
    const chatsDir = path.join(oldStorage.getProjectDir(), 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const transcriptPath = path.join(chatsDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        sessionId: SESSION_ID,
        uuid: 'first',
        parentUuid: null,
        type: 'user',
        cwd: oldCwd,
        timestamp: '2026-09-24T00:00:00.000Z',
        message: { role: 'user', parts: [{ text: 'collision' }] },
      })}\n`,
    );
    fs.rmSync(oldCwd, { recursive: true });
    const service = new SessionService(newCwd, { runtimeBaseDir });

    const lookup = await service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    await expect(service.relinkSession(lookup.candidate)).resolves.toEqual({
      status: 'relinked',
    });

    expect(service.getSessionTranscriptPath(SESSION_ID)).toBe(transcriptPath);
    const record = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as {
      cwd: string;
    };
    expect(record.cwd).toBe(newCwd);
    await expect(service.getSessionLocation(SESSION_ID)).resolves.toBe(
      'active',
    );
  });

  it('refuses ambiguous UUID matches', async () => {
    const first = makeFixture('first-old-project');
    const secondOldCwd = path.join(first.root, 'second-old-project');
    const secondStorage = new Storage(secondOldCwd, first.runtimeBaseDir);
    const secondChatsDir = path.join(secondStorage.getProjectDir(), 'chats');
    fs.mkdirSync(secondChatsDir, { recursive: true });
    const firstContents = fs.readFileSync(first.transcriptPath, 'utf8');
    fs.writeFileSync(
      path.join(secondChatsDir, `${SESSION_ID}.jsonl`),
      firstContents.replaceAll(first.oldCwd, secondOldCwd),
    );
    fs.rmSync(first.oldCwd, { recursive: true });

    await expect(
      first.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('reports a target sidecar conflict before confirmation', async () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const targetChatsDir = path.dirname(
      fixture.service.getSessionTranscriptPath(SESSION_ID),
    );
    fs.mkdirSync(targetChatsDir, { recursive: true });
    const targetSidecar = path.join(targetChatsDir, `${SESSION_ID}.pr.json`);
    fs.writeFileSync(targetSidecar, '{"number":99}\n');

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'target_conflict' });
    expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
    expect(
      fs.existsSync(fixture.service.getSessionTranscriptPath(SESSION_ID)),
    ).toBe(false);
    expect(fs.readFileSync(targetSidecar, 'utf8')).toBe('{"number":99}\n');
  });

  it('refuses a session with a live runtime writer', async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.runtime.json`),
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
      }),
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'active_writer' });
  });

  it('treats a runtime writer from another host as active', async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.runtime.json`),
      JSON.stringify({
        schema_version: 1,
        pid: 2147483647,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: 'another-host.example',
        started_at: 1,
        qwen_version: null,
      }),
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'active_writer' });
  });

  it('treats a runtime writer from another PID namespace as active', async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.runtime.json`),
      JSON.stringify({
        schema_version: 1,
        pid: 2147483647,
        proc_start: 'foreign-start',
        pid_ns: -1,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
      }),
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'active_writer' });
  });

  it('does not treat a recycled PID as the original writer', async () => {
    const fixture = makeFixture();
    const procStart = vi
      .spyOn(processLiveness, 'readProcStartToken')
      .mockReturnValue('actual-process-start');
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.runtime.json`),
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        proc_start: 'definitely-not-this-process',
        pid_ns: null,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
      }),
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    try {
      await expect(
        fixture.service.findRelinkCandidate(SESSION_ID),
      ).resolves.toMatchObject({ status: 'candidate' });
    } finally {
      procStart.mockRestore();
    }
  });

  it('refuses a hard-linked transcript', async () => {
    const fixture = makeFixture();
    fs.linkSync(fixture.transcriptPath, `${fixture.transcriptPath}.link`);
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'scan_incomplete' });
  });

  it('refuses a transcript containing another session ID', async () => {
    const fixture = makeFixture();
    fs.appendFileSync(
      fixture.transcriptPath,
      `${JSON.stringify({
        sessionId: '22222222-2222-4222-8222-222222222222',
        uuid: 'foreign',
        parentUuid: 'third',
        type: 'assistant',
        cwd: fixture.oldCwd,
        timestamp: '2026-09-24T00:00:03.000Z',
        message: { role: 'model', parts: [{ text: 'foreign session' }] },
      })}\n`,
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'invalid_transcript',
    });
  });

  it('refuses a transcript stored under a different project directory', async () => {
    const fixture = makeFixture();
    const wrongStorage = new Storage(
      path.join(fixture.root, 'different-project'),
      fixture.runtimeBaseDir,
    );
    const wrongChatsDir = path.join(wrongStorage.getProjectDir(), 'chats');
    fs.mkdirSync(wrongChatsDir, { recursive: true });
    fs.renameSync(
      fixture.transcriptPath,
      path.join(wrongChatsDir, `${SESSION_ID}.jsonl`),
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'invalid_transcript',
    });
  });

  it('leaves managed sessions with their session authority', async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      fixture.transcriptPath,
      `${JSON.stringify({
        sessionId: SESSION_ID,
        uuid: 'managed-header',
        parentUuid: null,
        type: 'system',
        subtype: 'managed_session_header_v1',
        cwd: fixture.oldCwd,
        timestamp: '2026-09-24T00:00:00.000Z',
        managedSession: {
          sessionKey: {
            tenantId: 'local',
            workspaceId: 'old-workspace',
            sessionId: SESSION_ID,
          },
        },
      })}\n`,
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'managed_session' });
    expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
    expect(
      fs.existsSync(fixture.service.getSessionTranscriptPath(SESSION_ID)),
    ).toBe(false);
  });

  it('recovers the same truncated tail that normal session loading tolerates', async () => {
    const fixture = makeFixture();
    fs.appendFileSync(fixture.transcriptPath, '{truncated');
    fs.rmSync(fixture.oldCwd, { recursive: true });

    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    await expect(
      fixture.service.relinkSession(lookup.candidate),
    ).resolves.toEqual({ status: 'relinked' });
    await expect(
      fixture.service.loadSession(SESSION_ID),
    ).resolves.toBeDefined();
  });

  it('returns source_unavailable with read diagnostics', async () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    const readFile = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (filePath, options) => {
        if (filePath === fixture.transcriptPath) {
          throw Object.assign(new Error('permission denied'), {
            code: 'EACCES',
          });
        }
        return originalReadFile(filePath, options as never);
      });
    try {
      await expect(
        fixture.service.findRelinkCandidate(SESSION_ID),
      ).resolves.toMatchObject({
        status: 'blocked',
        reason: 'source_unavailable',
        detail: expect.stringContaining('permission denied'),
      });
    } finally {
      readFile.mockRestore();
    }
  });

  it('refuses a transcript appended after candidate lookup', async () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    fs.appendFileSync(fixture.transcriptPath, '\n');

    await expect(
      fixture.service.relinkSession(lookup.candidate),
    ).resolves.toEqual({
      status: 'blocked',
      result: { status: 'blocked', reason: 'source_unavailable' },
    });
    expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
  });

  it('returns the refreshed active-writer refusal', async () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.runtime.json`),
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        proc_start: null,
        pid_ns: null,
        session_id: SESSION_ID,
        work_dir: fixture.oldCwd,
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
      }),
    );

    await expect(
      fixture.service.relinkSession(lookup.candidate),
    ).resolves.toEqual({
      status: 'blocked',
      result: {
        status: 'blocked',
        reason: 'active_writer',
        recordedCwd: fixture.oldCwd,
      },
    });
    expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
  });

  it('rolls back a partial publish without leaving staging files', async () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.oldChatsDir, `${SESSION_ID}.pr.json`),
      '{"number":42}\n',
    );
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    const sourceBefore = fs.readFileSync(fixture.transcriptPath);
    const originalLink = fs.linkSync;
    let calls = 0;
    const link = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('forced publish failure');
      return originalLink(from, to);
    });
    try {
      await expect(
        fixture.service.relinkSession(lookup.candidate),
      ).rejects.toThrow('forced publish failure');
    } finally {
      link.mockRestore();
    }
    expect(fs.readFileSync(fixture.transcriptPath)).toEqual(sourceBefore);
    const targetChatsDir = path.dirname(
      fixture.service.getSessionTranscriptPath(SESSION_ID),
    );
    expect(
      fs.existsSync(fixture.service.getSessionTranscriptPath(SESSION_ID)),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(targetChatsDir, `${SESSION_ID}.pr.json`)),
    ).toBe(false);
    expect(
      fs.readdirSync(targetChatsDir).some((name) => name.includes('.relink-')),
    ).toBe(false);
  });
});
