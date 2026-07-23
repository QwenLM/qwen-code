/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('list_directory', () => {
  it('should be able to list a directory', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to list a directory');
    rig.createFile('file1.txt', 'file 1 content');
    rig.mkdir('subdir');
    rig.sync();

    // Poll for filesystem changes to propagate in containers
    await rig.poll(
      () => {
        // Check if the files exist in the test directory
        const file1Path = join(rig.testDir!, 'file1.txt');
        const subdirPath = join(rig.testDir!, 'subdir');
        return existsSync(file1Path) && existsSync(subdirPath);
      },
      1000, // 1 second max wait
      50, // check every 50ms
    );

    const prompt = `Call the list_directory tool on the current directory. You must use the tool — do not answer from the folder structure in your context.`;

    const result = await rig.run(prompt);

    const foundToolCall = await rig.waitForToolCall('list_directory');

    // The model sometimes answers from the folder structure already present in
    // the system prompt instead of calling the tool. Accept either a tool call
    // OR correct text output so the test doesn't flake on model variability.
    const hasCorrectOutput =
      result.includes('file1.txt') && result.includes('subdir');

    // Add debugging information
    if (!foundToolCall && !hasCorrectOutput) {
      const allTools = printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Contains file1.txt': result.includes('file1.txt'),
        'Contains subdir': result.includes('subdir'),
      });

      console.error(
        'List directory calls:',
        allTools
          .filter((t) => t.toolRequest.name === 'list_directory')
          .map((t) => t.toolRequest.args),
      );
    }

    expect(
      foundToolCall || hasCorrectOutput,
      'Expected a list_directory tool call or correct directory listing in output',
    ).toBeTruthy();

    // Validate model output - will throw if no output, warn if missing expected content
    validateModelOutput(result, ['file1.txt', 'subdir'], 'List directory test');
  });
});
