/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { TestRig, type } from '../test-helper.js';

describe('Interactive protocol tag filtering', () => {
  let fakeServer: FakeOpenAIServer | undefined;
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
    await rig.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'retries HTTP failures before filtering tagged stream output',
    async () => {
      fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
        if (requestIndex < 2) {
          throw new Error(`retryable fake failure ${requestIndex + 1}`);
        }

        return {
          contentChunks: [
            '<analysis>retry scratchpad that must not render',
            '</analysis><summary>VISIBLE_TMUX_RETRY_SUMMARY_DONE',
            '</summary>',
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
          },
        };
      });

      await rig.setup('interactive-protocol-tag-filtering-http-retry', {
        settings: {
          security: {
            auth: {
              selectedType: 'openai',
            },
          },
        },
      });

      const { ptyProcess, promise } = rig.runInteractive(
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        fakeServer.baseUrl,
        '--model',
        'fake-model',
      );

      try {
        const isReady = await rig.poll(
          () => /YOLO (模式|mode)/i.test(stripAnsi(rig._interactiveOutput)),
          30000,
          200,
        );
        expect(isReady, 'CLI did not start up in interactive mode').toBe(true);

        await type(ptyProcess, 'Return the deterministic retry response.');
        await type(ptyProcess, '\r');

        const sawVisibleSummary = await rig.waitForText(
          'VISIBLE_TMUX_RETRY_SUMMARY_DONE',
          45000,
        );
        expect(
          sawVisibleSummary,
          'Expected visible summary marker after HTTP retries',
        ).toBe(true);
        expect(fakeServer.requests).toHaveLength(3);
        expect(fakeServer.requests[1]!.body).toEqual(
          fakeServer.requests[0]!.body,
        );
        expect(fakeServer.requests[2]!.body).toEqual(
          fakeServer.requests[0]!.body,
        );

        const renderedOutput = stripAnsi(rig._interactiveOutput);
        expect(renderedOutput).toContain('VISIBLE_TMUX_RETRY_SUMMARY_DONE');
        expect(renderedOutput).not.toContain('<analysis>');
        expect(renderedOutput).not.toContain('</analysis>');
        expect(renderedOutput).not.toContain('<summary>');
        expect(renderedOutput).not.toContain('</summary>');
        expect(renderedOutput).not.toContain('retry scratchpad');
      } finally {
        ptyProcess.kill();
        await promise;
      }
    },
  );
});
