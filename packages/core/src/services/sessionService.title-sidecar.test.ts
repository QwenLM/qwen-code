/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
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

  it('drops the sidecar together with the session', async () => {
    writeHeadlessTranscript([record('system', { subtype: 'ui_telemetry' })]);
    writeSessionTitleSidecar(sidecarPath, 'CI 验证与复验', 'manual');

    await expect(service.removeSession(SESSION_ID)).resolves.toBe(true);
    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
  });
});
