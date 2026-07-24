/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadConfig', () => {
  it('resolves an environment credential and the default timeout', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
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

    expect(config.timeoutMs).toBe(5000);
    expect(config.provider).toMatchObject({
      type: 'mem0-platform-v3',
      apiKeyEnv: 'MEM0_API_KEY',
      apiKey: 'secret-value',
      appId: 'shared-repository',
    });
  });

  it('rejects unsupported config versions', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 2,
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

  it('rejects unknown config fields', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
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

  it('requires an absolute config path', async () => {
    await expect(
      loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: 'relative-config.json',
      }),
    ).rejects.toThrow(
      'QWEN_EXTERNAL_CONTEXT_CONFIG must name an absolute file path.',
    );
  });

  it('does not read an inherited config path', async () => {
    const fixture = await createFixture();
    const env = Object.create({
      QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
    }) as NodeJS.ProcessEnv;

    await expect(loadConfig(env)).rejects.toThrow(
      'QWEN_EXTERNAL_CONTEXT_CONFIG must name an absolute file path.',
    );
  });

  it('does not expose a missing credential name or secret config data', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
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

  it.each(['__proto__', 'constructor', 'toString'])(
    'does not treat inherited %s as a credential',
    async (tokenEnv) => {
      const fixture = await createFixture();
      await writeConfig(fixture, {
        version: 1,
        provider: {
          type: 'generic-http-search-v1',
          baseUrl: 'https://context.example.com',
          tokenEnv,
        },
      });

      await expect(
        loadConfig({
          QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
        }),
      ).rejects.toThrow(
        'Configured external context credential is unavailable.',
      );
    },
  );

  it('accepts a bounded tool search timeout', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
      timeoutMs: 15_000,
      provider: {
        type: 'generic-http-search-v1',
        baseUrl: 'https://context.example.com',
        tokenEnv: 'CONTEXT_TOKEN',
      },
    });

    await expect(
      loadConfig({
        QWEN_EXTERNAL_CONTEXT_CONFIG: fixture.config,
        CONTEXT_TOKEN: 'secret-value',
      }),
    ).resolves.toMatchObject({ timeoutMs: 15_000 });
  });

  it('rejects provider timeouts above the thirty-second ceiling', async () => {
    const fixture = await createFixture();
    await writeConfig(fixture, {
      version: 1,
      timeoutMs: 30_001,
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
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'external-context-config-'));
  temporaryDirectories.push(root);
  return {
    config: join(root, 'config.json'),
  };
}

async function writeConfig(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  value: unknown,
) {
  await writeFile(fixture.config, JSON.stringify(value));
}
