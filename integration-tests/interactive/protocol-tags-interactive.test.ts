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

const SANDBOX_MODE = process.env['QWEN_SANDBOX']?.toLowerCase().trim();
const IS_CONTAINER_SANDBOX =
  SANDBOX_MODE === 'docker' || SANDBOX_MODE === 'podman';

describe('Interactive protocol tag retry guard', () => {
  let fakeServer: FakeOpenAIServer | undefined;
  let rig: TestRig;
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  beforeEach(() => {
    rig = new TestRig();
    if (IS_CONTAINER_SANDBOX) {
      savedNoProxy = process.env['NO_PROXY'];
      savedNoProxyLower = process.env['no_proxy'];
      const noProxy = '127.0.0.1,localhost,host.docker.internal';
      process.env['NO_PROXY'] = noProxy;
      process.env['no_proxy'] = noProxy;
    }
  });

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
    if (IS_CONTAINER_SANDBOX) {
      if (savedNoProxy !== undefined) {
        process.env['NO_PROXY'] = savedNoProxy;
      } else {
        delete process.env['NO_PROXY'];
      }
      if (savedNoProxyLower !== undefined) {
        process.env['no_proxy'] = savedNoProxyLower;
      } else {
        delete process.env['no_proxy'];
      }
    }
    await rig.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'retries protocol leaks across SSE disconnect and completed streams',
    async () => {
      fakeServer = await startFakeOpenAIServer(
        ({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              contentChunks: [
                '<analysis>hidden before disconnect',
                '</analysis><summary>WRONG_FIRST_ATTEMPT</summary>',
              ],
              disconnectAfterContentChunks: 1,
            };
          }

          if (requestIndex === 1) {
            return {
              contentChunks: [
                '<ana',
                'lysis>hidden completed attempt</analysis>',
                '<sum',
                'mary>WRONG_COMPLETED_SUMMARY</summary>',
              ],
            };
          }

          return {
            contentChunks: ['VISIBLE_TMUX_RETRY_RESPONSE_DONE'],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 8,
              total_tokens: 28,
            },
          };
        },
        IS_CONTAINER_SANDBOX
          ? {
              listenHost: '0.0.0.0',
              baseUrlHost: 'host.docker.internal',
            }
          : undefined,
      );

      await rig.setup('interactive-protocol-tag-filtering-http-retry', {
        settings: {
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
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
          'VISIBLE_TMUX_RETRY_RESPONSE_DONE',
          15000,
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
        expect(renderedOutput).toContain('VISIBLE_TMUX_RETRY_RESPONSE_DONE');
        expect(renderedOutput).not.toContain('<analysis>');
        expect(renderedOutput).not.toContain('</analysis>');
        expect(renderedOutput).not.toContain('<summary>');
        expect(renderedOutput).not.toContain('</summary>');
        expect(renderedOutput).not.toContain('hidden before disconnect');
        expect(renderedOutput).not.toContain('hidden completed attempt');
        expect(renderedOutput).not.toContain('WRONG_FIRST_ATTEMPT');
        expect(renderedOutput).not.toContain('WRONG_COMPLETED_SUMMARY');
      } finally {
        ptyProcess.kill();
        await promise;
      }
    },
  );
});
