/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mod rows through the daemon: the bridge says its Web Shell draws reply
 * rows, so each session's Mods run on the `desktop` surface, a client asks
 * for a reply row over `POST /session/:id/mod-row`, and the Mods' log lines
 * reach the session's event stream as `mod_log`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const run = promisify(execFile);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

describe('Mod rows through the daemon', () => {
  it("rewrites a reply row once per props and streams the Mods' logs", async ({
    skip,
  }) => {
    skip(process.platform === 'win32', 'requires the POSIX daemon harness');
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-mod-rows-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const qwenHome = path.join(home, '.qwen');
    const plugin = path.join(root, 'row-probe');
    for (const directory of [
      workspace,
      qwenHome,
      path.join(plugin, '.claude-plugin'),
      path.join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    // Mods start off: the settings page turns them on for new sessions.
    json(path.join(qwenHome, 'settings.json'), {
      general: { enableAutoUpdate: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      model: { skipNextSpeakerCheck: true },
      ui: { enableFollowupSuggestions: false },
      telemetry: { enabled: false },
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
    });
    json(path.join(plugin, '.claude-plugin/plugin.json'), {
      name: 'row-probe',
      version: '1.0.0',
    });
    json(path.join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    // `renders` counts the hook's runs: an answer from the cache keeps it.
    writeFileSync(
      path.join(plugin, 'hooks/register.js'),
      `let renders = 0;
      export function register(on) {
        on('session.start', async ($, e, next) => {
          $.ui.log('start ' + e.surface + ' ' + e.isInteractive + ' '
            + JSON.stringify(await $.session.surfaces()));
          return next(e);
        });
        on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
          if (e.props.text === 'Answer 2') {
            await $.model.complete({ model: 'sonnet', prompt: 'Wait for Mod render', timeoutMs: 25000 });
          }
          return next({ ...e, props: { ...e.props, text: 'zh ' + ++renders + ': ' + e.props.text } });
        });
      }`,
    );

    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let waitingForRewrite = false;
    const fakeModel = await startFakeOpenAIServer(async ({ body }) => {
      const messages = JSON.stringify(body['messages'] ?? []);
      if (messages.includes('Wait for Mod render')) {
        waitingForRewrite = true;
        await renderGate;
        return { content: 'Rewritten answer' };
      }
      if (body['stream'] !== true) return { content: '{}' };
      return {
        content: messages.includes('Produce another reply')
          ? 'Answer 2'
          : 'Answer 1',
      };
    });
    const env = {
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: qwenHome,
      QWEN_SANDBOX: 'false',
      QWEN_CODE_NO_RELAUNCH: 'true',
      QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: fakeModel.baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    let daemon: SpawnedDaemon | undefined;
    try {
      await run(
        process.execPath,
        [DEFAULT_CLI_BIN, 'extensions', 'install', plugin, '--consent'],
        { cwd: workspace, env: { ...process.env, ...env }, timeout: 120_000 },
      );
      daemon = await spawnDaemon({
        workspaceCwd: workspace,
        bootTimeoutMs: 60_000,
        env,
      });
      const { client } = daemon;
      expect((await client.capabilities()).features).toContain(
        'session_mod_rows',
      );
      const row = (isFirstOfReply: boolean) => ({
        component: 'AssistantMessage',
        props: { text: 'Answer 1', isFirstOfReply },
      });
      const invalidRow = {
        component: 'AssistantMessage',
        props: { text: 'Answer 1' },
      };
      const invalidRowError = {
        status: 400,
        body: { code: 'invalid_mod_row' },
      };
      const before = await client.createOrAttachSession({
        workspaceCwd: workspace,
        sessionScope: 'thread',
      });
      expect(
        await client.askSessionModRow(before.sessionId, row(true), {
          clientId: before.clientId,
        }),
      ).toEqual({ status: 'unhooked' });
      await expect(
        client.askSessionModRow(before.sessionId, invalidRow, {
          clientId: before.clientId,
        }),
      ).rejects.toMatchObject(invalidRowError);
      const changed = await client.setWorkspaceSetting(
        'user',
        'experimental.mods',
        true,
      );
      expect(changed).toMatchObject({ requiresRestart: true });
      // A session started after the change has Mods, with no restart.
      const session = await client.createOrAttachSession({
        workspaceCwd: workspace,
        sessionScope: 'thread',
      });
      expect(session.sessionId).not.toBe(before.sessionId);
      const asked = { clientId: session.clientId };
      expect(
        (
          await client.prompt(
            session.sessionId,
            { prompt: [{ type: 'text', text: 'Hello' }] },
            AbortSignal.timeout(60_000),
            session.clientId,
          )
        ).stopReason,
      ).toBe('end_turn');

      const first = {
        status: 'answered',
        props: { text: 'zh 1: Answer 1', isFirstOfReply: true },
      };
      expect(
        await client.askSessionModRow(session.sessionId, row(true), asked),
      ).toEqual(first);
      // The same row from another client is the first answer, not a new run.
      expect(
        await client.askSessionModRow(session.sessionId, row(true)),
      ).toEqual(first);
      expect(
        await client.askSessionModRow(session.sessionId, row(false), asked),
      ).toEqual({
        status: 'answered',
        props: { text: 'zh 2: Answer 1', isFirstOfReply: false },
      });
      // A site the Web Shell does not draw yet is no row of the session's.
      expect(
        await client.askSessionModRow(
          session.sessionId,
          { component: 'Thinking', props: { text: 'Answer 1' } },
          asked,
        ),
      ).toEqual({ status: 'unhooked' });
      await expect(
        client.askSessionModRow(session.sessionId, invalidRow, asked),
      ).rejects.toMatchObject(invalidRowError);

      const logs: unknown[] = [];
      const done = new AbortController();
      const reading = (async () => {
        for await (const event of client.subscribeEvents(session.sessionId, {
          lastEventId: 0,
          signal: done.signal,
        })) {
          if (event.type !== 'mod_log') continue;
          logs.push(event.data);
          done.abort();
        }
      })().catch(() => {});
      await expect
        .poll(() => logs.length, { timeout: 30_000, interval: 200 })
        .toBe(1);
      done.abort();
      await reading;
      expect(logs).toEqual([
        {
          sessionId: session.sessionId,
          plugin: 'row-probe',
          text: 'start desktop true ["desktop"]',
        },
      ]);

      const paged = await client.loadSession(session.sessionId, {
        workspaceCwd: workspace,
        historyPageSize: 200,
      });
      expect(
        [...(paged.compactedReplay ?? []), ...(paged.liveJournal ?? [])]
          .filter((event) => event.type === 'mod_log')
          .map((event) => event.data),
      ).toEqual(logs);

      expect(
        (
          await client.prompt(
            session.sessionId,
            { prompt: [{ type: 'text', text: 'Produce another reply' }] },
            AbortSignal.timeout(60_000),
            session.clientId,
          )
        ).stopReason,
      ).toBe('end_turn');
      const pendingRow = client
        .askSessionModRow(
          session.sessionId,
          {
            component: 'AssistantMessage',
            props: { text: 'Answer 2', isFirstOfReply: true },
          },
          asked,
        )
        .then(
          (answer) => ({ answer }),
          (error: unknown) => ({ error }),
        );
      await expect
        .poll(() => waitingForRewrite, { timeout: 10_000 })
        .toBe(true);
      await client.closeSession(session.sessionId, session.clientId);
      expect(await pendingRow).toEqual({ answer: { status: 'unanswered' } });
      await expect(
        client.askSessionModRow(session.sessionId, row(true)),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      releaseRender();
      await daemon?.dispose();
      await fakeModel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
