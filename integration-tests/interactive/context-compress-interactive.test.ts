/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  TestRig,
  type,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';

describe('Interactive Mode', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer | undefined;
  let restoreNoProxy: () => void;

  beforeEach(() => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
  });

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
    restoreNoProxy();
    await rig.cleanup();
  });

  async function runInteractiveWithFakeModel() {
    // The seed must fit the 80x30 pty viewport: under the OpenTUI renderer
    // off-screen rows never reach the pty stream waitForText polls, so a
    // seed longer than the viewport hides its own end marker (#11191).
    fakeServer = await startFakeOpenAIServer(
      ({ requestIndex }) => ({
        content:
          requestIndex === 0
            ? `${'history '.repeat(100)} Einstein`
            : '<state_snapshot>Compressed history focused on Einstein.</state_snapshot>',
      }),
      fakeServerHostOptions(),
    );
    return rig.runInteractive(
      '--auth-type',
      'openai',
      '--openai-api-key',
      'fake-key',
      '--openai-base-url',
      fakeServer.baseUrl,
      '--model',
      'fake-model',
    );
  }

  it.skipIf(process.platform === 'win32')(
    'should trigger chat compression with /compress command',
    async () => {
      await rig.setup('interactive-compress-test', {
        settings: {
          security: {
            auth: {
              selectedType: 'openai',
            },
          },
        },
      });

      const { ptyProcess } = await runInteractiveWithFakeModel();

      let fullOutput = '';
      ptyProcess.onData((data: string) => (fullOutput += data));

      // Wait for the app to be ready
      const isReady = await rig.waitForText(
        'Type your message',
        rig.getDefaultTimeout(),
      );
      expect(
        isReady,
        'CLI did not start up in interactive mode correctly',
      ).toBe(true);

      const longPrompt =
        'Dont do anything except returning a 1000 token long paragragh with the <name of the scientist who discovered theory of relativity> at the end to indicate end of response. This is a moderately long sentence.';

      await type(ptyProcess, longPrompt);
      await type(ptyProcess, '\r');

      const seedCompleted = await rig.waitForText('einstein');
      expect(seedCompleted, 'seed response did not complete').toBe(true);

      await type(ptyProcess, '/compress');
      // A small delay to allow React to re-render the command list.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await type(ptyProcess, '\r');

      const foundEvent = await rig.waitForTelemetryEvent(
        'chat_compression',
        90000,
      );
      expect(foundEvent, 'chat_compression telemetry event was not found').toBe(
        true,
      );
    },
  );

  it.skip('should handle compression failure on token inflation', async () => {
    await rig.setup('interactive-compress-test', {
      settings: {
        security: {
          auth: {
            selectedType: 'openai',
          },
        },
      },
    });

    const { ptyProcess } = rig.runInteractive();

    let fullOutput = '';
    ptyProcess.onData((data: string) => (fullOutput += data));

    // Wait for the app to be ready
    const isReady = await rig.waitForText('Type your message', 25000);
    expect(isReady, 'CLI did not start up in interactive mode correctly').toBe(
      true,
    );

    await type(ptyProcess, '/compress');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await type(ptyProcess, '\r');

    const foundEvent = await rig.waitForTelemetryEvent(
      'chat_compression',
      90000,
    );
    expect(foundEvent).toBe(true);

    const compressionFailed = await rig.waitForText(
      'Nothing to compress.',
      25000,
    );

    expect(compressionFailed).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'should forward /compress instructions through to the side-query',
    async () => {
      await rig.setup('interactive-compress-instructions-test', {
        settings: {
          security: {
            auth: {
              selectedType: 'openai',
            },
          },
        },
      });

      const { ptyProcess } = await runInteractiveWithFakeModel();

      let fullOutput = '';
      ptyProcess.onData((data: string) => (fullOutput += data));

      const isReady = await rig.waitForText(
        'Type your message',
        rig.getDefaultTimeout(),
      );
      expect(
        isReady,
        'CLI did not start up in interactive mode correctly',
      ).toBe(true);

      // Seed history so /compress has material to summarize.
      const seedPrompt =
        'Dont do anything except returning a 1000 token long paragragh with the <name of the scientist who discovered theory of relativity> at the end to indicate end of response. This is a moderately long sentence.';

      await type(ptyProcess, seedPrompt);
      await type(ptyProcess, '\r');

      const seedCompleted = await rig.waitForText('einstein');
      expect(seedCompleted, 'seed response did not complete').toBe(true);

      // Fire /compress with a trailing instruction. We are not asserting on
      // summary CONTENT (model behaviour) — only that the wiring runs
      // end-to-end and the compression telemetry event lands. Earlier unit
      // tests cover the prompt-composition path; this is the smoke test that
      // the args plumbing reaches the side-query.
      await type(ptyProcess, '/compress focus on the scientist mentioned');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await type(ptyProcess, '\r');

      const foundEvent = await rig.waitForTelemetryEvent(
        'chat_compression',
        90000,
      );
      expect(foundEvent, 'chat_compression telemetry event was not found').toBe(
        true,
      );
    },
  );
});
