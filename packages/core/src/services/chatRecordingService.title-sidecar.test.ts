/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import {
  readSessionTitleSidecar,
  sessionTitleSidecarPath,
} from './session-title-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('ChatRecordingService - list title sidecar', () => {
  let root: string;
  let projectDir: string;
  let service: ChatRecordingService;
  let sidecarPath: string;

  function makeConfig(overrides: Record<string, unknown> = {}): Config {
    return {
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
      ...overrides,
    } as unknown as Config;
  }

  const newService = (config = makeConfig()) =>
    new ChatRecordingService(
      config,
      undefined,
      /* writerLeaseRequired */ false,
    );

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-recording-title-'));
    projectDir = path.join(root, '.qwen', 'projects', 'test-project');
    mkdirSync(path.join(projectDir, 'chats'), { recursive: true });
    sidecarPath = sessionTitleSidecarPath(
      path.join(projectDir, 'chats'),
      SESSION_ID,
    );
    service = newService();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists the first prompt as the list label', () => {
    service.recordUserMessage([{ text: '  处理 CI 报错与复验  ' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '处理 CI 报错与复验',
      source: 'prompt',
    });
  });

  it('lets a rename replace the prompt label', async () => {
    service.recordUserMessage([{ text: '处理 CI 报错与复验' }]);
    await service.recordCustomTitle('CI 验证与复验', 'manual');

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('does not let a later prompt overwrite an explicit title', async () => {
    await service.recordCustomTitle('CI 验证与复验', 'manual');
    service.recordUserMessage([{ text: '继续看 CI' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('prefers the prompt display text over the wire text', () => {
    service.recordUserMessage([{ text: 'wire-only text' }], undefined, {
      displayText: '列表展示文本',
      hookContext: '',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '列表展示文本',
      source: 'prompt',
    });
  });

  it('does not invent a label from a text-less first prompt', () => {
    service.recordUserMessage([
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
    ]);

    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
  });

  it('truncates by code point with an ellipsis like the list reader', () => {
    service.recordUserMessage([{ text: 'a'.repeat(201) }]);

    expect(readSessionTitleSidecar(sidecarPath)?.displayName).toBe(
      `${'a'.repeat(200)}...`,
    );
  });

  it('seeds the prompt label when a session is resumed', () => {
    const prompt = '恢复后的首条 prompt';
    const resumed: ChatRecord = {
      uuid: 'resumed-user',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: prompt }] },
      systemPayload: { displayText: prompt },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [resumed] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: prompt,
      source: 'prompt',
    });
  });

  it('seeds an explicit title when a session is resumed', () => {
    const title: ChatRecord = {
      uuid: 'resumed-title',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'system',
      subtype: 'custom_title',
      cwd: root,
      version: '1.0.0',
      systemPayload: { customTitle: '恢复的自定义标题', titleSource: 'manual' },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [title] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '恢复的自定义标题',
      source: 'manual',
    });
  });
});
