/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Storage, type ChatRecord } from '@qwen-code/qwen-code-core';
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
      const promptOf = (
        target: { sessionId: string; clientId: string },
        text: string,
      ) =>
        call(
          'POST',
          `/session/${target.sessionId}/prompt`,
          { prompt: [{ type: 'text', text }] },
          target.clientId,
        );
      const waitForCompletedTurn = async (response: Response) => {
        const { promptId } = (await json(response, 202)) as {
          promptId: string;
        };
        // Admission is asynchronous; closing the session can cancel the turn.
        await expect
          .poll(
            async () =>
              json(
                await call(
                  'GET',
                  `/session/${session.sessionId}/turns/${promptId}`,
                  undefined,
                  session.clientId,
                ),
                200,
              ),
            { timeout: 60_000 },
          )
          .toMatchObject({ state: 'completed' });
      };
      const put = (
        target: { sessionId: string; clientId: string },
        baseRevision: number,
        value: unknown,
      ) => call('PUT', state(target), { baseRevision, value }, target.clientId);

      // A card saves while the model is still answering.
      const firstPrompt = promptOf(session, 'first prompt');
      await expect
        .poll(() => fakeModel.requests.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(
        await json(await put(session, 0, { items: ['Agenda'] }), 200),
      ).toEqual({ outcome: 'saved', cardId: CARD, revision: 1 });
      release();
      await waitForCompletedTurn(await firstPrompt);

      // An artifact registered after a save still lists after reload.
      await json(
        await call(
          'POST',
          `/session/${session.sessionId}/artifacts`,
          { title: 'Notes', url: 'https://example.com/notes' },
          session.clientId,
        ),
        200,
      );
      expect(
        await json(await put(session, 1, { items: ['Agenda', 'Notes'] }), 200),
      ).toEqual({ outcome: 'saved', cardId: CARD, revision: 2 });
      expect(await json(await put(session, 1, 'late'), 409)).toEqual({
        outcome: 'stale',
        cardId: CARD,
        revision: 2,
        value: { items: ['Agenda', 'Notes'] },
      });

      const reload = async () => {
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
        session.clientId = loaded.clientId;
      };
      const saved = {
        cardId: CARD,
        revision: 2,
        value: { items: ['Agenda', 'Notes'] },
      };

      // The save is the last record; resume, prompt again and reload.
      await reload();
      expect(
        await json(
          await call('GET', state(session), undefined, session.clientId),
          200,
        ),
      ).toEqual(saved);
      const artifacts = await json(
        await call(
          'GET',
          `/session/${session.sessionId}/artifacts`,
          undefined,
          session.clientId,
        ),
        200,
      );
      expect(JSON.stringify(artifacts)).toContain('https://example.com/notes');
      await waitForCompletedTurn(await promptOf(session, 'second prompt'));
      await reload();
      expect(
        await json(
          await call('GET', state(session), undefined, session.clientId),
          200,
        ),
      ).toEqual(saved);
      const transcript = JSON.stringify(
        await json(
          await call(
            'GET',
            `/session/${session.sessionId}/transcript`,
            undefined,
            session.clientId,
          ),
          200,
        ),
      );
      expect(transcript).toContain('first prompt');
      expect(transcript).toContain('second prompt');

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

      // Load can replay the readable suffix, but view state can depend on
      // records behind the missing active parent.
      const partialId = randomUUID();
      const cwd = realpathSync(workspace);
      const storage = new Storage(cwd, path.join(home, '.qwen'));
      const chatsDir = path.join(storage.getProjectDir(), 'chats');
      const common = {
        sessionId: partialId,
        cwd,
        timestamp: '2026-07-08T00:00:00Z',
        version: '1.0.0',
      };
      const records: ChatRecord[] = [
        {
          ...common,
          uuid: 'first-user',
          parentUuid: null,
          type: 'user',
          message: { role: 'user', parts: [{ text: 'show a checklist' }] },
        },
        {
          ...common,
          uuid: 'card-save',
          parentUuid: 'first-user',
          type: 'system',
          subtype: 'generated_ui_state',
          systemPayload: {
            version: 1,
            cardId: CARD,
            revision: 1,
            value: { checked: true },
          },
        },
        {
          ...common,
          uuid: 'later-user',
          parentUuid: 'missing-answer',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'later prompt' }] },
        },
        {
          ...common,
          uuid: 'later-answer',
          parentUuid: 'later-user',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'later answer' }] },
        },
      ];
      mkdirSync(chatsDir, { recursive: true });
      writeFileSync(
        path.join(chatsDir, `${partialId}.jsonl`),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const loaded = (await json(
        await call('POST', `/session/${partialId}/load`, { cwd }),
        200,
      )) as { clientId: string };
      const partial = { sessionId: partialId, clientId: loaded.clientId };
      expect(
        await json(
          await call('GET', state(partial), undefined, partial.clientId),
          503,
        ),
      ).toMatchObject({ code: 'state_unavailable' });
      expect(
        await json(await put(partial, 0, { checked: false }), 503),
      ).toMatchObject({
        code: 'state_unavailable',
      });
    } finally {
      release();
      await daemon?.dispose();
      await fakeModel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
