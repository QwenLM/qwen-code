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

describe('list_directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be able to list a directory', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to list a directory');
    rig.createFile('file1.txt', 'file 1 content');
    rig.mkdir('subdir');

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
      return { content: 'The directory contains file1.txt and subdir.' };
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
      const prompt = `Call the list_directory tool on the current directory.`;
      // Explicit CLI flags outrank a developer's ~/.qwen/settings.json
      // (settings.model.name beats the OPENAI_MODEL env var and can silently
      // route the run to a real model endpoint instead of the fake server).
      await rig.run(
        prompt,
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
        '--openai-base-url',
        fakeServer.baseUrl,
        '--openai-api-key',
        'fake-key',
      );

      const foundToolCall = await rig.waitForToolCall('list_directory');

      expect(foundToolCall, 'Expected a list_directory tool call').toBe(true);

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
      const toolResultContent = JSON.stringify(
        messages?.find((message) => message.role === 'tool')?.content ?? '',
      );
      expect(toolResultContent).toContain('file1.txt');
      expect(toolResultContent).toContain('subdir');
    } finally {
      await fakeServer.close();
    }
  });
});
