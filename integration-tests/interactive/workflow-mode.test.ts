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

describe(`DW04: ${renderer === 'opentui' ? 'OpenTUI' : 'Ink'} session Workflow mode`, () => {
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
    await rig.setup(`dw04-${renderer}-${crypto.randomUUID().slice(0, 8)}`, {
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
        content: body['stream'] === true ? `DW04_TUI_DONE_${++replies}` : '{}',
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

  it('changes the persistent mode locally, guides a fresh turn, and clears to off', async () => {
    await start();
    await session!.send('/workflows mode on');
    await session!.waitForScreen(
      (screen) => screen.includes('Workflow mode: on'),
      'mode on',
      15_000,
    );
    await session!.idle(500);
    expect(
      server!.requests.filter(({ body }) => body['stream'] === true),
    ).toHaveLength(0);
    await session!.send('DW04_TUI_FIRST inspect the repository');
    await session!.waitForScreen(
      (screen) => screen.includes('DW04_TUI_DONE_1'),
      'first response',
      45_000,
    );
    await session!.idle(500);
    const requests = server!.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(1);
    const messages = requests[0].body['messages'] as Array<{
      role: string;
      content: unknown;
    }>;
    expect(
      JSON.stringify(
        messages.filter((message) => message.role === 'user').at(-1)?.content,
      ),
    ).toContain('Workflow mode is enabled for this session.');
    expect(await session!.screen()).not.toContain(
      'Workflow mode is enabled for this session.',
    );
    await session!.send('/clear');
    await session!.idle(1_000);
    await session!.send('/workflows mode status');
    await session!.waitForScreen(
      (screen) => screen.includes('Workflow mode: off'),
      'cleared mode off',
      15_000,
    );
    await session!.idle(500);
    expect(
      server!.requests.filter(({ body }) => body['stream'] === true),
    ).toHaveLength(1);
  }, 120_000);
});
