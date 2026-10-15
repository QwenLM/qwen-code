/**
 * @license
 * Copyright 2026 Qwen Team
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
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-internal-modules -- package-owned synthetic protocol fixture
import fixture from '../test/fixtures/synthetic-write-v1.json' with { type: 'json' };
import {
  loadRuntimeConfiguration,
  loadAutoRecallRuntimeConfiguration,
} from './config.js';
import { parseWriteInstanceConfig, parseWriteDialect } from './schemas.js';
import { loadWriteRuntimeConfiguration } from './write-config.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function configuration() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mem0-write-config-')),
  );
  directories.push(root);
  const configPath = join(root, 'instance.json');
  const dialectPath = join(root, 'dialect.json');
  const instance = {
    ...structuredClone(fixture.instance),
    repositoryRoot: root,
    dialectPath,
  };
  const dialect = structuredClone(fixture.dialect);
  const env = {
    QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG: configPath,
    SYNTHETIC_MEMORY_TOKEN: 'synthetic-token',
  };
  await writeFile(configPath, JSON.stringify(instance));
  await writeFile(dialectPath, JSON.stringify(dialect));
  return { root, configPath, dialectPath, instance, dialect, env };
}

describe('Mem0 writer configuration', () => {
  it('loads only V4 and validates the canonical startup cwd before reading a credential', async () => {
    const config = await configuration();
    const child = join(config.root, 'subdir');
    await mkdir(child);
    const loaded = await loadWriteRuntimeConfiguration({
      env: config.env,
      cwd: child,
    });
    expect(loaded.instance).toEqual(config.instance);
    expect(loaded.dialect).toEqual(config.dialect);
    expect(loaded.credential).toBe('synthetic-token');
    for (const load of [
      loadRuntimeConfiguration,
      loadAutoRecallRuntimeConfiguration,
    ]) {
      await expect(
        load({
          env: {
            ...config.env,
            QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: config.configPath,
          },
        }),
      ).rejects.toThrow('configuration is invalid');
    }
  });

  it('requires a fixed nonempty scope and bounded explicit write timeout', () => {
    for (const timeoutMs of [100, 30000])
      expect(
        parseWriteInstanceConfig({ ...fixture.instance, timeoutMs }).timeoutMs,
      ).toBe(timeoutMs);
    for (const value of [
      { ...fixture.instance, schemaVersion: 2 },
      { ...fixture.instance, schemaVersion: 3 },
      { ...fixture.instance, scope: {} },
      { ...fixture.instance, timeoutMs: 99 },
      { ...fixture.instance, timeoutMs: 30001 },
      { ...fixture.instance, write: true },
    ])
      expect(() => parseWriteInstanceConfig(value)).toThrow(
        'write configuration is invalid',
      );
  });

  it('rejects scriptable, inferred, or incompatible write dialects', () => {
    for (const value of [
      { ...fixture.dialect, infer: true },
      {
        ...fixture.dialect,
        create: { ...fixture.dialect.create, method: 'PUT' },
      },
      {
        ...fixture.dialect,
        create: { ...fixture.dialect.create, userIdLocation: 'json.filters' },
      },
      {
        ...fixture.dialect,
        response: {
          ...fixture.dialect.response,
          completion: 'records-or-event',
          collection: 'root-array',
        },
      },
      {
        ...fixture.dialect,
        response: {
          ...fixture.dialect.response,
          completion: 'records-or-event',
          collection: 'root-object',
        },
      },
    ])
      expect(() => parseWriteDialect(value)).toThrow(
        'write dialect is invalid',
      );
  });

  it.each(['relative', '/', '/missing-write-repository'])(
    'rejects invalid repository root %s before credential access',
    async (repositoryRoot) => {
      const config = await configuration();
      await writeFile(
        config.configPath,
        JSON.stringify({
          ...config.instance,
          repositoryRoot:
            repositoryRoot === '/' ? parse(config.root).root : repositoryRoot,
        }),
      );
      let credentialRead = false;
      const env = new Proxy<NodeJS.ProcessEnv>(config.env, {
        get(target, key) {
          if (key === 'SYNTHETIC_MEMORY_TOKEN') credentialRead = true;
          return typeof key === 'string' ? target[key] : undefined;
        },
      });
      await expect(
        loadWriteRuntimeConfiguration({ env, cwd: config.root }),
      ).rejects.toThrow('repository root is invalid');
      expect(credentialRead).toBe(false);
    },
  );

  it('rejects an outside cwd and symlink escape without reading a credential', async () => {
    const config = await configuration();
    const outside = await configuration();
    const link = join(config.root, 'escape');
    await symlink(
      outside.root,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const env = new Proxy<NodeJS.ProcessEnv>(config.env, {
      get(target, key) {
        if (key === 'SYNTHETIC_MEMORY_TOKEN')
          throw new Error('credential was read');
        return typeof key === 'string' ? target[key] : undefined;
      },
    });
    for (const cwd of [outside.root, link, 'relative']) {
      await expect(loadWriteRuntimeConfiguration({ env, cwd })).rejects.toThrow(
        'writer is outside its repository',
      );
    }
  });

  it.each([
    { origin: 'https://credential@memory.example.com' },
    { origin: 'https://memory.example.com/path' },
    { origin: 'http://memory.example.com' },
    { origin: 'https://memory.example.com?query=bad' },
    { basePath: '/../escape' },
    { basePath: '//other.example.com' },
    { basePath: '/%2e%2e' },
  ])('rejects invalid endpoint/path $origin $basePath', async (endpoint) => {
    const config = await configuration();
    await writeFile(
      config.configPath,
      JSON.stringify({
        ...config.instance,
        endpoint: { ...config.instance.endpoint, ...endpoint },
      }),
    );
    await expect(
      loadWriteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).rejects.toThrow('invalid');
  });

  it('rejects mismatched scope placement and relative dialect paths', async () => {
    const config = await configuration();
    await writeFile(
      config.dialectPath,
      JSON.stringify({
        ...config.dialect,
        create: { ...config.dialect.create, userIdLocation: 'omit' },
      }),
    );
    await expect(
      loadWriteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).rejects.toThrow('scope is invalid');
    await writeFile(
      config.configPath,
      JSON.stringify({ ...config.instance, dialectPath: 'relative.json' }),
    );
    await expect(
      loadWriteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).rejects.toThrow('dialect path must be absolute');
  });

  it('rejects unavailable, nonregular, oversized and malformed files', async () => {
    const config = await configuration();
    for (const file of [config.root, join(config.root, 'missing')]) {
      await expect(
        loadWriteRuntimeConfiguration({
          env: { ...config.env, QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG: file },
          cwd: config.root,
        }),
      ).rejects.toThrow('configuration is unavailable');
    }
    for (const content of [' '.repeat(65537), '{broken json']) {
      await writeFile(config.configPath, content);
      await expect(
        loadWriteRuntimeConfiguration({ env: config.env, cwd: config.root }),
      ).rejects.toThrow('configuration is invalid');
    }
    await expect(
      loadWriteRuntimeConfiguration({
        env: {
          ...config.env,
          QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG: 'relative.json',
        },
        cwd: config.root,
      }),
    ).rejects.toThrow('path must be absolute');
  });

  it('requires a credential only after the entire valid binding is loaded', async () => {
    const config = await configuration();
    await expect(
      loadWriteRuntimeConfiguration({
        env: {
          ...config.env,
          SYNTHETIC_MEMORY_TOKEN: '${SYNTHETIC_MEMORY_TOKEN}',
        },
        cwd: config.root,
      }),
    ).rejects.toThrow('configuration is unavailable');
    config.instance.endpoint = {
      origin: 'http://127.0.0.1:9999',
      basePath: '',
      allowInsecureHttp: true,
    };
    await writeFile(config.configPath, JSON.stringify(config.instance));
    await expect(
      loadWriteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).resolves.toMatchObject({
      instance: { endpoint: config.instance.endpoint },
    });
  });
});
