/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
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
    const newCwd = path.join(root, 'moved-project');
    fs.mkdirSync(oldCwd);
    fs.mkdirSync(newCwd);
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
    const projectTempDir = fixture.oldStorage.getProjectTempDir();
    fs.mkdirSync(projectTempDir, { recursive: true });
    const tempSentinel = path.join(projectTempDir, 'unrelated-project-data');
    fs.writeFileSync(tempSentinel, 'leave me');
    fs.rmSync(fixture.oldCwd, { recursive: true });

    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    await fixture.service.relinkSession(lookup.candidate);

    const newChatsDir = path.dirname(
      fixture.service.getSessionTranscriptPath(SESSION_ID),
    );
    expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(prPath)).toBe(false);
    expect(fs.existsSync(ledgerPath)).toBe(false);
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
    await service.relinkSession(lookup.candidate);

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

  it('does not move anything when a target sidecar already exists', async () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.oldCwd, { recursive: true });
    const lookup = await fixture.service.findRelinkCandidate(SESSION_ID);
    expect(lookup.status).toBe('candidate');
    if (lookup.status !== 'candidate') throw new Error('expected candidate');
    const targetChatsDir = path.dirname(
      fixture.service.getSessionTranscriptPath(SESSION_ID),
    );
    fs.mkdirSync(targetChatsDir, { recursive: true });
    const targetSidecar = path.join(targetChatsDir, `${SESSION_ID}.pr.json`);
    fs.writeFileSync(targetSidecar, '{"number":99}\n');

    await expect(
      fixture.service.relinkSession(lookup.candidate),
    ).rejects.toThrow('already exists');
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

  it('refuses an invalid transcript', async () => {
    const fixture = makeFixture();
    fs.appendFileSync(fixture.transcriptPath, '{truncated');
    fs.rmSync(fixture.oldCwd, { recursive: true });

    await expect(
      fixture.service.findRelinkCandidate(SESSION_ID),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'invalid_transcript',
    });
  });
});
