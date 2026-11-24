/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { AuthType } from '../utils/auth-type.js';
import { ChatRecordingService } from './chatRecordingService.js';

vi.mock('node:child_process');

// Permissions are an OS-level property, so these cases drive the recorder
// against a real temporary directory instead of the mocked fs the rest of the
// suite uses. They cover the three ways a transcript can come into existence:
// fresh creation, appending to a file an earlier version left world-readable,
// and recreation after the file disappears mid-session.
describe('ChatRecordingService transcript permissions', () => {
  const sessionId = 'permission-probe-session';
  let projectDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('main\n');
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chat-perms-'));
    transcriptPath = path.join(projectDir, 'chats', `${sessionId}.jsonl`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const buildService = () =>
    new ChatRecordingService(
      {
        getSessionId: () => sessionId,
        getProjectRoot: () => projectDir,
        getCliVersion: () => '0.0.0-test',
        storage: {
          getProjectDir: () => projectDir,
          getProjectTempDir: () => projectDir,
        },
        getModel: () => 'test-model',
        getAuthType: () => AuthType.USE_GEMINI,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getFastModel: () => undefined,
        isInteractive: () => false,
        getDebugMode: () => false,
        getToolRegistry: () => ({ getTool: () => undefined }),
        getResumedSessionData: () => undefined,
        getSessionService: () => vi.fn(),
      } as unknown as Config,
      undefined,
      false,
    );

  const modeOf = (filePath: string) => fs.statSync(filePath).mode & 0o777;

  const appendOneTurn = async (service: ChatRecordingService) => {
    service.recordUserMessage([{ text: 'permission probe' }]);
    await service.flush();
  };

  it('creates the transcript with owner-only permissions', async () => {
    await appendOneTurn(buildService());

    expect(modeOf(transcriptPath)).toBe(0o600);
  });

  it('tightens a world-readable transcript left by an earlier version', async () => {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '', { flag: 'wx', mode: 0o644 });

    await appendOneTurn(buildService());

    expect(modeOf(transcriptPath)).toBe(0o600);
  });

  it('recreates a transcript deleted mid-session with owner-only permissions', async () => {
    const service = buildService();
    await appendOneTurn(service);
    expect(modeOf(transcriptPath)).toBe(0o600);

    fs.rmSync(transcriptPath);
    await appendOneTurn(service);

    expect(modeOf(transcriptPath)).toBe(0o600);
  });
});
