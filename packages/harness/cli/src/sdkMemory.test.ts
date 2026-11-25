/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionRuleValueToString } from '@qwen-code/core';
import { matchingRuleForInput } from '../../core/src/tools/filesystem-permissions/filesystem.js';
import {
  buildSdkMemoryPrompt,
  buildSdkMemoryPermissionUpdates,
  buildNativeSdkMemoryConsumptionResult,
  prepareSdkMemoryRoots,
  loadSdkMemoryConsumption,
  parseSdkMemoryConfig,
  resolveSdkMemoryEnablement,
} from './sdkMemory.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-memory-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('SDK memory initialization', () => {
  it('requires the SDK requester marker', () => {
    expect(() =>
      parseSdkMemoryConfig({ mode: 'native' }),
    ).toThrow('memory.requester must be "sdk"');
  });

  it('accepts PROJECT and USER scopes and rejects nested overrides in native mode', () => {
    expect(
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'native',
        projectScope: false,
        userScope: true,
      }),
    ).toEqual({
      requester: 'sdk',
      mode: 'native',
      projectScope: false,
      userScope: true,
    });
    expect(() =>
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'native',
        consumption: { files: [{ id: 'memory', path: '/tmp/MEMORY.md' }] },
      }),
    ).toThrow(
      'memory mode "native" does not accept generation or consumption overrides',
    );
    expect(() =>
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'native',
        userScope: 'yes',
      }),
    ).toThrow('memory.userScope must be boolean');
    expect(() =>
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'native',
        projectScope: 'yes',
      }),
    ).toThrow('memory.projectScope must be boolean');
    expect(() =>
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'native',
        projectScope: false,
        userScope: false,
      }),
    ).toThrow(
      'memory native mode requires at least one enabled scope; use memory: {} to disable SDK memory',
    );
  });

  it('normalizes custom roots and grants only root-scoped Read/Edit rules', async () => {
    const parent = await makeTemporaryDirectory();
    const root = path.join(parent, 'memory');
    const config = parseSdkMemoryConfig({
      requester: 'sdk',
      mode: 'custom',
      generation: {
        enabled: true,
        prompt: 'Store durable facts.',
        roots: [
          {
            id: 'main',
            path: root,
            access: 'read-write',
            indexFile: 'MEMORY.md',
          },
        ],
      },
    });

    expect(config?.requester).toBe('sdk');
    const preparedRoots = await prepareSdkMemoryRoots(
      config?.generation?.roots ?? [],
    );
    const preparedRoot = preparedRoots[0]?.path;
    expect(preparedRoot).toBeDefined();
    expect(preparedRoots[0]?.indexFile).toBe('MEMORY.md');
    await expect(fs.stat(root)).resolves.toMatchObject({});
    const updates = buildSdkMemoryPermissionUpdates(preparedRoots);
    expect(updates).toMatchObject([
      {
        type: 'addRules',
        destination: 'session',
        behavior: 'allow',
        rules: [
          { toolName: 'Read' },
          { toolName: 'Edit' },
        ],
      },
    ]);
    const [update] = updates;
    if (update?.type !== 'addRules') throw new Error('Expected memory root rules');
    const context = {
      rules: {
        allow: { session: update.rules.map(permissionRuleValueToString) },
        deny: {},
        ask: {},
      },
      additionalDirectories: [],
    };
    expect(
      matchingRuleForInput(
        path.join(preparedRoot!, 'MEMORY.md'),
        context,
        'edit',
        'allow',
        parent,
      ),
    ).not.toBeNull();
  });

  it('rejects an index file outside its custom root', () => {
    expect(() =>
      parseSdkMemoryConfig({
        requester: 'sdk',
        mode: 'custom',
        generation: {
          roots: [
            { id: 'main', path: '/tmp/sdk-memory', indexFile: '../MEMORY.md' },
          ],
        },
      }),
    ).toThrow('indexFile must stay within its root');
  });

  it('accepts partial custom overrides and defaults omitted blocks to CLI behavior', () => {
    const config = parseSdkMemoryConfig({
      requester: 'sdk',
      mode: 'custom',
      generation: {
        roots: [{ id: 'main', path: '/tmp/sdk-memory-partial' }],
      },
      consumption: {},
    });

    expect(config?.generation?.enabled).toBe(true);
    expect(config?.generation?.prompt).toBeUndefined();
    expect(config?.consumption?.enabled).toBe(true);
    expect(config?.consumption?.files).toBeUndefined();
    expect(resolveSdkMemoryEnablement(config!)).toEqual({
      generationEnabled: true,
      turnCompleteEnabled: true,
      consumptionEnabled: true,
    });
  });

  it('uses CLI defaults when generation and consumption are both omitted', () => {
    const config = parseSdkMemoryConfig({
      requester: 'sdk',
      mode: 'custom',
    });

    expect(resolveSdkMemoryEnablement(config!)).toEqual({
      generationEnabled: true,
      turnCompleteEnabled: true,
      consumptionEnabled: true,
    });
  });

  it('honors explicit disable overrides', () => {
    const config = parseSdkMemoryConfig({
      requester: 'sdk',
      mode: 'custom',
      generation: { enabled: false },
      consumption: { enabled: false },
    });

    expect(resolveSdkMemoryEnablement(config!)).toEqual({
      generationEnabled: false,
      turnCompleteEnabled: false,
      consumptionEnabled: false,
    });
  });
});

describe('SDK memory generation prompt', () => {
  it('wraps a custom generation prompt in the auto-memory section', () => {
    const prompt = buildSdkMemoryPrompt('Store durable facts only.', [
      { id: 'shared', path: '/tmp/shared-memory', access: 'read' },
      {
        id: 'worker',
        path: '/tmp/worker-memory',
        access: 'read-write',
        indexFile: 'MEMORY.md',
      },
    ]);

    expect(prompt).toBe(
      [
        '# auto memory',
        '',
        '## SDK-provided generation instructions',
        '',
        'Store durable facts only.',
        '',
        '## SDK-controlled memory roots',
        '',
        '- shared: /tmp/shared-memory (read)',
        '- worker: /tmp/worker-memory (read-write; index: MEMORY.md)',
        '',
        'Use only these roots for persistent memory. A root never grants access to its parent.',
      ].join('\n'),
    );
  });
});

describe('SDK memory consumption', () => {
  it('reads only explicit files and preserves their declared order', async () => {
    const directory = await makeTemporaryDirectory();
    const first = path.join(directory, 'FIRST.md');
    const second = path.join(directory, 'SECOND.md');
    await Promise.all([
      fs.writeFile(first, 'first memory'),
      fs.writeFile(second, 'second memory'),
      fs.writeFile(path.join(directory, 'UNLISTED.md'), 'must not be loaded'),
    ]);

    const loaded = await loadSdkMemoryConsumption({
      enabled: true,
      files: [
        { id: 'first', path: first, required: true },
        { id: 'second', path: second, required: true },
      ],
      failureMode: 'fail_query',
    });

    expect(loaded.result.status).toBe('success');
    expect(loaded.result.files.map((file) => file.id)).toEqual([
      'first',
      'second',
    ]);
    const context = loaded.context?.['sdkMemory'] ?? '';
    expect(context.indexOf('first memory')).toBeLessThan(
      context.indexOf('second memory'),
    );
    expect(context).not.toContain('must not be loaded');
    expect(loaded.fileStates).toHaveLength(2);
    expect(loaded.fileStates.map((state) => state.filePath)).toEqual([
      first,
      second,
    ]);
    expect(loaded.fileStates.map((state) => state.content)).toEqual([
      'first memory',
      'second memory',
    ]);
  });

  it('fails a query when a required file is missing in fail_query mode', async () => {
    const directory = await makeTemporaryDirectory();
    const missing = path.join(directory, 'MISSING.md');
    const loaded = await loadSdkMemoryConsumption({
      enabled: true,
      files: [{ id: 'required', path: missing, required: true }],
      failureMode: 'fail_query',
    });

    expect(loaded.result.status).toBe('failed');
    expect(loaded.result.files[0]).toMatchObject({ status: 'missing' });
    expect(loaded.fatalError).toContain(missing);
    expect(loaded.fileStates).toEqual([
      {
        filePath: missing,
        content: '',
        timestamp: 0,
        retainIfMissing: true,
      },
    ]);
  });

  it('applies the shared token budget in file order', async () => {
    const directory = await makeTemporaryDirectory();
    const first = path.join(directory, 'FIRST.md');
    const second = path.join(directory, 'SECOND.md');
    await Promise.all([
      fs.writeFile(first, 'A'.repeat(200)),
      fs.writeFile(second, 'B'.repeat(200)),
    ]);

    const loaded = await loadSdkMemoryConsumption({
      enabled: true,
      files: [
        { id: 'first', path: first, required: true },
        { id: 'second', path: second, required: true },
      ],
      maxTokens: 10,
      overflow: 'truncate',
      failureMode: 'fail_query',
    });

    expect(loaded.result.status).toBe('partial');
    expect(loaded.result.files.map((file) => file.status)).toEqual([
      'truncated',
      'truncated',
    ]);
    expect(loaded.result).not.toHaveProperty('totalTokens');
    expect(loaded.result.files.every((file) => !('tokens' in file))).toBe(true);
  });

  it('reports native MEMORY.md file states without token counts', () => {
    expect(
      buildNativeSdkMemoryConsumptionResult([
        {
          scope: 'project',
          indexPath: '/tmp/project-memory/MEMORY.md',
        },
        {
          scope: 'user',
          indexPath: '/tmp/user-memory/MEMORY.md',
          retainIfMissing: true,
        },
        {
          scope: 'shared',
          indexPath: '/tmp/shared-memory/MEMORY.md',
          retainIfMissing: true,
          loadError: 'permission denied',
        },
      ]),
    ).toEqual({
      status: 'partial',
      files: [
        {
          id: 'project',
          path: '/tmp/project-memory/MEMORY.md',
          status: 'loaded',
        },
        {
          id: 'user',
          path: '/tmp/user-memory/MEMORY.md',
          status: 'missing',
        },
        {
          id: 'shared',
          path: '/tmp/shared-memory/MEMORY.md',
          status: 'failed',
          error: 'permission denied',
        },
      ],
    });
  });
});
