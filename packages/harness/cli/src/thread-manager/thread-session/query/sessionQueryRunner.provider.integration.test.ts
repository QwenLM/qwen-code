/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  NoopHookCoordinator,
  SessionStateStore,
  type SDKMessage,
} from '@qwen-code/core';
import { ToolRegistry } from '../../../../../core/src/tools/tool-registry.js';
import { ReadFileTool } from '../../../../../core/src/tools/read-file.js';
import { PermissionManager } from '../../../../../core/src/permissions/manager/permission-manager.js';
import { createProviderHttpFixture } from '../../../../../core/src/test-utils/provider-http-fixture.js';
import { setTestSessionPermission } from '../../../../../core/src/test-utils/config.js';
import { SessionQueryRunner } from './sessionQueryRunner.js';

it('E03: keeps one-off B/high through a real Read continuation and restores A on the next submission', async () => {
  const fixture = await createProviderHttpFixture((index) =>
    index === 0
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'read-probe',
              type: 'function',
              function: {
                name: 'Read',
                arguments: JSON.stringify({
                  file_path: join(fixture.dir, 'probe.txt'),
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'PROVIDER_HTTP_OK' },
  );
  const { config, manager, dir, requests } = fixture;
  const permissionManager = new PermissionManager();
  permissionManager.initialize();
  setTestSessionPermission(
    config,
    permissionManager.createSessionPermissionManager({
      getSessionId: () => config.getSessionId(),
      getWorkingDir: () => dir,
      flagSettings: {
        initialMode: 'default',
        rules: { allow: {}, deny: {}, ask: {} },
        additionalDirectories: [],
      },
    }),
  );
  const registry = new ToolRegistry(config);
  registry.registerTool(new ReadFileTool(config));
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  const runner = new SessionQueryRunner({
    sessionId: config.getSessionId(),
    promptSurface: 'sdk',
    config,
    defaultModel: 'fixture/model-a',
    customSystemPrompt: 'Read the file, then return the marker.',
    maxTurns: 3,
    hookCoordinator: new NoopHookCoordinator(),
    toolRegistryFactory: {
      create: () => config.getToolRegistry(),
    },
    sessionStateStoreFactory: (sessionId) =>
      new SessionStateStore({
        projectRoot: dir,
        sessionId,
        configHomeDir: join(dir, 'config'),
        persist: false,
        keyProvider: { getMasterKey: async () => Buffer.alloc(32, 7) },
      }),
  });
  try {
    await writeFile(join(dir, 'probe.txt'), 'E03_REAL_FILE_CONTENT');
    for (const options of [
      { model: 'fixture/model-b', reasoningEffort: 'high' as const },
      {},
    ]) {
      const frames: SDKMessage[] = [];
      for await (const frame of runner.submitMessage(
        'Read the file then reply.',
        { ...options, promptSuggestions: false },
      ))
        frames.push(frame);
      expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1);
      expect(frames.at(-1)).toMatchObject({
        type: 'result',
        subtype: 'success',
      });
      expect(JSON.stringify(frames)).toContain('PROVIDER_HTTP_OK');
      expect(manager.getMainModelKey()).toBe('fixture/model-a');
    }
    expect(requests.map((r) => [r.model, r.reasoning_effort])).toEqual([
      ['model-b', 'high'],
      ['model-b', 'high'],
      ['model-a', undefined],
    ]);
    expect(
      JSON.stringify(requests[1].messages.filter((m) => m.role === 'tool')),
    ).toContain('E03_REAL_FILE_CONTENT');
  } finally {
    runner.dispose();
    await fixture.dispose();
  }
}, 30000);
