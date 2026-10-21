/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TestRig,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';
import { pickE2eRenderer } from '../renderer-matrix.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { InteractiveSession } from './interactive-session.js';

const renderer = pickE2eRenderer();

describe(`DW03: ${renderer === 'opentui' ? 'OpenTUI' : 'Ink'} composer workflow intent`, () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let restoreProxy: (() => void) | undefined;

  afterEach(async () => {
    if (rig?.testDir && server) {
      rig.createFile(
        'provider-requests.json',
        JSON.stringify(server.requests, null, 2),
      );
      if (session) rig.createFile('screen.txt', await session.screen());
    }
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    await rig?.cleanup();
    restoreProxy?.();
  });

  async function start(vimMode = false) {
    restoreProxy = applyContainerSandboxNoProxy();
    rig = new TestRig();
    await rig.setup(`dw03-${renderer}-${crypto.randomUUID().slice(0, 8)}`, {
      settings: { general: { chatRecording: true } },
    });
    rig.mkdir('home');
    rig.createFile('system.json', '{}');
    rig.createFile(
      'home/settings.json',
      JSON.stringify({
        tools: { workflowsEnabled: true },
        security: { auth: { selectedType: 'openai' } },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        general: { enableAutoUpdate: false },
        ui: { enableFollowupSuggestions: false },
        telemetry: { enabled: false },
        model: { skipNextSpeakerCheck: true },
      }),
    );
    let replies = 0;
    server = await startFakeOpenAIServer(
      ({ body }) => ({
        content: body['stream'] === true ? `DW03_TUI_DONE_${++replies}` : '{}',
      }),
      fakeServerHostOptions(),
    );
    session = await InteractiveSession.start({
      cwd: rig.testDir!,
      rows: 55,
      cols: 160,
      env: {
        QWEN_HOME: join(rig.testDir!, 'home'),
        QWEN_RUNTIME_DIR: join(rig.testDir!, 'runtime'),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: join(rig.testDir!, 'system.json'),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(rig.testDir!, 'system.json'),
        QWEN_CODE_DISABLE_WORKFLOWS: '0',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_LANG: 'en',
      },
      args: [
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'fake-model',
        '--approval-mode',
        'yolo',
      ],
    });
    await session.idle(500);
    if (vimMode) {
      await session.send('/vim');
      await session.waitForScreen(
        (screen) => screen.includes('-- NORMAL --'),
        'Vim NORMAL mode',
        15_000,
      );
      await session.idle(500);
    }
  }

  function counts() {
    return server!.requests
      .filter(({ body }) => body['stream'] === true)
      .map(({ body }) => {
        const user = (
          body['messages'] as Array<{ role: string; content: unknown }>
        )
          .filter((message) => message.role === 'user')
          .at(-1);
        return (
          JSON.stringify(user?.content).match(
            /The user's message includes the/g,
          ) ?? []
        ).length;
      });
  }

  it('adds one model-only notice for a human keyword and none for the next ordinary turn', async () => {
    await start();
    await session!.send('DW03_TUI_BOTH workflow ultracode: inspect');
    await session!.waitForScreen(
      (screen) => screen.includes('DW03_TUI_DONE_1'),
      'first controlled response',
      45_000,
    );
    await session!.idle(500);
    expect(counts()).toEqual([1]);
    expect(await session!.screen()).toContain('DW03_TUI_BOTH');
    expect(await session!.screen()).not.toContain(
      "The user's message includes the",
    );
    await session!.send('DW03_TUI_ORDINARY inspect');
    await session!.waitForScreen(
      (screen) => screen.includes('DW03_TUI_DONE_2'),
      'second controlled response',
      45_000,
    );
    await session!.idle(500);
    expect(counts()).toEqual([1, 0]);
  }, 120_000);

  it.skipIf(renderer !== 'ink')(
    'keeps recalled Vim register text unknown across buffer clears',
    async () => {
      await start(true);
      session!.pressKey('i');
      await session!.idle(300);
      await session!.send('DW03_VIM_REGISTER workflow inspect');
      await session!.waitForScreen(
        (screen) => screen.includes('DW03_TUI_DONE_1'),
        'fresh Vim keyword response',
        45_000,
      );
      await session!.idle(500);
      expect(counts()).toEqual([1]);
      session!.pressKey('\x1b[A');
      await session!.waitForScreen(
        (screen) => (screen.match(/DW03_VIM_REGISTER/g)?.length ?? 0) >= 2,
        'history recalled into the Vim buffer',
        15_000,
      );
      session!.pressKey('\x1b');
      await session!.idle(300);
      session!.pressKey('d');
      await session!.idle(100);
      session!.pressKey('d');
      await session!.idle(300);
      for (const turn of [2, 3]) {
        session!.pressKey('p');
        await session!.idle(300);
        session!.pressKey('\r');
        await session!.waitForScreen(
          (screen) => screen.includes(`DW03_TUI_DONE_${turn}`),
          'register paste response',
          45_000,
        );
        await session!.idle(500);
        expect(counts()).toEqual(turn === 2 ? [1, 0] : [1, 0, 0]);
      }
      session!.pressKey('i');
      await session!.idle(300);
      await session!.send('DW03_VIM_FRESH ultracode: inspect');
      await session!.waitForScreen(
        (screen) => screen.includes('DW03_TUI_DONE_4'),
        'fresh typing after the register paste',
        45_000,
      );
      await session!.idle(500);
      expect(counts()).toEqual([1, 0, 0, 1]);
    },
    120_000,
  );

  it('preserves a literal leading envelope in display and recall (Vim on Ink)', async () => {
    await start(renderer === 'ink');
    const raw =
      '<system-reminder>DW03_LITERAL_USER</system-reminder>\nworkflow';
    if (renderer === 'ink') {
      session!.pressKey('i');
      await session!.idle(500);
    }
    session!.pressKey(`\x1b[200~${raw}\x1b[201~`);
    await session!.idle(500);
    if (renderer === 'ink') {
      session!.pressKey('\x1b');
      await session!.idle(500);
    }
    session!.pressKey('\r');
    await session!.waitForScreen(
      (screen) => screen.includes('DW03_TUI_DONE_1'),
      'first controlled response',
      45_000,
    );
    await session!.idle(500);
    expect(counts()).toEqual([1]);
    const screen = await session!.screen();
    expect(screen).toContain(
      '<system-reminder>DW03_LITERAL_USER</system-reminder>',
    );
    expect(screen).not.toContain("The user's message includes the");
    if (renderer === 'ink') {
      session!.pressKey('i');
      await session!.idle(500);
    }
    session!.pressKey('\x1b[A');
    await session!.waitForScreen(
      (text) => (text.match(/DW03_LITERAL_USER/g)?.length ?? 0) >= 2,
      'literal user text in the transcript and recalled composer',
      15_000,
    );
    const recalled = await session!.screen();
    expect(recalled.match(/DW03_LITERAL_USER/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(recalled).toContain('</system-reminder>');
    expect(recalled).toContain('workflow');
    if (renderer === 'ink') {
      session!.pressKey('\x1b');
      await session!.idle(500);
    }
    session!.pressKey('\r');
    await session!.waitForScreen(
      (text) => text.includes('DW03_TUI_DONE_2'),
      'recalled unknown text completes normally',
      45_000,
    );
    await session!.idle(500);
    expect(counts()).toEqual([1, 0]);
  }, 120_000);
});
