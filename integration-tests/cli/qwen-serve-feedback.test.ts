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
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { isNonBlockingAccepted } from '@qwen-code/sdk/daemon';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'feedback-integ-secret';
const ACP_INITIALIZE_TIMEOUT_MS = 60_000;

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
  daemon: ChildProcess;
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
  const homeDir = mkdtempSync(path.join(tmpdir(), 'qwen-feedback-home-'));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'qwen-feedback-ws-'));
  const qwenHome = path.join(homeDir, '.qwen');
  mkdirSync(qwenHome, { recursive: true });
  if (opts.workspaceSettings) {
    mkdirSync(path.join(workspaceDir, '.qwen'), { recursive: true });
    writeFileSync(
      path.join(workspaceDir, '.qwen', 'settings.json'),
      JSON.stringify(opts.workspaceSettings),
      'utf8',
    );
  }
  const daemon = spawn(
    process.execPath,
    [
      CLI_BIN,
      'serve',
      '--port',
      '0',
      '--token',
      TOKEN,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      workspaceDir,
      '--initialize-timeout-ms',
      String(ACP_INITIALIZE_TIMEOUT_MS),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/^(https?|all)_proxy$/i.test(key) &&
              !/^QWEN_/.test(key) &&
              !/^OPENAI_/.test(key) &&
              !/^DASHSCOPE/.test(key),
          ),
        ),
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
    },
  );
  let stderrBuf = '';
  daemon.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const bootTimer = setTimeout(
      () => reject(new Error(`daemon boot timeout; stderr: ${stderrBuf}`)),
      30_000,
    );
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        daemon.stdout!.off('data', onData);
        clearTimeout(bootTimer);
        resolve(Number(m[1]));
      }
    };
    daemon.stdout!.on('data', onData);
    daemon.once('exit', (c) => {
      clearTimeout(bootTimer);
      reject(new Error(`daemon exited with ${c}; stderr: ${stderrBuf}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const client = new DaemonClient({ baseUrl: base, token: TOKEN });
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };

  const projectDir = Storage.runWithRuntimeBaseDir(qwenHome, workspaceDir, () =>
    new Storage(workspaceDir).getProjectDir(),
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
    daemon,
    feedbackRecords,
    postFeedback,
    completeTurn,
  };
}

async function stopRig(rig: Rig | undefined): Promise<void> {
  if (!rig) return;
  if (rig.daemon.exitCode === null) {
    rig.daemon.kill('SIGTERM');
    await new Promise((r) => rig.daemon.once('exit', r));
  }
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
