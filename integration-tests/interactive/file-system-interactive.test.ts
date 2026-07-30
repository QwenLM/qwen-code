/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import { TestRig, type, printDebugInfo } from '../test-helper.js';

describe('Interactive file system', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'should perform a read-then-write sequence in interactive mode',
    async () => {
      const fileName = 'version.txt';
      await rig.setup('interactive-read-then-write', {
        settings: {
          security: {
            auth: {
              selectedType: 'openai',
            },
          },
        },
      });
      rig.createFile(fileName, '1.0.0');

      const { ptyProcess } = rig.runInteractive();

      // Wait for the app to be ready
      const isReady = await rig.waitForText('Type your message');
      expect(
        isReady,
        'CLI did not start up in interactive mode correctly',
      ).toBe(true);

      // Step 1: Read the file
      const readPrompt = `Read the version from ${fileName}`;
      await type(ptyProcess, readPrompt);
      await type(ptyProcess, '\r');

      const readCall = await rig.waitForToolCall('read_file');
      expect(readCall, 'Expected to find a read_file tool call').toBe(true);

      const containsExpectedVersion = await rig.waitForText('1.0.0');
      expect(
        containsExpectedVersion,
        'Expected to see version "1.0.0" in output',
      ).toBe(true);

      // Step 2: Write the file
      const writePrompt = `now change the version to 1.0.1 in the file`;
      await type(ptyProcess, writePrompt);
      await type(ptyProcess, '\r');

      // The model may apply the change through run_shell_command instead of
      // write_file/edit, so a specific tool call is deliberately not asserted;
      // the file content is the source of truth. Poll until the new version
      // lands, as the turn may still be settling (a failed edit can be retried).
      const updated = await rig.poll(
        () => rig.readFile(fileName).includes('1.0.1'),
        rig.getDefaultTimeout(),
        200,
      );

      if (!updated) {
        printDebugInfo(rig, rig._interactiveOutput, { updated });
      }
      expect(updated, 'Expected file content to contain 1.0.1').toBe(true);
    },
  );
});
