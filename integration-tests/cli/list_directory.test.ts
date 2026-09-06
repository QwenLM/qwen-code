/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { runForcedToolCallScenario, TestRig } from '../test-helper.js';
import { fakeToolCall } from '../fake-openai-server.js';

/**
 * Drives a fake-server round trip whose first model response calls
 * `list_directory` on the rig's test directory, and returns the resulting
 * tool-result content as JSON.
 */
async function runListDirectoryScenario(options: {
  rig: TestRig;
  finalResponse: string;
}): Promise<string> {
  const { rig, finalResponse } = options;
  const requests = await runForcedToolCallScenario({
    rig,
    toolCall: fakeToolCall(
      'list_directory',
      { path: rig.testDir! },
      'list-dir',
    ),
    prompt: 'Call the list_directory tool on the current directory.',
    finalResponse,
  });
  const toolResultRequest = requests.find(({ messages }) =>
    Array.isArray(messages)
      ? messages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            message.role === 'tool',
        )
      : false,
  );
  expect(
    toolResultRequest,
    'Expected a model request containing the list_directory result',
  ).toBeDefined();
  const messages = toolResultRequest?.['messages'] as
    | Array<{ role?: string; content?: unknown }>
    | undefined;
  return JSON.stringify(
    messages?.find((message) => message.role === 'tool')?.content ?? '',
  );
}

describe('list_directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be able to list a directory', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to list a directory', {
      // list_directory is opt-in (disabled by default).
      settings: { tools: { listDirectory: { enabled: true } } },
    });
    rig.createFile('file1.txt', 'file 1 content');
    rig.mkdir('subdir');

    const toolResultContent = await runListDirectoryScenario({
      rig,
      finalResponse: 'The directory contains file1.txt and subdir.',
    });

    const foundToolCall = await rig.waitForToolCall('list_directory');

    expect(foundToolCall, 'Expected a list_directory tool call').toBe(true);
    expect(toolResultContent).toContain('file1.txt');
    expect(toolResultContent).toContain('subdir');
  });

  it('should not register list_directory when it is not explicitly enabled', async () => {
    const rig = new TestRig();
    // No tools.listDirectory.enabled setting: the tool is opt-in.
    await rig.setup(
      'should not register list_directory when it is not explicitly enabled',
    );
    rig.createFile('file1.txt', 'file 1 content');

    const toolResultContent = await runListDirectoryScenario({
      rig,
      finalResponse: 'Done.',
    });

    // The unregistered tool surfaces an error explaining how to enable it,
    // instead of a listing.
    expect(toolResultContent).toContain('disabled by default');
    expect(toolResultContent).toContain('tools.listDirectory.enabled');
    expect(toolResultContent).not.toContain('file1.txt');
  });
});
