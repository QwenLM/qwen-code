/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { spawnDaemon } from './_daemon-harness.js';

it('reopens a per-run session with complete history after deleting its parent', async ({
  skip,
}) => {
  skip(process.platform === 'win32', 'requires the POSIX daemon harness');
  skip(
    Boolean(
      process.env['QWEN_SANDBOX'] && process.env['QWEN_SANDBOX'] !== 'false',
    ),
    'requires access to a local fake model',
  );
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'qwen-per-run-delete-')),
  );
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(configHome);
  const prompt = 'Run the independent scheduled check';
  const reply = 'Independent scheduled check completed';
  const model = await startFakeOpenAIServer(() => ({ content: reply }));
  let daemon: Awaited<ReturnType<typeof spawnDaemon>> | undefined;
  try {
    daemon = await spawnDaemon({
      workspaceCwd: workspace,
      bootTimeoutMs: 60_000,
      env: {
        HOME: configHome,
        QWEN_HOME: join(configHome, '.qwen'),
        QWEN_RUNTIME_DIR: join(root, 'runtime'),
        QWEN_SANDBOX: 'false',
        QWEN_CODE_NO_RELAUNCH: 'true',
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: model.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    const { base, token, client } = daemon;
    const post = async <T>(route: string, status: number, body?: object) => {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as T;
      expect(response.status, JSON.stringify(payload)).toBe(status);
      return payload;
    };
    const task = await post<{ id: string; sessionId: string }>(
      '/scheduled-tasks',
      201,
      { cron: '0 0 1 1 *', prompt, sessionMode: 'per_run' },
    );
    expect(task.sessionId).toBeTruthy();
    const run = await post<{ runs: Array<{ sessionId: string }> }>(
      `/scheduled-tasks/${task.id}/run`,
      200,
    );
    const childId = run.runs.at(-1)!.sessionId;
    expect(childId).toBeTruthy();
    expect(childId).not.toBe(task.sessionId);
    const transcript = () => client.getSessionTranscriptPage(childId);
    await expect
      .poll(async () => JSON.stringify((await transcript()).events), {
        timeout: 30_000,
      })
      .toContain(reply);

    await client.closeSession(childId);
    const before = await transcript();
    const history = JSON.stringify(before.events);
    expect(history).toContain(prompt);
    expect(history.indexOf(reply)).toBeGreaterThan(history.indexOf(prompt));
    expect(history).not.toContain('History gap');
    expect(before.hasMore).toBe(false);
    expect(before.partial).toBeUndefined();

    expect(await client.deleteSessionsData([task.sessionId])).toEqual({
      removed: [task.sessionId],
      notFound: [],
      errors: [],
    });
    const reopened = await client.loadSession(childId);
    expect(reopened.sessionId).toBe(childId);
    expect(reopened.partial).toBeUndefined();
    expect(JSON.stringify(reopened.compactedReplay)).toContain(reply);
    const after = await transcript();
    expect(after.events).toEqual(before.events);
    expect(after.hasMore).toBe(false);
    expect(after.partial).toBeUndefined();
  } finally {
    await daemon?.dispose();
    await model.close();
    rmSync(root, { recursive: true, force: true });
  }
});
