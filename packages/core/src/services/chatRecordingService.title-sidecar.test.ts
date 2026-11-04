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
import { ChatRecordingService } from './chatRecordingService.js';
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

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-recording-title-'));
    projectDir = path.join(root, '.qwen', 'projects', 'test-project');
    mkdirSync(path.join(projectDir, 'chats'), { recursive: true });
    sidecarPath = sessionTitleSidecarPath(
      path.join(projectDir, 'chats'),
      SESSION_ID,
    );
    const config = {
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
    } as unknown as Config;
    service = new ChatRecordingService(
      config,
      undefined,
      /* writerLeaseRequired */ false,
    );
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
});
