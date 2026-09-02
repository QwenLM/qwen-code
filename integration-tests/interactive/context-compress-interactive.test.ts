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
    fakeServer = await startFakeOpenAIServer(
      ({ requestIndex }) => ({
        content:
          requestIndex === 0
            ? `SEED_TURN_DONE ${'deterministic history '.repeat(50)}einstein`
            : 'COMPRESSED_SUMMARY_DONE',
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

  async function waitForInteractiveOutputToSettle() {
    let previousLength = rig._interactiveOutput.length;
    let stableSince = Date.now();
    return rig.poll(
      () => {
        const currentLength = rig._interactiveOutput.length;
        if (currentLength !== previousLength) {
          previousLength = currentLength;
          stableSince = Date.now();
        }
        return Date.now() - stableSince >= 1000;
      },
      25_000,
      100,
    );
  }

  it.skipIf(process.platform === 'win32')(
    'should trigger chat compression with /compress command',
    async () => {
      await rig.setup('interactive-compress-test', {
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

      const { ptyProcess, promise } = await runInteractiveWithFakeModel();

      try {
        const isReady = await rig.waitForText('Type your message', 15000);
        expect(
          isReady,
          'CLI did not start up in interactive mode correctly',
        ).toBe(true);

        await type(ptyProcess, 'Seed deterministic history for compression.');
        await type(ptyProcess, '\r');

        expect(
          await rig.waitForText('SEED_TURN_DONE', 25_000),
          'Fake model seed turn did not complete',
        ).toBe(true);
        expect(
          await rig.waitForTelemetryEvent('api_response', 25_000),
          'Seed turn API response telemetry was not recorded',
        ).toBe(true);
        expect(
          await waitForInteractiveOutputToSettle(),
          'Interactive output did not settle after the seed turn',
        ).toBe(true);

        await type(ptyProcess, '/compress');
        await type(ptyProcess, '\r');
        await type(ptyProcess, '\r');

        const foundEvent = await rig.waitForTelemetryEvent(
          'chat_compression',
          90000,
        );
        expect(
          foundEvent,
          'chat_compression telemetry event was not found',
        ).toBe(true);
      } finally {
        ptyProcess.kill();
        await promise;
      }
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

      const { ptyProcess, promise } = await runInteractiveWithFakeModel();

      try {
        const isReady = await rig.waitForText('Type your message', 15000);
        expect(
          isReady,
          'CLI did not start up in interactive mode correctly',
        ).toBe(true);

        await type(ptyProcess, 'Seed deterministic history for compression.');
        await type(ptyProcess, '\r');

        expect(
          await rig.waitForText('SEED_TURN_DONE', 25_000),
          'Fake model seed turn did not complete',
        ).toBe(true);
        expect(
          await rig.waitForTelemetryEvent('api_response', 25_000),
          'Seed turn API response telemetry was not recorded',
        ).toBe(true);
        expect(
          await waitForInteractiveOutputToSettle(),
          'Interactive output did not settle after the seed turn',
        ).toBe(true);

        await type(ptyProcess, '/compress focus on the scientist mentioned');
        await type(ptyProcess, '\r');
        await type(ptyProcess, '\r');

        const foundEvent = await rig.waitForTelemetryEvent(
          'chat_compression',
          90000,
        );
        expect(
          foundEvent,
          'chat_compression telemetry event was not found',
        ).toBe(true);
      } finally {
        ptyProcess.kill();
        await promise;
      }
    },
  );
});
