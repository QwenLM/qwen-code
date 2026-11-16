/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { spawnDaemon, type SpawnedDaemon } from './_daemon-harness.js';

const CARD = 'gc_aaaaaaaaaaaaaaaaaaaaaa';

describe('Generated UI view state through the daemon', () => {
  it('saves during a running turn, reads back after reload, and stays in its session', async ({
    skip,
  }) => {
    skip(process.platform === 'win32', 'requires the POSIX daemon harness');
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-ui-state-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const fakeModel = await startFakeOpenAIServer(async () => {
      await released;
      return { content: 'done' };
    });
    let daemon: SpawnedDaemon | undefined;
    const call = (
      method: string,
      route: string,
      body?: unknown,
      clientId?: string,
    ) =>
      fetch(`${daemon!.base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${daemon!.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    const json = async (response: Response, status: number) => {
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(status);
      return body;
    };
    const state = (session: { sessionId: string; clientId: string }) =>
      `/session/${session.sessionId}/generated-ui/state/${CARD}`;
    const create = async () =>
      (await json(
        await call('POST', '/session', {
          cwd: workspace,
          sessionScope: 'thread',
        }),
        200,
      )) as { sessionId: string; clientId: string };

    try {
      daemon = await spawnDaemon({
        workspaceCwd: workspace,
        bootTimeoutMs: 60_000,
        env: {
          HOME: home,
          QWEN_HOME: path.join(home, '.qwen'),
          QWEN_SANDBOX: 'false',
          QWEN_CODE_NO_RELAUNCH: 'true',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: fakeModel.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      });
      const capabilities = await json(await call('GET', '/capabilities'), 200);
      expect(capabilities.features).toContain('generated_ui_state');

      const session = await create();
      expect(
        await json(
          await call('GET', state(session), undefined, session.clientId),
          200,
        ),
      ).toEqual({ cardId: CARD, revision: 0, value: null });
      expect(
        await json(
          await call(
            'PUT',
            state(session),
            { baseRevision: 0, value: { items: ['Agenda'] } },
            session.clientId,
          ),
          200,
        ),
      ).toEqual({ outcome: 'saved', cardId: CARD, revision: 1 });

      // A card saves while the model is still answering.
      const prompt = call(
        'POST',
        `/session/${session.sessionId}/prompt`,
        { prompt: [{ type: 'text', text: 'hello' }] },
        session.clientId,
      );
      await expect
        .poll(() => fakeModel.requests.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(
        await json(
          await call(
            'PUT',
            state(session),
            { baseRevision: 1, value: { items: ['Agenda', 'Notes'] } },
            session.clientId,
          ),
          200,
        ),
      ).toEqual({ outcome: 'saved', cardId: CARD, revision: 2 });
      release();
      await prompt;

      expect(
        await json(
          await call(
            'PUT',
            state(session),
            { baseRevision: 1, value: 'late' },
            session.clientId,
          ),
          409,
        ),
      ).toEqual({
        outcome: 'stale',
        cardId: CARD,
        revision: 2,
        value: { items: ['Agenda', 'Notes'] },
      });

      // Close and load the session again: state comes from the transcript.
      expect(
        (
          await call(
            'DELETE',
            `/session/${session.sessionId}`,
            undefined,
            session.clientId,
          )
        ).status,
      ).toBeLessThan(300);
      const loaded = (await json(
        await call('POST', `/session/${session.sessionId}/load`, {
          cwd: workspace,
        }),
        200,
      )) as { clientId: string };
      expect(
        await json(
          await call('GET', state(session), undefined, loaded.clientId),
          200,
        ),
      ).toEqual({
        cardId: CARD,
        revision: 2,
        value: { items: ['Agenda', 'Notes'] },
      });

      const other = await create();
      expect(
        await json(
          await call('GET', state(other), undefined, other.clientId),
          200,
        ),
      ).toEqual({ cardId: CARD, revision: 0, value: null });

      const unknown = await call(
        'GET',
        `/session/${randomUUID()}/generated-ui/state/${CARD}`,
        undefined,
        other.clientId,
      );
      expect(unknown.status).toBe(404);
    } finally {
      release();
      await daemon?.dispose();
      await fakeModel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
