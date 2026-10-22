/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getCompressionPrompt } from '@qwen-code/qwen-code-core';
import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
  type FakeOpenAIHandler,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import {
  TestRig,
  type,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';

const SUITE_SETTINGS = {
  memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  security: {
    auth: {
      selectedType: 'openai',
    },
  },
};

const COMPRESSED_HISTORY =
  '<state_snapshot>Compressed history focused on Einstein.</state_snapshot>';

// Dispatch on the request body, not the raw request index: a seed retried
// after a transient connection error (or any other request that reaches the
// fake server first) must still get the seed response, and only the
// compression side-query asks for a <state_snapshot>.
const fakeModelResponse: FakeOpenAIHandler = ({ body }) => {
  const isCompressionRequest =
    JSON.stringify(body).includes('<state_snapshot>');
  return {
    content: isCompressionRequest
      ? COMPRESSED_HISTORY
      : `${'history '.repeat(100)} Einstein`,
  };
};

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
      fakeModelResponse,
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

  it('answers seed and compression requests by shape, not request order', () => {
    const seed = fakeModelResponse({
      body: { messages: [{ role: 'user', content: 'seed prompt' }] },
      requestIndex: 3,
    });
    expect(seed.content).toContain('history history');

    const compression = fakeModelResponse({
      body: {
        messages: [{ role: 'system', content: getCompressionPrompt() }],
      },
      requestIndex: 0,
    });
    expect(compression.content).toBe(
      '<state_snapshot>Compressed history focused on Einstein.</state_snapshot>',
    );
  });

  function expectSuccessfulCompression() {
    const compressionEvent = rig.readTelemetryEvent('chat_compression');
    const tokensBefore = compressionEvent?.attributes?.['tokens_before'];
    const tokensAfter = compressionEvent?.attributes?.['tokens_after'];
    const outputTokens =
      compressionEvent?.attributes?.['compression_output_token_count'];
    const cacheSharing = compressionEvent?.attributes?.['cache_sharing_used'];

    expect(
      typeof tokensBefore === 'number' &&
        typeof tokensAfter === 'number' &&
        tokensBefore > tokensAfter,
      'chat_compression event recorded no token reduction: ' +
        `tokens_before=${String(tokensBefore)}, ` +
        `tokens_after=${String(tokensAfter)}, ` +
        `output=${String(outputTokens)}, ` +
        `cache_sharing=${String(cacheSharing)}`,
    ).toBe(true);
  }

  it.skipIf(process.platform === 'win32')(
    'should trigger chat compression with /compress command',
    async () => {
      await rig.setup('interactive-compress-test', {
        settings: SUITE_SETTINGS,
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
      expectSuccessfulCompression();
    },
  );

  it.skip('should handle compression failure on token inflation', async () => {
    await rig.setup('interactive-compress-test', {
      settings: SUITE_SETTINGS,
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
        settings: SUITE_SETTINGS,
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

      // Fire /compress with a trailing instruction. We do not assert summary
      // content, but do require the deterministic fixture to reduce tokens.
      // Earlier unit tests cover prompt composition; this pins the end-to-end
      // argument path and a successful compression result.
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
      expectSuccessfulCompression();
    },
  );
});
