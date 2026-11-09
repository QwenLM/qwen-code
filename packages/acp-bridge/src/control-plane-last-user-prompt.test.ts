/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { makeBridge, makeChannel } from './internal/testUtils.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const FIRST_PROMPT = '2026-01-01T00:00:00.000Z';
const NOTIFIED_PROMPT = '2026-02-02T00:00:00.000Z';
const SECOND_PROMPT = '2026-03-03T00:00:00.000Z';

describe('session control plane last user prompt memory', () => {
  let runtimeBaseDir: string;
  let workspaceCwd: string;
  let transcriptPath: string;

  beforeEach(async () => {
    runtimeBaseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-control-plane-prompt-'),
    );
    workspaceCwd = path.join(runtimeBaseDir, 'workspace');
    await fs.mkdir(workspaceCwd, { recursive: true });
    transcriptPath = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
      `${SESSION_ID}.jsonl`,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(runtimeBaseDir, { recursive: true, force: true });
  });

  function record(uuid: string, timestamp: string): string {
    return `${JSON.stringify({
      uuid,
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp,
      type: 'user',
      provenance: 'real_user',
      cwd: workspaceCwd,
      message: { role: 'user', parts: [{ text: uuid }] },
    })}\n`;
  }

  async function writeFirstPrompt(): Promise<void> {
    await fs.writeFile(transcriptPath, record('u1', FIRST_PROMPT));
  }

  function bridgeForSession() {
    const handle = makeChannel({
      newSessionImpl: (request) => ({
        sessionId: String(request._meta?.['qwen-code/sessionId']),
      }),
    });
    const bridge = makeBridge({
      boundWorkspace: workspaceCwd,
      artifactSnapshotRuntimeBaseDir: runtimeBaseDir,
      channelFactory: async () => handle.channel,
    });
    return { bridge, handle };
  }

  function service(): SessionService {
    return new SessionService(workspaceCwd, { runtimeBaseDir });
  }

  it('persists a child notification into the shared prompt-time cache', async () => {
    await writeFirstPrompt();
    const { bridge, handle } = bridgeForSession();
    try {
      const session = await bridge.spawnOrAttach({
        workspaceCwd,
        sessionId: SESSION_ID,
      });
      expect(session.sessionId).toBe(SESSION_ID);
      expect(await service().getLastUserPromptAt(SESSION_ID)).toBe(
        FIRST_PROMPT,
      );

      await handle.agentConnection.extNotification(
        'qwen/notify/session/last-user-prompt',
        { v: 1, sessionId: SESSION_ID, timestamp: NOTIFIED_PROMPT },
      );

      // The notification is one-way, so wait for the daemon-side write to
      // land in the shared cache before reading it back.
      await vi.waitFor(async () => {
        expect(
          await service().getLastUserPromptAt(SESSION_ID, 'active', {
            preferCache: true,
          }),
        ).toBe(NOTIFIED_PROMPT);
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('drops a warm prompt time when the session id is registered', async () => {
    await writeFirstPrompt();
    expect(await service().getLastUserPromptAt(SESSION_ID)).toBe(FIRST_PROMPT);

    const { bridge } = bridgeForSession();
    try {
      await bridge.spawnOrAttach({ workspaceCwd, sessionId: SESSION_ID });
      await fs.appendFile(transcriptPath, record('u2', SECOND_PROMPT));
      expect(
        await service().getLastUserPromptAt(SESSION_ID, 'active', {
          preferCache: true,
        }),
      ).toBe(SECOND_PROMPT);
    } finally {
      await bridge.shutdown();
    }
  });
});
