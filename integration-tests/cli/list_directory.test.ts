/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  TestRig,
} from '../test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { join } from 'node:path';

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

  const noProxy = IS_CONTAINER_SANDBOX
    ? CONTAINER_SANDBOX_NO_PROXY
    : '127.0.0.1,localhost';

  let streamingRequestIndex = 0;
  const fakeServer = await startFakeOpenAIServer(({ body }) => {
    if (body['stream'] !== true) {
      return { content: '{"selected_memories":[]}' };
    }
    const requestIndex = streamingRequestIndex++;
    if (requestIndex === 0) {
      return {
        toolCalls: [
          fakeToolCall('list_directory', { path: rig.testDir! }, 'list-dir'),
        ],
      };
    }
    return { content: finalResponse };
  }, fakeServerHostOptions());

  vi.stubEnv('OPENAI_API_KEY', 'fake-key');
  vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'fake-model');
  vi.stubEnv('QWEN_MODEL', 'fake-model');
  vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
  vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
  vi.stubEnv('NO_PROXY', noProxy);
  vi.stubEnv('no_proxy', noProxy);

  try {
    // Explicit CLI flags outrank a developer's ~/.qwen/settings.json
    // (settings.model.name beats the OPENAI_MODEL env var and can silently
    // route the run to a real model endpoint instead of the fake server).
    await rig.run(
      'Call the list_directory tool on the current directory.',
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
      '--openai-base-url',
      fakeServer.baseUrl,
      '--openai-api-key',
      'fake-key',
    );

    const toolResultRequest = fakeServer.requests.find(({ body }) => {
      const messages = body['messages'];
      return (
        Array.isArray(messages) &&
        messages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            message.role === 'tool',
        )
      );
    });
    expect(
      toolResultRequest,
      'Expected a model request containing the list_directory result',
    ).toBeDefined();
    const messages = toolResultRequest?.body['messages'] as
      | Array<{ role?: string; content?: unknown }>
      | undefined;
    return JSON.stringify(
      messages?.find((message) => message.role === 'tool')?.content ?? '',
    );
  } finally {
    await fakeServer.close();
  }
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
