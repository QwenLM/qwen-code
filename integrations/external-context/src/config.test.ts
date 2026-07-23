/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  isInsideRepository,
  loadConfig,
} from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadConfig', () => {
  it('resolves the real repository root and an environment credential', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
      repositoryRoot: fixture.repository,
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'shared-repository',
      },
    });

    const config = await loadConfig({
      QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
      MEM0_API_KEY: 'secret-value',
    });

    expect(config.repositoryRoot).toBe(await realpath(fixture.repository));
    expect(config.autoRecall).toEqual({ enabled: false, timeoutMs: 1500 });
    expect(config.write).toEqual({ enabled: false });
    expect(config.provider).toMatchObject({
      type: 'mem0-platform-v3',
      apiKeyEnv: 'MEM0_API_KEY',
      apiKey: 'secret-value',
      appId: 'shared-repository',
    });
  });

  it('rejects unknown fields, invalid versions, and relative roots', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 2,
      repositoryRoot: 'relative',
      extra: true,
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'shared-repository',
      },
    });

    await expect(
      loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
        MEM0_API_KEY: 'secret-value',
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('does not expose a missing credential name or secret config data', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
      repositoryRoot: fixture.repository,
      provider: {
        type: 'generic-http-search-v1',
        baseUrl: 'https://context.example.com',
        tokenEnv: 'HIGHLY_SENSITIVE_TOKEN',
      },
    });

    let message = '';
    try {
      await loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('HIGHLY_SENSITIVE_TOKEN');
    expect(message).toBe(
      'Configured external context credential is unavailable.',
    );
  });

  it('rejects provider timeouts above the five-second ceiling', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
      repositoryRoot: fixture.repository,
      autoRecall: { enabled: true, timeoutMs: 5001 },
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'shared-repository',
      },
    });

    await expect(
      loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
        MEM0_API_KEY: 'secret-value',
      }),
    ).rejects.toThrow('External context config is invalid.');
  });

  it('rejects a repository root that resolves to a file', async () => {
    const fixture = await createFixture();
    const fileRoot = join(fixture.root, 'not-a-directory');
    await writeFile(fileRoot, 'content');
    await writeConfig(fixture, {
      version: 1,
      repositoryRoot: fileRoot,
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'shared-repository',
      },
    });

    await expect(
      loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
        MEM0_API_KEY: 'secret-value',
      }),
    ).rejects.toThrow('Configured repository root could not be resolved.');
  });
});

describe('isInsideRepository', () => {
  it('accepts descendants and rejects siblings and symlink escapes', async () => {
    const fixture = await createFixture();
    const child = join(fixture.repository, 'child');
    const sibling = join(fixture.root, 'sibling');
    const escape = join(fixture.repository, 'escape');
    await mkdir(child);
    await mkdir(sibling);
    await symlink(
      sibling,
      escape,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const root = await realpath(fixture.repository);

    await expect(isInsideRepository(root, root)).resolves.toBe(true);
    await expect(isInsideRepository(root, child)).resolves.toBe(true);
    await expect(isInsideRepository(root, sibling)).resolves.toBe(false);
    await expect(isInsideRepository(root, escape)).resolves.toBe(false);
    await expect(isInsideRepository(root, 'relative')).resolves.toBe(false);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'external-context-config-'));
  temporaryDirectories.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  return {
    root,
    repository,
    config: join(root, 'config.json'),
  };
}

async function writeConfig(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  value: unknown,
) {
  await writeFile(fixture.config, JSON.stringify(value));
}
