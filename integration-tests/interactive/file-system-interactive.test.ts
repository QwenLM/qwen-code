/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import {
  startFakeOpenAIServer,
  fakeToolCall,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  TestRig,
  type,
  printDebugInfo,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';

describe('Interactive file system', () => {
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

  it.skipIf(process.platform === 'win32')(
    'should perform a read-then-write sequence in interactive mode',
    async () => {
      const fileName = 'version.txt';

      // Drive the conversation with a deterministic fake model instead of a
      // live LLM. A real model made this multi-turn test flaky: the cited CI
      // failure was the second turn stalling mid-stream until the poll timed
      // out, and a live model can also pick a different tool or phrase the
      // read result without the literal version. The fake model scripts the
      // exact read-then-write turn sequence so the interactive mechanics
      // (typed input, tool execution, file mutation) are what get tested.
      let filePath = '';
      fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            toolCalls: [fakeToolCall('read_file', { file_path: filePath })],
          };
        }
        if (requestIndex === 1) {
          return { content: 'The current version is 1.0.0.' };
        }
        if (requestIndex === 2) {
          return {
            toolCalls: [
              fakeToolCall('write_file', {
                file_path: filePath,
                content: '1.0.1',
              }),
            ],
          };
        }
        return { content: 'Done. The version is now 1.0.1.' };
      }, fakeServerHostOptions());

      await rig.setup('interactive-read-then-write', {
        settings: {
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          ui: {
            enableFollowupSuggestions: false,
          },
          security: {
            auth: {
              selectedType: 'openai',
            },
          },
        },
      });
      filePath = rig.createFile(fileName, '1.0.0');

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
        if (!readCall) {
          printDebugInfo(rig, rig._interactiveOutput, { readCall });
        }
        expect(readCall, 'Expected to find a read_file tool call').toBe(true);

        // The interactive UI renders a successful read_file as a one-line
        // summary, not its content, so the rendered '1.0.0' matches the fake
        // model's scripted echo (requestIndex 1), not the read result. Assert
        // the read result directly via the tool result the CLI sent back in
        // the next request, so this still observes the real file content; the
        // write-side poll below grounds the test in the real filesystem.
        const containsExpectedVersion = await rig.waitForText('1.0.0');
        if (!containsExpectedVersion) {
          printDebugInfo(rig, rig._interactiveOutput, {
            containsExpectedVersion,
          });
        }
        expect(
          containsExpectedVersion,
          'Expected to see version "1.0.0" in output',
        ).toBe(true);
        expect(JSON.stringify(fakeServer.requests[1]!.body)).toContain('1.0.0');

        // Step 2: Write the file
        const writePrompt = `now change the version to 1.0.1 in the file`;
        await type(ptyProcess, writePrompt);
        await type(ptyProcess, '\r');

        const toolCall = await rig.waitForAnyToolCall(['write_file', 'edit']);

        if (!toolCall) {
          printDebugInfo(rig, rig._interactiveOutput, {
            toolCall,
          });
        }

        expect(
          toolCall,
          'Expected to find a write_file or edit tool call',
        ).toBe(true);

        const updated = await rig.poll(
          () => rig.readFile(fileName).includes('1.0.1'),
          rig.getDefaultTimeout(),
          200,
        );
        if (!updated) {
          printDebugInfo(rig, rig._interactiveOutput, { toolCall });
        }
        expect(updated, 'Expected file content to contain 1.0.1').toBe(true);

        // The file is mutated before the final model turn (requestIndex 3)
        // completes, so wait for that turn's rendered text before counting
        // requests. The exact count catches a spurious extra request that
        // would otherwise silently shift the requestIndex-based dispatch.
        const done = await rig.waitForText('Done. The version is now 1.0.1.');
        expect(done, 'Expected final assistant message to render').toBe(true);
        expect(fakeServer.requests).toHaveLength(4);
      } finally {
        ptyProcess.kill();
        await promise;
      }
    },
  );
});
