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
import { normalizeDaemonEvent } from '@qwen-code/sdk/daemon';
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
      let thoughts = 0;
      let turns = 0;
      export function register(on) {
        on('session.start', async ($, e, next) => {
          $.ui.log('start ' + e.surface + ' ' + e.isInteractive + ' '
            + JSON.stringify(await $.session.surfaces()));
          return next(e);
        });
        on('turn.complete', ($, e, next) => {
          $.ui.log('completed ' + ++turns);
          return next(e);
        });
        on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
          if (e.props.text === 'Answer 2') {
            await $.model.complete({ model: 'sonnet', prompt: 'Wait for Mod render', timeoutMs: 25000 });
          }
          return next({ ...e, props: { ...e.props, text: 'zh ' + ++renders + ': ' + e.props.text } });
        });
        on('ui.render', { component: 'Thinking' }, ($, e, next) =>
          next({ ...e, props: { ...e.props, text: 'zh thought ' + ++thoughts + ': ' + e.props.text } }));
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
      return messages.includes('Produce another reply')
        ? { content: 'Answer 2' }
        : { reasoningChunks: ['Plan ', 'the answer.'], content: 'Answer 1' };
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
      // A thought is a row of its own, answered once for every client.
      const thought = {
        component: 'Thinking',
        props: { text: 'Plan the answer.' },
      };
      const rewrittenThought = {
        status: 'answered',
        props: { text: 'zh thought 1: Plan the answer.' },
      };
      expect(
        await client.askSessionModRow(session.sessionId, thought, asked),
      ).toEqual(rewrittenThought);
      expect(await client.askSessionModRow(session.sessionId, thought)).toEqual(
        rewrittenThought,
      );
      // A site the Web Shell does not draw is no row of the session's.
      expect(
        await client.askSessionModRow(
          session.sessionId,
          { component: 'AbovePrompt', props: { view: 'prompt' } },
          asked,
        ),
      ).toEqual({ status: 'unhooked' });
      for (const invalid of [
        invalidRow,
        {
          component: 'Thinking',
          props: { text: 'Plan the answer.', isFirstOfReply: true },
        },
      ])
        await expect(
          client.askSessionModRow(session.sessionId, invalid, asked),
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
      const paged = await client.loadSession(session.sessionId, {
        workspaceCwd: workspace,
        historyPageSize: 200,
      });
      const replay = [
        ...(paged.compactedReplay ?? []),
        ...(paged.liveJournal ?? []),
      ];
      const logEvent = (text: string) => ({
        sessionId: session.sessionId,
        plugin: 'row-probe',
        text,
      });
      expect(
        replay.filter((event) => event.type === 'mod_log').map((e) => e.data),
      ).toEqual([...logs, logEvent('completed 1'), logEvent('completed 2')]);
      const replayLines = replay
        .flatMap((event) => normalizeDaemonEvent(event))
        .flatMap((event) =>
          event.type === 'user.text.delta' ||
          event.type === 'assistant.text.delta' ||
          (event.type === 'status' && event.source === 'mod_log')
            ? [event.text]
            : [],
        );
      expect(
        replayLines.filter(
          (line) => line !== '[Mod row-probe] start desktop true ["desktop"]',
        ),
      ).toEqual([
        'Hello',
        'Answer 1',
        '[Mod row-probe] completed 1',
        'Produce another reply',
        'Answer 2',
        '[Mod row-probe] completed 2',
      ]);
      // The replayed thought is the row the page asked for.
      expect(
        replay
          .flatMap((event) => normalizeDaemonEvent(event))
          .flatMap((event) =>
            event.type === 'thought.text.delta' ? [event.text] : [],
          )
          .join(''),
      ).toBe(thought.props.text);
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

  it('translates reply and thinking rows with the display language alone', async ({
    skip,
  }) => {
    skip(process.platform === 'win32', 'requires the POSIX daemon harness');
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-mod-rows-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const qwenHome = path.join(home, '.qwen');
    for (const directory of [workspace, qwenHome])
      mkdirSync(directory, { recursive: true });
    // No extension and no experimental Mods.
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
    const translations: string[] = [];
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fakeModel = await startFakeOpenAIServer(async ({ body }) => {
      const messages = JSON.stringify(body['messages'] ?? []);
      if (messages.includes('into Simplified Chinese')) {
        const text = messages.includes('Plan the answer.')
          ? '先规划答案。'
          : '答案一';
        translations.push(text);
        return { content: `${text}\n[QWEN_DISPLAY_END]` };
      }
      if (body['stream'] !== true) return { content: '{}' };
      if (messages.includes('Reply in Chinese'))
        return { content: '已经是中文的回答' };
      return {
        reasoningChunks: ['Plan ', 'the answer.'],
        contentChunks: ['Answer ', '1'],
        holdAfterChunks: 1,
        holdUntil: responseGate,
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
      daemon = await spawnDaemon({
        workspaceCwd: workspace,
        bootTimeoutMs: 60_000,
        env,
      });
      const { client } = daemon;
      expect(
        await client.setWorkspaceSetting(
          'user',
          'general.displayLanguage',
          'zh-CN',
        ),
      ).toMatchObject({ requiresRestart: true });
      const session = await client.createOrAttachSession({
        workspaceCwd: workspace,
        sessionScope: 'thread',
      });
      const asked = { clientId: session.clientId };
      const replyStarted = (async () => {
        for await (const event of client.subscribeEvents(session.sessionId, {
          lastEventId: 0,
          signal: AbortSignal.timeout(30_000),
        })) {
          if (
            normalizeDaemonEvent(event).some(
              (update) =>
                update.type === 'assistant.text.delta' &&
                update.text === 'Answer ',
            )
          )
            return;
        }
        throw new Error('Missing the first reply chunk');
      })();
      const prompt = client.prompt(
        session.sessionId,
        { prompt: [{ type: 'text', text: 'Hello' }] },
        AbortSignal.timeout(60_000),
        session.clientId,
      );
      const thought = {
        component: 'Thinking',
        props: { text: 'Plan the answer.' },
      };
      const translatedThought = {
        status: 'answered',
        props: { text: '先规划答案。' },
      };
      try {
        await replyStarted;
        // The main reply is still streaming. Its completed thought is visible
        // and eligible before the completed response has been persisted.
        expect(
          await client.askSessionModRow(session.sessionId, thought, asked),
        ).toEqual(translatedThought);
        expect(
          await client.askSessionModRow(
            session.sessionId,
            {
              component: 'AssistantMessage',
              props: { text: 'Answer ', isFirstOfReply: true },
            },
            asked,
          ),
        ).toEqual({ status: 'unanswered' });
      } finally {
        releaseResponse();
        await prompt.catch(() => {});
      }
      expect((await prompt).stopReason).toBe('end_turn');

      const reply = {
        component: 'AssistantMessage',
        props: { text: 'Answer 1', isFirstOfReply: true },
      };
      expect(
        await client.askSessionModRow(session.sessionId, reply, asked),
      ).toEqual({
        status: 'answered',
        props: { text: '答案一', isFirstOfReply: true },
      });
      expect(
        await client.askSessionModRow(session.sessionId, thought, asked),
      ).toEqual(translatedThought);
      expect(
        await client.askSessionModRow(
          session.sessionId,
          {
            component: 'AssistantMessage',
            props: {
              text: 'Text absent from this transcript.',
              isFirstOfReply: true,
            },
          },
          asked,
        ),
      ).toEqual({ status: 'unanswered' });
      // A reply already in Chinese is drawn as it is, with no model call.
      expect(
        (
          await client.prompt(
            session.sessionId,
            { prompt: [{ type: 'text', text: 'Reply in Chinese' }] },
            AbortSignal.timeout(60_000),
            session.clientId,
          )
        ).stopReason,
      ).toBe('end_turn');
      expect(
        await client.askSessionModRow(
          session.sessionId,
          {
            component: 'AssistantMessage',
            props: { text: '已经是中文的回答', isFirstOfReply: true },
          },
          asked,
        ),
      ).toEqual({ status: 'answered' });
      // Another client is answered from the session's cache.
      const second = await client.loadSession(session.sessionId, {
        workspaceCwd: workspace,
      });
      expect(second.clientId).not.toBe(session.clientId);
      expect(
        await client.askSessionModRow(session.sessionId, reply, {
          clientId: second.clientId,
        }),
      ).toEqual({
        status: 'answered',
        props: { text: '答案一', isFirstOfReply: true },
      });
      expect(translations).toEqual(['先规划答案。', '答案一']);

      // A new live owner can still verify rows from the persisted transcript.
      await client.closeSession(session.sessionId, second.clientId);
      const restored = await client.loadSession(session.sessionId, {
        workspaceCwd: workspace,
        historyPageSize: 200,
      });
      expect(
        await client.askSessionModRow(restored.sessionId, reply, {
          clientId: restored.clientId,
        }),
      ).toEqual({
        status: 'answered',
        props: { text: '答案一', isFirstOfReply: true },
      });
      expect(
        await client.askSessionModRow(restored.sessionId, thought, {
          clientId: restored.clientId,
        }),
      ).toEqual(translatedThought);
      expect(translations).toEqual([
        '先规划答案。',
        '答案一',
        '答案一',
        '先规划答案。',
      ]);
    } finally {
      await daemon?.dispose();
      await fakeModel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
