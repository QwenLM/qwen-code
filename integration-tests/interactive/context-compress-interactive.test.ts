/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import { TestRig, type } from '../test-helper.js';

// The background memory extractor fires a second live model call (measured
// 40-52s) while this suite is timing the compression round trip. With it on,
// the first attempt exhausted the event budget below and only a retry passed
// (293s for the file); with it off both live tests pass first attempt (171s).
// Sibling interactive suites disable it for the same reason.
const SUITE_SETTINGS = {
  memory: {
    enableManagedAutoMemory: false,
  },
  security: {
    auth: {
      selectedType: 'openai',
    },
  },
};

// /compress is a live model call whose cost depends on which path the
// compression service takes: measured at 9.8s for the cold side-query (611
// output tokens) and 63.6s for the cache-sharing request (4138 output tokens)
// on an otherwise quiet machine. With the extractor off, 90s already sufficed
// (measured), so the old ceiling per se was not what reddened the shard in
// #11088 — the extractor competed with the measurement, and the previously
// unasserted 25s seed wait could expire, leaving /compress held mid-turn and
// drained at the idle edge (contract pinned by mid-turn-submit-interactive).
// The seed wait is now asserted; 150s is margin over the slow path under
// runner load. It cannot rise to the CLI's 240s stream-idle bound: vitest's
// testTimeout is 300s, the readiness waits already spend part of it, and the
// side-query runs stream:true, maxAttempts:1, so a slow stream gets no retry.
const COMPRESSION_EVENT_TIMEOUT_MS = 150_000;

describe('Interactive Mode', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'should trigger chat compression with /compress command',
    async () => {
      await rig.setup('interactive-compress-test', {
        settings: SUITE_SETTINGS,
      });

      const { ptyProcess } = rig.runInteractive();

      let fullOutput = '';
      ptyProcess.onData((data: string) => (fullOutput += data));

      // Wait for the app to be ready
      const isReady = await rig.waitForText('Type your message', 15000);
      expect(
        isReady,
        'CLI did not start up in interactive mode correctly',
      ).toBe(true);

      const longPrompt =
        'Dont do anything except returning a 1000 token long paragragh with the <name of the scientist who discovered theory of relativity> at the end to indicate end of response. This is a moderately long sentence.';

      await type(ptyProcess, longPrompt);
      await type(ptyProcess, '\r');

      const seeded = await rig.waitForText('einstein', 60_000);
      expect(
        seeded,
        'seed turn did not finish before /compress was submitted',
      ).toBe(true);

      await type(ptyProcess, '/compress');
      // A small delay to allow React to re-render the command list.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await type(ptyProcess, '\r');

      const foundEvent = await rig.waitForTelemetryEvent(
        'chat_compression',
        COMPRESSION_EVENT_TIMEOUT_MS,
      );
      expect(foundEvent, 'chat_compression telemetry event was not found').toBe(
        true,
      );

      // The event is also emitted on the compression service's failure paths
      // and carries no status field, so confirm the success-path UI text too.
      const compressed = await rig.waitForText(
        'Chat history compressed',
        15_000,
      );
      expect(
        compressed,
        'chat_compression event landed but the UI did not report success',
      ).toBe(true);
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
      COMPRESSION_EVENT_TIMEOUT_MS,
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

      const { ptyProcess } = rig.runInteractive();

      let fullOutput = '';
      ptyProcess.onData((data: string) => (fullOutput += data));

      const isReady = await rig.waitForText('Type your message', 15000);
      expect(
        isReady,
        'CLI did not start up in interactive mode correctly',
      ).toBe(true);

      // Seed history so /compress has material to summarize.
      const seedPrompt =
        'Dont do anything except returning a 1000 token long paragragh with the <name of the scientist who discovered theory of relativity> at the end to indicate end of response. This is a moderately long sentence.';

      await type(ptyProcess, seedPrompt);
      await type(ptyProcess, '\r');

      const seeded = await rig.waitForText('einstein', 60_000);
      expect(
        seeded,
        'seed turn did not finish before /compress was submitted',
      ).toBe(true);

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
        COMPRESSION_EVENT_TIMEOUT_MS,
      );
      expect(foundEvent, 'chat_compression telemetry event was not found').toBe(
        true,
      );

      // The event is also emitted on the compression service's failure paths
      // and carries no status field, so confirm the success-path UI text too.
      const compressed = await rig.waitForText(
        'Chat history compressed',
        15_000,
      );
      expect(
        compressed,
        'chat_compression event landed but the UI did not report success',
      ).toBe(true);
    },
  );
});
