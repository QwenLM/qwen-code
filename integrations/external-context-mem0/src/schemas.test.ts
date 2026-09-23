/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv, type AnySchema } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSearchUrl, loadRuntimeConfiguration } from './config.js';
import {
  ConfigurationError,
  parseDialect,
  parseInstanceConfig,
} from './schemas.js';
import type { DialectV1, InstanceConfigV2 } from './types.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Mem0 Extension schemas', () => {
  it('accepts InstanceConfigV2 and both synthetic dialect contracts', async () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const [instanceSchema, dialectSchema, post, get] = await Promise.all([
      readJson('../schemas/instance-config.schema.json'),
      readJson('../schemas/dialect.schema.json'),
      readFixture('synthetic-filtered-post-v1.json'),
      readFixture('synthetic-query-get-v1.json'),
    ]);
    const validateInstance = ajv.compile(instanceSchema as AnySchema);
    const validateDialect = ajv.compile(dialectSchema as AnySchema);

    for (const fixture of [post, get]) {
      expect(validateInstance(fixture.instance)).toBe(true);
      expect(validateInstance.errors).toBeNull();
      expect(validateDialect(fixture.dialect)).toBe(true);
      expect(validateDialect.errors).toBeNull();
      expect(parseInstanceConfig(fixture.instance).schemaVersion).toBe(2);
      expect(parseDialect(fixture.dialect).dialectVersion).toBe(1);
    }
  });

  it('rejects v1, v3, extra instance fields, and invalid dialects', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');

    expect(() =>
      parseInstanceConfig({
        ...fixture.instance,
        schemaVersion: 1,
        preset: 'legacy-preset-v1',
      }),
    ).toThrow('instance configuration is invalid');
    expect(() =>
      parseInstanceConfig({ ...fixture.instance, schemaVersion: 3 }),
    ).toThrow('instance configuration is invalid');
    expect(() =>
      parseInstanceConfig({
        ...fixture.instance,
        apiKey: 'credential-must-not-be-stored-here',
      }),
    ).toThrow('instance configuration is invalid');
    expect(() =>
      parseDialect({ ...fixture.dialect, dialectVersion: 2 }),
    ).toThrow('dialect configuration is invalid');
    expect(() =>
      parseDialect({
        ...fixture.dialect,
        headers: { 'x-tenant': '${MODEL_SELECTED_TENANT}' },
      }),
    ).toThrow('dialect configuration is invalid');
    expect(() =>
      parseDialect({
        ...fixture.dialect,
        response: {
          ...fixture.dialect.response,
          contentField: '$.results[*].memory',
        },
      }),
    ).toThrow('dialect configuration is invalid');
  });

  it('loads the instance, dialect, credential, endpoint, and scope at startup', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const instance = structuredClone(fixture.instance) as unknown as Record<
      string,
      unknown
    >;
    const endpoint = instance['endpoint'] as Record<string, unknown>;
    delete endpoint['basePath'];
    delete endpoint['allowInsecureHttp'];
    endpoint['origin'] = 'https://memory.example.com';
    const { configPath } = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
    );

    const runtime = await loadRuntimeConfiguration({
      env: runtimeEnvironment(configPath),
    });

    expect(runtime.instance.endpoint).toEqual({
      origin: 'https://memory.example.com',
      basePath: '',
      allowInsecureHttp: false,
    });
    expect(runtime.dialect.id).toBe('synthetic-query-get-v1');
    expect(runtime.credential).toBe('runtime-token');
  });

  it('treats the dialect id as an audit label rather than a lookup key', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const dialect = { ...fixture.dialect, id: 'customer-audit-label-v1' };
    const { configPath } = await writeRuntimeConfiguration(
      fixture.instance,
      dialect,
    );

    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(configPath) }),
    ).resolves.toMatchObject({ dialect: { id: 'customer-audit-label-v1' } });
  });

  it('fails closed for relative instance and dialect paths', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');

    await expect(
      loadRuntimeConfiguration({
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: 'relative.json',
        },
      }),
    ).rejects.toThrow('configuration path must be absolute');

    for (const dialectPath of [
      'relative.json',
      '${DIALECT_PATH}',
      'https://memory.example.com/dialect.json',
    ]) {
      const { configPath } = await writeRuntimeConfiguration(
        { ...fixture.instance, dialectPath },
        fixture.dialect,
        { preserveDialectPath: true },
      );
      await expect(
        loadRuntimeConfiguration({ env: runtimeEnvironment(configPath) }),
      ).rejects.toThrow('dialect path must be absolute');
    }
  });

  it('rejects blank, unresolved, and missing credentials after validation', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const { configPath } = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
    );

    for (const credential of [
      undefined,
      '   ',
      '${SYNTHETIC_MEMORY_TOKEN}',
      '  ${SYNTHETIC_MEMORY_TOKEN}  ',
    ]) {
      await expect(
        loadRuntimeConfiguration({
          env: {
            QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
            SYNTHETIC_MEMORY_TOKEN: credential,
          },
        }),
      ).rejects.toThrow('configuration is unavailable');
    }

    const preservedCredential = '  actual-token  ';
    await expect(
      loadRuntimeConfiguration({
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: preservedCredential,
        },
      }),
    ).resolves.toMatchObject({ credential: preservedCredential });

    const invalidDialect = {
      ...fixture.dialect,
      search: { ...fixture.dialect.search, path: '/safe/%2e' },
    };
    const invalid = await writeRuntimeConfiguration(
      fixture.instance,
      invalidDialect,
    );
    await expect(
      loadRuntimeConfiguration({
        env: { QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: invalid.configPath },
      }),
    ).rejects.toThrow('path is invalid');
  });

  it('bounds unavailable, malformed, and oversized instance files', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const directory = await makeTemporaryDirectory();

    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(join(directory, 'missing.json')),
      }),
    ).rejects.toThrow('instance configuration is unavailable');
    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(directory) }),
    ).rejects.toThrow('instance configuration is unavailable');

    const malformedPath = await writeStandaloneFile('instance.json', '{');
    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(malformedPath) }),
    ).rejects.toThrow('instance configuration is invalid');

    const exact = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
      {
        instanceSource: (instance) =>
          JSON.stringify(instance).padEnd(MAX_CONFIG_BYTES, ' '),
      },
    );
    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(exact.configPath) }),
    ).resolves.toMatchObject({ dialect: { id: fixture.dialect.id } });

    const oversized = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
      {
        instanceSource: (instance) =>
          JSON.stringify(instance).padEnd(MAX_CONFIG_BYTES + 1, ' '),
      },
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(oversized.configPath),
      }),
    ).rejects.toThrow('instance configuration is invalid');
  });

  it('bounds unavailable, malformed, and oversized dialect files', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const missingDirectory = await makeTemporaryDirectory();
    const missing = await writeRuntimeConfiguration(
      {
        ...fixture.instance,
        dialectPath: join(missingDirectory, 'missing.json'),
      },
      fixture.dialect,
      { preserveDialectPath: true },
    );
    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(missing.configPath) }),
    ).rejects.toThrow('dialect configuration is unavailable');

    const unreadable = await writeRuntimeConfiguration(
      { ...fixture.instance, dialectPath: missingDirectory },
      fixture.dialect,
      { preserveDialectPath: true },
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(unreadable.configPath),
      }),
    ).rejects.toThrow('dialect configuration is unavailable');

    const malformed = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
      { dialectSource: '{' },
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(malformed.configPath),
      }),
    ).rejects.toThrow('dialect configuration is invalid');

    const exact = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
      {
        dialectSource: JSON.stringify(fixture.dialect).padEnd(
          MAX_CONFIG_BYTES,
          ' ',
        ),
      },
    );
    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(exact.configPath) }),
    ).resolves.toMatchObject({ dialect: { id: fixture.dialect.id } });

    const oversized = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
      {
        dialectSource: JSON.stringify(fixture.dialect).padEnd(
          MAX_CONFIG_BYTES + 1,
          ' ',
        ),
      },
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(oversized.configPath),
      }),
    ).rejects.toThrow('dialect configuration is invalid');
  });

  it('joins a trailing-slash base path without introducing a double slash', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const instance = structuredClone(fixture.instance);
    instance.endpoint.basePath = '/tenant-a/';
    const { configPath } = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
    );
    const runtime = await loadRuntimeConfiguration({
      env: runtimeEnvironment(configPath),
    });

    expect(buildSearchUrl(runtime.instance, runtime.dialect).href).toBe(
      'https://memory.example.com/tenant-a/v2/memories/search/',
    );
  });

  it('accepts explicitly opted-in plain HTTP', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const { configPath } = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
    );

    const runtime = await loadRuntimeConfiguration({
      env: runtimeEnvironment(configPath),
    });

    expect(runtime.instance.endpoint).toMatchObject({
      origin: 'http://memory.internal:8080',
      allowInsecureHttp: true,
    });
  });

  it.each([
    {
      name: 'plain HTTP without opt-in',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.origin = 'http://memory.internal';
        instance.endpoint.allowInsecureHttp = false;
      },
    },
    {
      name: 'credentials in the origin',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.origin = 'https://user:password@memory.example.com';
      },
    },
    {
      name: 'path in the origin',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.origin = 'https://memory.example.com/api';
      },
    },
    {
      name: 'query in the origin',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.origin = 'https://memory.example.com?tenant=x';
      },
    },
    {
      name: 'fragment in the origin',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.origin = 'https://memory.example.com#tenant';
      },
    },
    {
      name: 'encoded base-path traversal, including double encoding',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.basePath = '/safe/%252e%252e/private';
      },
    },
    {
      name: 'ambiguous double slash',
      mutate: (instance: InstanceConfigV2) => {
        instance.endpoint.basePath = '/safe//private';
      },
    },
  ])('rejects $name', async ({ mutate }) => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const instance = parseInstanceConfig(structuredClone(fixture.instance));
    mutate(instance);
    const { configPath } = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
    );

    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(configPath) }),
    ).rejects.toThrow(ConfigurationError);
  });

  it.each([
    '/safe/../private',
    '/safe/%2e%2e/private',
    '/safe?tenant=x',
    '/safe\\private',
    '/safe//private',
  ])('rejects unsafe dialect search path %s', async (searchPath) => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const dialect = structuredClone(fixture.dialect);
    dialect.search.path = searchPath;
    const { configPath } = await writeRuntimeConfiguration(
      fixture.instance,
      dialect,
    );

    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(configPath) }),
    ).rejects.toThrow('path is invalid');
  });

  it('rejects scope fields not consumed exactly by the dialect', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const missing = structuredClone(fixture.instance);
    delete missing.scope.userId;
    const missingRuntime = await writeRuntimeConfiguration(
      missing,
      fixture.dialect,
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(missingRuntime.configPath),
      }),
    ).rejects.toThrow('scope is invalid');

    const extra = structuredClone(fixture.instance);
    extra.scope.appId = 'model-must-not-select-this';
    const extraRuntime = await writeRuntimeConfiguration(
      extra,
      fixture.dialect,
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(extraRuntime.configPath),
      }),
    ).rejects.toThrow('scope is invalid');
  });

  it('rejects JSON placement in a GET dialect', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const dialect = structuredClone(fixture.dialect);
    dialect.search.queryLocation = 'json';
    const { configPath } = await writeRuntimeConfiguration(
      fixture.instance,
      dialect,
    );

    await expect(
      loadRuntimeConfiguration({ env: runtimeEnvironment(configPath) }),
    ).rejects.toThrow('dialect is invalid');
  });
});

interface SyntheticFixture {
  instance: InstanceConfigV2;
  dialect: DialectV1;
}

interface RuntimeWriteOptions {
  preserveDialectPath?: boolean;
  instanceSource?: (instance: unknown) => string | Buffer;
  dialectSource?: string | Buffer;
}

async function readFixture(name: string): Promise<SyntheticFixture> {
  return (await readJson(`../test/fixtures/${name}`)) as SyntheticFixture;
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  ) as unknown;
}

async function writeRuntimeConfiguration(
  instance: unknown,
  dialect: unknown,
  options: RuntimeWriteOptions = {},
): Promise<{ configPath: string; dialectPath: string }> {
  const directory = await makeTemporaryDirectory();
  const configPath = join(directory, 'instance.json');
  const dialectPath = join(directory, 'dialect.json');
  const configuredInstance = {
    ...(instance as Record<string, unknown>),
    dialectPath: options.preserveDialectPath
      ? (instance as Record<string, unknown>)['dialectPath']
      : dialectPath,
  };
  await writeFile(
    dialectPath,
    options.dialectSource ?? JSON.stringify(dialect),
  );
  await writeFile(
    configPath,
    options.instanceSource?.(configuredInstance) ??
      JSON.stringify(configuredInstance),
  );
  return { configPath, dialectPath };
}

async function writeStandaloneFile(
  name: string,
  source: string | Buffer,
): Promise<string> {
  const directory = await makeTemporaryDirectory();
  const path = join(directory, name);
  await writeFile(path, source);
  return path;
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-mem0-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runtimeEnvironment(configPath: string): NodeJS.ProcessEnv {
  return {
    QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
    SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
  };
}
