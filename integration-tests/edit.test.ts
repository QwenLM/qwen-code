/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { TestRig, printDebugInfo, validateModelOutput } from './test-helper.js';

describe('edit', () => {
  it('should be able to edit content in a file', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to edit content in a file');

    const fileName = 'file_to_edit.txt';
    const originalContent = 'original content';
    const expectedContent = 'edited content';

    rig.createFile(fileName, originalContent);
    const prompt = `Can you edit the file 'file_to_edit.txt' to change 'original' to 'edited'`;

    const result = await rig.run(prompt);

    const foundToolCall = await rig.waitForToolCall('edit');

    // Add debugging information
    if (!foundToolCall) {
      printDebugInfo(rig, result);
    }

    expect(foundToolCall, 'Expected to find an edit tool call').toBeTruthy();

    // Validate model output - will throw if no output, warn if missing expected content
    validateModelOutput(
      result,
      ['edited', 'file_to_edit.txt'],
      'Edit content test',
    );

    const newFileContent = rig.readFile(fileName);

    // Add debugging for file content
    if (newFileContent !== expectedContent) {
      console.error('File content mismatch - Debug info:');
      console.error('Expected:', expectedContent);
      console.error('Actual:', newFileContent);
      console.error(
        'Tool calls:',
        rig.readToolLogs().map((t) => ({
          name: t.toolRequest.name,
          args: t.toolRequest.args,
        })),
      );
    }

    expect(newFileContent).toBe(expectedContent);

    // Log success info if verbose
    vi.stubEnv('VERBOSE', 'true');
    if (process.env['VERBOSE'] === 'true') {
      console.log('File edited successfully. New content:', newFileContent);
    }
  });
});
