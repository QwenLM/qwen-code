/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  TestRig,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';
import { pickE2eRenderer } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

describe.skipIf(pickE2eRenderer() !== 'ink')('Focus mode', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let restoreNoProxy: () => void;

  beforeEach(() => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
  });

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    restoreNoProxy();
    await rig.cleanup();
  });

  it.each([true, false])(
    'reprojects completed history and persists the preference (terminal buffer: %s)',
    async (useTerminalBuffer) => {
      await rig.setup(`focus-mode-${useTerminalBuffer}`, {
        settings: {
          general: { enableAutoUpdate: false },
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          ui: { enableFollowupSuggestions: false, useTerminalBuffer },
          security: { auth: { selectedType: 'openai' } },
        },
      });
      const qwenHome = join(rig.testDir!, 'isolated-home');
      await mkdir(qwenHome);
      const filePath = rig.createFile('focus-result.txt', 'FOCUS_TOOL_RESULT');
      server = await startFakeOpenAIServer(
        ({ requestIndex }) =>
          requestIndex % 2 === 0
            ? {
                toolCalls: [fakeToolCall('read_file', { file_path: filePath })],
              }
            : { content: 'FOCUS_ANSWER' },
        fakeServerHostOptions(),
      );
      const options = {
        cwd: rig.testDir!,
        cols: 140,
        rows: 60,
        env: {
          QWEN_CODE_LANG: 'en',
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: join(rig.testDir!, 'runtime'),
        },
        args: [
          '--approval-mode',
          'yolo',
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fake-key',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'fake-model',
        ],
      };
      session = await InteractiveSession.start(options);
      await session.idle();
      await session.send('Inspect the fixture.');
      await session.waitFor('FOCUS_ANSWER');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(JSON.stringify(server.requests[1]!.body)).toContain(
        'FOCUS_TOOL_RESULT',
      );

      await session.send('/focus');
      await session.idle();
      const focused = await session.screen();
      expect(focused).toContain('1 tool call hidden (/focus to show)');
      expect(focused).not.toContain('focus-result.txt');
      expect(focused).toContain('FOCUS_ANSWER');

      session.sendKey('\u000f');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(await session.screen()).not.toContain(
        '1 tool call hidden (/focus to show)',
      );
      session.sendKey('\u000f');
      await session.idle();
      expect(await session.screen()).toContain(
        '1 tool call hidden (/focus to show)',
      );

      await session.send('/focus');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(await session.screen()).not.toContain(
        '1 tool call hidden (/focus to show)',
      );
      await session.send('/focus');
      await session.idle();
      const persisted = JSON.parse(
        await readFile(join(qwenHome, 'settings.json'), 'utf8'),
      );
      expect(persisted.ui.focusMode).toBe(true);

      await session.close();
      session = await InteractiveSession.start(options);
      await session.idle();
      await session.send('Inspect the fixture again.');
      await session.waitFor('FOCUS_ANSWER');
      await session.idle();
      expect(await session.screen()).toContain(
        '1 tool call hidden (/focus to show)',
      );
      expect(await session.screen()).not.toContain('focus-result.txt');
      expect(server.requests).toHaveLength(4);

      await session.send('/settings');
      await session.idle(200, 5000);
      await session.send('ui.focusMode');
      await session.idle(200, 5000);
      expect(await session.screen()).toContain('Focus Mode');
      session.sendKey('\r');
      await session.idle(200, 5000);
      session.sendKey('\u001b');
      await session.idle(500, 5000);
      session.sendKey('\u001b');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(await session.screen()).not.toContain(
        '1 tool call hidden (/focus to show)',
      );
      expect(server.requests).toHaveLength(4);

      await session.send('/focus');
      await session.idle();
      expect(await session.screen()).toContain(
        '1 tool call hidden (/focus to show)',
      );
      await session.send('/settings');
      await session.idle(200, 5000);
      await session.send('ui.focusMode');
      await session.idle(200, 5000);
      session.sendKey('\u000c');
      await session.idle(200, 5000);
      session.sendKey('\u001b');
      await session.idle(500, 5000);
      session.sendKey('\u001b');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(await session.screen()).not.toContain(
        '1 tool call hidden (/focus to show)',
      );
      const reset = JSON.parse(
        await readFile(join(qwenHome, 'settings.json'), 'utf8'),
      );
      expect(reset.ui.focusMode).toBe(false);
      expect(server.requests).toHaveLength(4);

      await session.send('/config ui.focusMode=true');
      await session.idle();
      expect(await session.screen()).toContain(
        '1 tool call hidden (/focus to show)',
      );
      expect(await session.screen()).not.toContain('focus-result.txt');
      await session.send('/config ui.focusMode');
      await session.idle();
      // The first Enter accepts the setting-key completion.
      session.sendKey('\r');
      await session.idle();
      expect(await session.screen()).toContain('focus-result.txt');
      expect(await session.screen()).not.toContain(
        '1 tool call hidden (/focus to show)',
      );
      expect(server.requests).toHaveLength(4);
    },
  );
});
