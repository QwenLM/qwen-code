/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` — per-turn assistant feedback → telemetry wire path.
 *
 * Real daemon + real ACP child, model side backed by the local fake
 * OpenAI server (same rig as qwen-serve-streaming.test.ts). Usage
 * statistics are disabled in the spawned daemons so no test data leaves
 * for the production RUM sink; the locally observable proof is the
 * `system/ui_telemetry` chat record `logUserFeedback` appends to the
 * session JSONL.
 */
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { isNonBlockingAccepted } from '@qwen-code/sdk/daemon';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  makeTempWorkspace,
  spawnDaemon,
  writeWorkspaceSettings,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const TOKEN = 'feedback-integ-secret';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );
const describePOSIX = SKIP ? describe.skip : describe;

interface FeedbackRecord {
  sessionId: string;
  uiEvent: Record<string, unknown>;
}

interface Rig {
  client: DaemonClient;
  base: string;
  workspaceDir: string;
  homeDir: string;
  spawned: SpawnedDaemon;
  feedbackRecords: (sessionId: string) => FeedbackRecord[];
  postFeedback: (
    sessionId: string,
    body: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  completeTurn: (sessionId: string) => Promise<string>;
}

let fakeServer: FakeOpenAIServer;

async function startRig(opts: {
  workspaceSettings?: Record<string, unknown>;
}): Promise<Rig> {
  const homeDir = makeTempWorkspace('feedback-home');
  const workspaceDir = makeTempWorkspace('feedback-ws');
  const qwenHome = path.join(homeDir, '.qwen');
  mkdirSync(qwenHome, { recursive: true });
  if (opts.workspaceSettings) {
    writeWorkspaceSettings(workspaceDir, opts.workspaceSettings);
  }
  const spawned = await spawnDaemon({
    workspaceCwd: workspaceDir,
    // Feedback, not host-load admission, is under test here. Do not let a
    // shared runner's real load change this fixture's outcome.
    extraArgs: ['--no-load-admission'],
    token: TOKEN,
    bootTimeoutMs: 30_000,
    // Hermetic rig: host-session leakage (QWEN_RUNTIME_DIR above all)
    // would redirect the daemon's storage away from the temp HOME.
    envDrop: [/^QWEN_/, /^OPENAI_/, /^DASHSCOPE/, /^(https?|all)_proxy$/i],
    env: {
      HOME: homeDir,
      QWEN_HOME: qwenHome,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: fakeServer.baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
      // Keep test events out of the production RUM sink; the local
      // ui_telemetry chat record is the assertion seam.
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
    },
  });
  const { client, base } = spawned;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };

  // The daemon canonicalizes the workspace by realpath (macOS `/var` →
  // `/private/var`), so the session JSONL lands under the realpath'd project
  // hash. Mirror that here, or the polls below read a directory nothing
  // writes and never observe the record (same seam as the harness's
  // mcpApprovals keying).
  const canonicalWorkspaceDir = realpathSync(workspaceDir);
  // Match the rig's explicit HOME without letting an inherited
  // QWEN_RUNTIME_DIR redirect this observer to the host profile.
  const projectDir = Storage.runWithResolvedRuntimeBaseDir(qwenHome, () =>
    new Storage(canonicalWorkspaceDir).getProjectDir(),
  );
  const feedbackRecords = (sessionId: string): FeedbackRecord[] => {
    let raw: string;
    try {
      raw = readFileSync(
        path.join(projectDir, 'chats', `${sessionId}.jsonl`),
        'utf8',
      );
    } catch {
      return [];
    }
    const records: FeedbackRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record['type'] !== 'system' || record['subtype'] !== 'ui_telemetry')
        continue;
      const payload = record['systemPayload'] as
        | { uiEvent?: Record<string, unknown> }
        | undefined;
      const uiEvent = payload?.uiEvent;
      // logUserFeedback normalizes the class's `user_feedback` name to the
      // canonical `qwen-code.user_feedback` before the chat record is cut.
      if (uiEvent?.['event.name'] !== 'qwen-code.user_feedback') continue;
      records.push({ sessionId: record['sessionId'] as string, uiEvent });
    }
    return records;
  };

  const postFeedback = async (sessionId: string, body: unknown) => {
    const res = await fetch(`${base}/session/${sessionId}/feedback`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error page */
    }
    return { status: res.status, body: parsed };
  };

  const completeTurn = async (sessionId: string): Promise<string> => {
    const accepted = await client.promptNonBlocking(sessionId, {
      prompt: [{ type: 'text', text: 'feedback e2e turn' }],
    });
    if (!isNonBlockingAccepted(accepted)) {
      throw new Error('prompt was not accepted');
    }
    const promptId = accepted.promptId;
    await expect
      .poll(
        async () => {
          const res = await fetch(
            `${base}/session/${sessionId}/turns/${promptId}`,
            { headers },
          );
          if (!res.ok) return { status: res.status };
          return (await res.json()) as Record<string, unknown>;
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ state: 'completed', stopReason: 'end_turn' });
    return promptId;
  };

  return {
    client,
    base,
    workspaceDir,
    homeDir,
    spawned,
    feedbackRecords,
    postFeedback,
    completeTurn,
  };
}

async function stopRig(rig: Rig | undefined): Promise<void> {
  if (!rig) return;
  await rig.spawned.dispose();
  rmSync(rig.homeDir, { recursive: true, force: true });
  rmSync(rig.workspaceDir, { recursive: true, force: true });
}

beforeAll(async () => {
  if (SKIP) return;
  fakeServer = await startFakeOpenAIServer(() => ({
    content: 'feedback e2e answer',
  }));
}, 30_000);

afterAll(async () => {
  await fakeServer?.close();
});

describePOSIX('qwen serve — assistant feedback telemetry', () => {
  let rig: Rig;

  beforeAll(async () => {
    if (SKIP) return;
    rig = await startRig({});
  }, 60_000);

  afterAll(async () => {
    await stopRig(rig);
  });

  it('advertises the session_turn_feedback capability', async () => {
    const res = await fetch(`${rig.base}/capabilities`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: string[] };
    expect(body.features).toContain('session_turn_feedback');
  });

  it('records a satisfied mark as user_feedback with GOOD(3)', async () => {
    const session = await rig.client.createOrAttachSession({
      workspaceCwd: rig.workspaceDir,
      sessionScope: 'thread',
    });
    try {
      const promptId = await rig.completeTurn(session.sessionId);
      const before = rig.feedbackRecords(session.sessionId).length;

      const { status, body } = await rig.postFeedback(session.sessionId, {
        promptId,
        rating: 'up',
      });

      expect(status).toBe(200);
      expect(body).toEqual({ recorded: true });
      await expect
        .poll(() => rig.feedbackRecords(session.sessionId).length, {
          timeout: 10_000,
        })
        .toBe(before + 1);
      const record = rig.feedbackRecords(session.sessionId).at(-1)!;
      expect(record.sessionId).toBe(session.sessionId);
      expect(record.uiEvent).toMatchObject({
        'event.name': 'qwen-code.user_feedback',
        session_id: session.sessionId,
        rating: 3,
        model: 'fake-model',
        prompt_id: promptId,
      });
      expect(record.uiEvent['approval_mode']).toBeTruthy();
    } finally {
      await rig.client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);

  it('records a dissatisfied mark as BAD(1)', async () => {
    const session = await rig.client.createOrAttachSession({
      workspaceCwd: rig.workspaceDir,
      sessionScope: 'thread',
    });
    try {
      const promptId = await rig.completeTurn(session.sessionId);

      const { status, body } = await rig.postFeedback(session.sessionId, {
        promptId,
        rating: 'down',
      });

      expect(status).toBe(200);
      expect(body).toEqual({ recorded: true });
      await expect
        .poll(
          () =>
            rig
              .feedbackRecords(session.sessionId)
              .filter((r) => r.uiEvent['prompt_id'] === promptId).length,
          { timeout: 10_000 },
        )
        .toBe(1);
      const record = rig
        .feedbackRecords(session.sessionId)
        .find((r) => r.uiEvent['prompt_id'] === promptId)!;
      expect(record.uiEvent['rating']).toBe(1);
    } finally {
      await rig.client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);

  it('rejects invalid bodies with 400 and emits nothing', async () => {
    const session = await rig.client.createOrAttachSession({
      workspaceCwd: rig.workspaceDir,
      sessionScope: 'thread',
    });
    try {
      const promptId = await rig.completeTurn(session.sessionId);
      const before = rig.feedbackRecords(session.sessionId).length;
      const invalid = [
        { rating: 'up' },
        { promptId: '', rating: 'up' },
        { promptId: 42, rating: 'up' },
        { promptId, rating: 'fine' },
        { promptId, rating: null },
        { promptId },
      ];
      for (const body of invalid) {
        const res = await rig.postFeedback(session.sessionId, body);
        expect(res.status).toBe(400);
      }
      expect(rig.feedbackRecords(session.sessionId)).toHaveLength(before);
    } finally {
      await rig.client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);

  it('refuses an unknown session without a primary fallback', async () => {
    const { status } = await rig.postFeedback(
      '00000000-0000-4000-a000-011111100000',
      { promptId: 'prompt-x', rating: 'up' },
    );
    expect(status).toBe(404);
  });

  it('still records locally when usage statistics are disabled', async () => {
    // This rig runs with QWEN_USAGE_STATISTICS_ENABLED=false: the RUM sink
    // is absent (existing QwenLogger gate), but emission into the logger
    // pipeline and the local chat record must still happen.
    const session = await rig.client.createOrAttachSession({
      workspaceCwd: rig.workspaceDir,
      sessionScope: 'thread',
    });
    try {
      const promptId = await rig.completeTurn(session.sessionId);
      const { status, body } = await rig.postFeedback(session.sessionId, {
        promptId,
        rating: 'up',
      });
      expect(status).toBe(200);
      expect(body).toEqual({ recorded: true });
      await expect
        .poll(
          () =>
            rig
              .feedbackRecords(session.sessionId)
              .filter((r) => r.uiEvent['prompt_id'] === promptId).length,
          { timeout: 10_000 },
        )
        .toBe(1);
    } finally {
      await rig.client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);
});

describePOSIX('qwen serve — feedback collection suppressed', () => {
  let rig: Rig;

  beforeAll(async () => {
    if (SKIP) return;
    rig = await startRig({
      workspaceSettings: { ui: { enableUserFeedback: false } },
    });
  }, 60_000);

  afterAll(async () => {
    await stopRig(rig);
  });

  it('returns recorded:false and emits nothing when the setting is off', async () => {
    const session = await rig.client.createOrAttachSession({
      workspaceCwd: rig.workspaceDir,
      sessionScope: 'thread',
    });
    try {
      const promptId = await rig.completeTurn(session.sessionId);

      const { status, body } = await rig.postFeedback(session.sessionId, {
        promptId,
        rating: 'up',
      });

      expect(status).toBe(200);
      expect(body).toEqual({ recorded: false });
      // Give a stray append time to land before asserting absence.
      await new Promise((r) => setTimeout(r, 500));
      expect(rig.feedbackRecords(session.sessionId)).toHaveLength(0);
    } finally {
      await rig.client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);
});
