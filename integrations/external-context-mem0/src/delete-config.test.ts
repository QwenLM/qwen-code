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
import fixture from '../test/fixtures/synthetic-delete-v1.json' with { type: 'json' };
import {
  parseDeleteDialect,
  parseDeleteInstanceConfig,
  parseInstanceConfig,
  parseAutoRecallInstanceConfig,
  parseWriteInstanceConfig,
} from './schemas.js';
import { loadDeleteRuntimeConfiguration } from './delete-config.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function configuration() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mem0-delete-config-')),
  );
  directories.push(root);
  const configPath = join(root, 'instance.json');
  const dialectPath = join(root, 'dialect.json');
  const instance = {
    ...structuredClone(fixture.instance),
    repositoryRoot: root,
    dialectPath,
  };
  const env = {
    QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG: configPath,
    SYNTHETIC_MEMORY_TOKEN: 'synthetic-token',
  };
  await writeFile(configPath, JSON.stringify(instance));
  await writeFile(dialectPath, JSON.stringify(fixture.dialect));
  return { root, configPath, dialectPath, instance, env };
}

describe('Mem0 deletion configuration', () => {
  it('loads V5 and defaults while keeping other versions separate', async () => {
    const config = await configuration();
    const cwd = join(config.root, 'child');
    await mkdir(cwd);
    expect(
      await loadDeleteRuntimeConfiguration({ env: config.env, cwd }),
    ).toEqual({
      instance: config.instance,
      dialect: fixture.dialect,
      credential: 'synthetic-token',
    });
    expect(
      parseDeleteInstanceConfig({
        ...fixture.instance,
        endpoint: { origin: 'https://memory.example.com' },
      }).endpoint,
    ).toEqual({
      origin: 'https://memory.example.com',
      basePath: '',
      allowInsecureHttp: false,
    });
    for (const parser of [
      parseInstanceConfig,
      parseAutoRecallInstanceConfig,
      parseWriteInstanceConfig,
    ])
      expect(() => parser(fixture.instance)).toThrow('invalid');
    for (const schemaVersion of [2, 3, 4])
      expect(() =>
        parseDeleteInstanceConfig({ ...fixture.instance, schemaVersion }),
      ).toThrow('invalid');
  });

  it.each([
    { scope: {} },
    { scope: { userId: '' } },
    { scope: { arbitrary: 'scope' } },
    { timeoutMs: 99 },
    { timeoutMs: 30001 },
    { timeoutMs: 1.5 },
    { delete: true },
  ])('rejects invalid instance %j', (patch) => {
    expect(() =>
      parseDeleteInstanceConfig({ ...fixture.instance, ...patch }),
    ).toThrow('delete configuration is invalid');
  });

  it.each([
    { pathPrefix: '/memories' },
    { pathSuffix: '/other' },
    { notFound: 'any-2xx' },
    { idField: 'metadata.id' },
    { contentField: 'summary' },
    { scopeLocation: 'metadata' },
    { method: 'POST' },
    { body: {} },
  ])('rejects expanded dialect %j', (patch) => {
    expect(() =>
      parseDeleteDialect({
        ...fixture.dialect,
        record: { ...fixture.dialect.record, ...patch },
      }),
    ).toThrow('delete dialect is invalid');
  });

  it.each([
    '/../memories/',
    '//other.example.com/',
    '/%2e/',
    '/a\\b/',
    '/memories/?/',
    '/memories/#/',
    '/memories/\n',
  ])(
    'rejects unsafe record prefix %j before credentials',
    async (pathPrefix) => {
      const config = await configuration();
      await writeFile(
        config.dialectPath,
        JSON.stringify({
          ...fixture.dialect,
          record: { ...fixture.dialect.record, pathPrefix },
        }),
      );
      const env = new Proxy<NodeJS.ProcessEnv>(config.env, {
        get(target, key) {
          if (key === 'SYNTHETIC_MEMORY_TOKEN')
            throw new Error('credential read too early');
          return typeof key === 'string' ? target[key] : undefined;
        },
      });
      await expect(
        loadDeleteRuntimeConfiguration({ env, cwd: config.root }),
      ).rejects.toThrow('invalid');
    },
  );

  it('rejects roots, outside cwd and symlink escape before credentials', async () => {
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
          throw new Error('credential read too early');
        return typeof key === 'string' ? target[key] : undefined;
      },
    });
    for (const cwd of [outside.root, link, 'relative', config.configPath])
      await expect(
        loadDeleteRuntimeConfiguration({ env, cwd }),
      ).rejects.toThrow('outside its repository');
    for (const repositoryRoot of [
      parse(config.root).root,
      config.configPath,
      join(config.root, 'missing'),
      'relative',
    ]) {
      await writeFile(
        config.configPath,
        JSON.stringify({ ...config.instance, repositoryRoot }),
      );
      await expect(
        loadDeleteRuntimeConfiguration({ env, cwd: config.root }),
      ).rejects.toThrow('repository root is invalid');
    }
  });

  it.each([
    { origin: 'http://memory.example.com' },
    { origin: 'https://user:password@memory.example.com' },
    { origin: 'https://memory.example.com/path' },
    { origin: 'https://memory.example.com?query=bad' },
    { basePath: '/../escape' },
    { basePath: '//host' },
    { basePath: '/%2e' },
  ])('rejects unsafe endpoint %j', async (endpoint) => {
    const config = await configuration();
    await writeFile(
      config.configPath,
      JSON.stringify({
        ...config.instance,
        endpoint: { ...config.instance.endpoint, ...endpoint },
      }),
    );
    await expect(
      loadDeleteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).rejects.toThrow('invalid');
  });

  it('bounds config files and requires absolute regular paths', async () => {
    const config = await configuration();
    for (const file of [config.root, join(config.root, 'missing')])
      await expect(
        loadDeleteRuntimeConfiguration({
          env: {
            ...config.env,
            QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG: file,
          },
          cwd: config.root,
        }),
      ).rejects.toThrow('unavailable');
    await expect(
      loadDeleteRuntimeConfiguration({
        env: {
          ...config.env,
          QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG: 'relative',
        },
        cwd: config.root,
      }),
    ).rejects.toThrow('must be absolute');
    for (const file of [config.configPath, config.dialectPath]) {
      for (const content of [' '.repeat(65537), '{bad']) {
        await writeFile(file, content);
        await expect(
          loadDeleteRuntimeConfiguration({ env: config.env, cwd: config.root }),
        ).rejects.toThrow('invalid');
      }
      await writeFile(config.configPath, JSON.stringify(config.instance));
    }
    await writeFile(
      config.configPath,
      JSON.stringify({ ...config.instance, dialectPath: 'relative' }),
    );
    await expect(
      loadDeleteRuntimeConfiguration({ env: config.env, cwd: config.root }),
    ).rejects.toThrow('dialect path must be absolute');
  });

  it('rejects unresolved credentials after loading an otherwise valid binding', async () => {
    const config = await configuration();
    await expect(
      loadDeleteRuntimeConfiguration({
        env: {
          ...config.env,
          SYNTHETIC_MEMORY_TOKEN: '${SYNTHETIC_MEMORY_TOKEN}',
        },
        cwd: config.root,
      }),
    ).rejects.toThrow('unavailable');
  });
});
