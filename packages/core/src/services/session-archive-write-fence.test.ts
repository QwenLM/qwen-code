/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { acquireSessionArchiveWriteLock } from './session-archive-write-fence.js';
import { readSessionTitleSidecar } from './session-title-sidecar.js';
import { SessionService } from './sessionService.js';
import { SessionTranscriptChangedError } from './session-writer-lease.js';

const sessionId = '550e8400-e29b-41d4-a716-446655440000';

describe('archive fences legacy transcript writers', () => {
  let root: string;
  let service: SessionService;
  let livePath: string;
  let archivedPath: string;
  let liveTitlePath: string;
  let archivedTitlePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-writer-'));
    service = new SessionService(root, {
      runtimeBaseDir: path.join(root, 'runtime'),
    });
    livePath = service.getSessionTranscriptPath(sessionId);
    archivedPath = path.join(
      path.dirname(livePath),
      'archive',
      path.basename(livePath),
    );
    liveTitlePath = livePath.replace(/\.jsonl$/, '.title.json');
    archivedTitlePath = archivedPath.replace(/\.jsonl$/, '.title.json');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function recorder(resume?: { records: ChatRecord[]; tail: string }) {
    return new ChatRecordingService(
      {
        getSessionId: () => sessionId,
        getProjectRoot: () => root,
        getCliVersion: () => 'test',
        storage: {
          getProjectDir: () => path.dirname(path.dirname(livePath)),
          getRuntimeBaseDir: () => path.join(root, 'runtime'),
        },
        getSessionService: () => service,
        getResumedSessionData: () =>
          resume
            ? {
                conversation: { messages: resume.records },
                lastCompletedUuid: resume.tail,
              }
            : undefined,
        getModel: () => 'test-model',
        getAuthType: () => 'openai',
        getApprovalMode: () => 'default',
      } as unknown as Config,
      undefined,
      false,
    );
  }

  async function seed() {
    const writer = recorder();
    writer.recordUserMessage([{ text: 'First prompt' }]);
    writer.recordUserMessage([{ text: 'Second prompt' }]);
    await writer.flush();
    const content = fs.readFileSync(livePath, 'utf8');
    expect(readSessionTitleSidecar(liveTitlePath)?.displayName).toBe(
      'First prompt',
    );
    return { writer, content };
  }

  it('does not resurrect the active transcript or title after another service archives it', async () => {
    const { writer, content } = await seed();
    const other = new SessionService(root, {
      runtimeBaseDir: path.join(root, 'runtime'),
    });
    expect((await other.archiveSessions([sessionId])).archived).toEqual([
      sessionId,
    ]);

    await expect(
      writer.recordCustomTitle('Late automatic title', 'auto'),
    ).resolves.toBe(false);
    await expect(writer.flush()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    expect(fs.existsSync(livePath)).toBe(false);
    expect(fs.existsSync(liveTitlePath)).toBe(false);
    expect(fs.readFileSync(archivedPath, 'utf8')).toBe(content);
    expect(readSessionTitleSidecar(archivedTitlePath)?.displayName).toBe(
      'First prompt',
    );
  });

  it('fences a previously loaded recorder after explicit unarchive and permits a fresh resume', async () => {
    const { writer, content } = await seed();
    const records = content
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    const tail = records.at(-1)!.uuid;
    const oldUnwrittenResume = recorder({ records, tail });
    expect((await service.archiveSessions([sessionId])).archived).toEqual([
      sessionId,
    ]);
    expect((await service.unarchiveSessions([sessionId])).unarchived).toEqual([
      sessionId,
    ]);

    writer.recordUserMessage([{ text: 'Stale prompt' }]);
    await expect(writer.flush()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await expect(
      oldUnwrittenResume.recordCustomTitle('Also stale', 'auto'),
    ).resolves.toBe(false);
    expect(fs.readFileSync(livePath, 'utf8')).toBe(content);

    const restored = recorder({ records, tail });
    await expect(
      restored.recordCustomTitle('Restored title', 'manual'),
    ).resolves.toBe(true);
    await restored.flush();
    const title = JSON.parse(
      fs.readFileSync(livePath, 'utf8').trimEnd().split('\n').at(-1)!,
    ) as ChatRecord;
    expect(title).toMatchObject({ parentUuid: tail, subtype: 'custom_title' });
    expect(readSessionTitleSidecar(liveTitlePath)?.displayName).toBe(
      'Restored title',
    );
    expect(fs.existsSync(archivedPath)).toBe(false);
  });

  it('does not let a pre-archive recorder obtain a writer lease after restore', async () => {
    const { writer, content } = await seed();
    const before = await writer.getMessageGroups();
    expect(before.groups.length).toBeGreaterThan(0);
    expect((await service.archiveSessions([sessionId])).archived).toEqual([
      sessionId,
    ]);
    expect((await service.unarchiveSessions([sessionId])).unarchived).toEqual([
      sessionId,
    ]);

    await expect(
      writer.deleteMessageGroups({
        snapshot: before.snapshot,
        groupIds: [before.groups[0]!.id],
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
    expect(writer.hasWriteOwnership()).toBe(false);
    expect(fs.readFileSync(livePath, 'utf8')).toBe(content);
  });

  it('keeps a completed archive fenced when the archived copy is later deleted', async () => {
    const { writer } = await seed();
    expect((await service.archiveSessions([sessionId])).archived).toEqual([
      sessionId,
    ]);
    expect((await service.removeSessions([sessionId])).removed).toEqual([
      sessionId,
    ]);

    await expect(
      writer.recordCustomTitle('Late title after delete', 'auto'),
    ).resolves.toBe(false);
    expect(fs.existsSync(livePath)).toBe(false);
    expect(fs.existsSync(liveTitlePath)).toBe(false);
    expect(fs.existsSync(archivedPath)).toBe(false);
  });

  it('waits for an ordinary fence holder without losing a first prompt', async () => {
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    const lock = await acquireSessionArchiveWriteLock(livePath);
    const writer = recorder();
    try {
      writer.recordUserMessage([{ text: 'First prompt while busy' }]);
      expect(fs.existsSync(livePath)).toBe(false);
    } finally {
      await lock.release();
    }
    await writer.flush();
    expect(fs.readFileSync(livePath, 'utf8')).toContain(
      'First prompt while busy',
    );
    expect(readSessionTitleSidecar(liveTitlePath)?.displayName).toBe(
      'First prompt while busy',
    );
  });

  it('serializes a title queued while archive is inside the move boundary', async () => {
    const { writer, content } = await seed();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const archive = service.archiveSessions([sessionId], {
      async assertStorageUnchanged() {
        enter();
        await resumed;
      },
    });
    await entered;
    const lateTitle = writer.recordCustomTitle('Contending title', 'auto');
    resume();

    expect((await archive).archived).toEqual([sessionId]);
    await expect(lateTitle).resolves.toBe(false);
    expect(fs.readFileSync(archivedPath, 'utf8')).toBe(content);
    expect(fs.existsSync(livePath)).toBe(false);
    expect(fs.existsSync(liveTitlePath)).toBe(false);
  });
});
