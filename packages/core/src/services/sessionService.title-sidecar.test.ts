/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { SessionService } from './sessionService.js';
import {
  readSessionTitleSidecar,
  sessionTitleSidecarPath,
  writeSessionTitleSidecar,
} from './session-title-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function record(
  type: ChatRecord['type'],
  fields: Partial<ChatRecord> = {},
): ChatRecord {
  return {
    uuid: `${type}-${Math.random().toString(16).slice(2)}`,
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    type,
    cwd: '',
    version: '1.0.0',
    ...fields,
  };
}

describe('SessionService - title sidecar fallback', () => {
  let root: string;
  let service: SessionService;
  let transcriptPath: string;
  let sidecarPath: string;

  const writeHeadlessTranscript = (records: ChatRecord[]) => {
    writeFileSync(
      transcriptPath,
      `${records.map((r) => JSON.stringify({ ...r, cwd: root })).join('\n')}\n`,
      'utf8',
    );
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-title-fallback-'));
    service = new SessionService(root, {
      runtimeBaseDir: path.join(root, '.qwen'),
    });
    transcriptPath = service.getSessionTranscriptPath(SESSION_ID);
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    sidecarPath = sessionTitleSidecarPath(
      path.dirname(transcriptPath),
      SESSION_ID,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the first-prompt label after the transcript lost its head', async () => {
    // No `user` record in the head: the shape left behind when a missing
    // transcript is recreated mid-session.
    writeHeadlessTranscript([
      record('system', { subtype: 'ui_telemetry' }),
      record('tool_result'),
    ]);
    writeSessionTitleSidecar(sidecarPath, '处理 CI 报错与复验', 'prompt');

    const listed = await service.listSessions();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.prompt).toBe('处理 CI 报错与复验');
    expect(listed.items[0]!.customTitle).toBeUndefined();

    const item = await service.getSessionListItem(SESSION_ID);
    expect(item?.prompt).toBe('处理 CI 报错与复验');
    expect(await service.getSessionDisplayName(SESSION_ID)).toBe(
      '处理 CI 报错与复验',
    );
  });

  it('restores a renamed session title from the sidecar', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, 'CI 验证与复验', 'manual');

    expect(service.getSessionTitleInfo(SESSION_ID)).toEqual({
      title: 'CI 验证与复验',
      source: 'manual',
    });
    expect(service.getSessionTitle(SESSION_ID)).toBe('CI 验证与复验');

    const listed = await service.listSessions();
    expect(listed.items[0]!.customTitle).toBe('CI 验证与复验');
    expect(listed.items[0]!.titleSource).toBe('manual');
  });

  it('prefers a title that is still present in the transcript', async () => {
    writeHeadlessTranscript([
      record('system', { subtype: 'ui_telemetry' }),
      record('system', {
        subtype: 'custom_title',
        systemPayload: { customTitle: '新名字', titleSource: 'manual' },
      }),
    ]);
    writeSessionTitleSidecar(sidecarPath, '旧名字', 'manual');

    expect(service.getSessionTitleInfo(SESSION_ID)).toEqual({
      title: '新名字',
      source: 'manual',
    });
    const listed = await service.listSessions();
    expect(listed.items[0]!.customTitle).toBe('新名字');
  });

  it('persists a rename made through the service fallback path', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);

    await expect(service.renameSession(SESSION_ID, '手动改名')).resolves.toBe(
      true,
    );
    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '手动改名',
      source: 'manual',
    });
  });

  it('writes the title sidecar for a forked session', async () => {
    writeHeadlessTranscript([
      record('user', {
        message: { role: 'user', parts: [{ text: '源会话' }] },
      }),
    ]);
    const forkId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    await service.forkSession(SESSION_ID, forkId, { title: '分支标题' });

    expect(
      readSessionTitleSidecar(
        sessionTitleSidecarPath(path.dirname(transcriptPath), forkId),
      ),
    ).toMatchObject({ displayName: '分支标题', source: 'manual' });
  });

  it('moves the title sidecar through archive and unarchive', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, 'CI 验证与复验', 'manual');
    const archivedSidecar = sessionTitleSidecarPath(
      path.join(path.dirname(transcriptPath), 'archive'),
      SESSION_ID,
    );

    const archived = await service.archiveSessions([SESSION_ID]);
    expect(archived.archived).toEqual([SESSION_ID]);
    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
    expect(readSessionTitleSidecar(archivedSidecar)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
    // The archived list must read the name from the archived sidecar, not a
    // hard-coded 'active' state.
    const archivedList = await service.listSessions({
      archiveState: 'archived',
    });
    expect(archivedList.items[0]!.customTitle).toBe('CI 验证与复验');
    const archivedItem = await service.getSessionListItem(
      SESSION_ID,
      'archived',
    );
    expect(archivedItem!.customTitle).toBe('CI 验证与复验');

    const unarchived = await service.unarchiveSessions([SESSION_ID]);
    expect(unarchived.unarchived).toEqual([SESSION_ID]);
    expect(readSessionTitleSidecar(archivedSidecar)).toBeUndefined();
    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('drops the sidecar together with the session', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, 'CI 验证与复验', 'manual');
    const archivedSidecar = sessionTitleSidecarPath(
      path.join(path.dirname(transcriptPath), 'archive'),
      SESSION_ID,
    );
    mkdirSync(path.dirname(archivedSidecar), { recursive: true });
    writeSessionTitleSidecar(archivedSidecar, '归档的旧名字', 'manual');

    await expect(service.removeSession(SESSION_ID)).resolves.toBe(true);
    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
    expect(readSessionTitleSidecar(archivedSidecar)).toBeUndefined();
  });

  it('still reports a conflict archive as done when the sidecar move fails', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, '冲突会话', 'manual');
    const archiveDir = path.join(path.dirname(transcriptPath), 'archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      path.join(archiveDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({
        ...record('system', { subtype: 'ui_telemetry' }),
        cwd: root,
      })}\n`,
      'utf8',
    );
    // The kept side has no sidecar, so the dropped one is renamed into a
    // directory that cannot accept it: only the reconcile step fails.
    chmodSync(archiveDir, 0o555);
    try {
      const result = await service.archiveSessions([SESSION_ID], {
        resolveConflicts: true,
      });
      expect(result.archived).toEqual([SESSION_ID]);
      expect(result.resolvedConflicts).toEqual([SESSION_ID]);
      expect(result.errors).toEqual([]);
    } finally {
      chmodSync(archiveDir, 0o755);
    }
  });

  it('carries the source sidecar into a fork made without a title', async () => {
    const headless = record('system', { subtype: 'ui_telemetry' });
    writeHeadlessTranscript([headless]);
    writeSessionTitleSidecar(sidecarPath, '无头的源会话', 'manual');
    const forkId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    await service.forkSession(SESSION_ID, forkId);

    expect(
      readSessionTitleSidecar(
        sessionTitleSidecarPath(path.dirname(transcriptPath), forkId),
      ),
    ).toMatchObject({ displayName: '无头的源会话', source: 'manual' });
  });

  it('finds a session whose name lives only in the sidecar', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, 'CI 验证与复验', 'manual');

    const matches = await service.findSessionsByTitle('CI 验证与复验');
    expect(matches.map((item) => item.sessionId)).toEqual([SESSION_ID]);
    expect(await service.findSessionTitlesByPrefix('ci')).toContain(
      'CI 验证与复验',
    );
  });

  it('does not return another project prompt from the sidecar', async () => {
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        ...record('system', { subtype: 'ui_telemetry' }),
        cwd: path.join(tmpdir(), 'qwen-other-project'),
      })}\n`,
      'utf8',
    );
    writeSessionTitleSidecar(sidecarPath, '别的项目的 prompt', 'prompt');

    expect(await service.getSessionDisplayName(SESSION_ID)).toBeUndefined();
  });

  it('returns the sidecar name when the transcript read fails', async () => {
    mkdirSync(transcriptPath, { recursive: true });
    writeSessionTitleSidecar(sidecarPath, '读失败仍保留', 'manual');

    expect(await service.getSessionDisplayName(SESSION_ID)).toBe(
      '读失败仍保留',
    );
  });

  it('drives the writer and the reader through one filesystem', async () => {
    const projectDir = path.dirname(path.dirname(transcriptPath));
    const recorder = new ChatRecordingService(
      {
        getSessionId: () => SESSION_ID,
        getProjectRoot: () => root,
        getCliVersion: () => '1.0.0',
        getModel: () => 'test-model',
        getAuthType: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getFastModel: () => undefined,
        isInteractive: () => false,
        getDebugMode: () => false,
        getResumedSessionData: () => undefined,
        storage: {
          getProjectDir: () => projectDir,
          getProjectTempDir: () => path.join(root, '.qwen', 'tmp'),
        },
      } as unknown as Config,
      undefined,
      /* writerLeaseRequired */ false,
    );

    recorder.recordUserMessage([{ text: '端到端 prompt' }]);
    await recorder.flush();
    // The writer's own transcript exists at the path the reader uses; losing
    // its head must leave the label the writer persisted.
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);

    const listed = await service.listSessions();
    expect(listed.items[0]!.prompt).toBe('端到端 prompt');
    const item = await service.getSessionListItem(SESSION_ID);
    expect(item!.prompt).toBe('端到端 prompt');
  });
});
