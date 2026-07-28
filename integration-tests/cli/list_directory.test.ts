/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  TestRig,
} from '../test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'QWEN_MODEL',
  'NO_PROXY',
  'no_proxy',
] as const;

describe('list_directory', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    savedEnv = {};
  });

  it('should be able to list a directory', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to list a directory');
    rig.createFile('file1.txt', 'file 1 content');
    rig.mkdir('subdir');
    rig.sync();

    await rig.poll(
      () => {
        const file1Path = join(rig.testDir!, 'file1.txt');
        const subdirPath = join(rig.testDir!, 'subdir');
        return existsSync(file1Path) && existsSync(subdirPath);
      },
      1000,
      50,
    );

    const noProxy = IS_CONTAINER_SANDBOX
      ? CONTAINER_SANDBOX_NO_PROXY
      : '127.0.0.1,localhost';

    const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
      if (requestIndex === 0) {
        return {
          toolCalls: [
            fakeToolCall('list_directory', { path: '.' }, 'list-dir'),
          ],
        };
      }
      return { content: 'The directory contains file1.txt and subdir.' };
    }, fakeServerHostOptions());

    process.env['OPENAI_API_KEY'] = 'fake-key';
    process.env['OPENAI_BASE_URL'] = fakeServer.baseUrl;
    process.env['OPENAI_MODEL'] = 'fake-model';
    process.env['QWEN_MODEL'] = 'fake-model';
    process.env['NO_PROXY'] = noProxy;
    process.env['no_proxy'] = noProxy;

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

      expect(
        fakeServer.requests.length,
        'Fake server saw fewer than 2 requests — the CLI likely resolved a real model endpoint from user-level settings instead of the fake server',
      ).toBeGreaterThanOrEqual(2);
      const toolResultRequest = JSON.stringify(fakeServer.requests[1]?.body);
      expect(toolResultRequest).toContain('file1.txt');
      expect(toolResultRequest).toContain('subdir');
    } finally {
      await fakeServer.close();
    }
  });
});
