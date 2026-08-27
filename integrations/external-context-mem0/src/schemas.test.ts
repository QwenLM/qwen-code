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
import type { DialectV1, InstanceConfigV1 } from './types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Mem0 Extension schemas', () => {
  it('accepts both synthetic dialect contracts', async () => {
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
      expect(parseInstanceConfig(fixture.instance).schemaVersion).toBe(1);
      expect(parseDialect(fixture.dialect).dialectVersion).toBe(1);
    }
  });

  it('rejects executable or open-ended dialect fields', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    expect(() =>
      parseDialect({
        ...fixture.dialect,
        headers: { 'x-tenant': '${MODEL_SELECTED_TENANT}' },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseDialect({
        ...fixture.dialect,
        response: {
          ...fixture.dialect.response,
          contentField: '$.results[*].memory',
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseInstanceConfig({
        ...fixture.instance,
        apiKey: 'credential-must-not-be-stored-here',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects unsupported instance and dialect versions', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');

    expect(() =>
      parseInstanceConfig({ ...fixture.instance, schemaVersion: 2 }),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseDialect({ ...fixture.dialect, dialectVersion: 2 }),
    ).toThrow(ConfigurationError);
  });

  it('loads one preset, credential, endpoint, and scope at startup', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const instance = structuredClone(fixture.instance) as unknown as Record<
      string,
      unknown
    >;
    const endpoint = instance['endpoint'] as Record<string, unknown>;
    delete endpoint['basePath'];
    delete endpoint['allowInsecureHttp'];
    endpoint['origin'] = 'https://memory.example.com';
    const configPath = await writeConfig(instance);

    const runtime = await loadRuntimeConfiguration({
      presets: new Map([[fixture.dialect.id, fixture.dialect]]),
      env: {
        QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
        SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
      },
    });

    expect(runtime.instance.endpoint).toEqual({
      origin: 'https://memory.example.com',
      basePath: '',
      allowInsecureHttp: false,
    });
    expect(runtime.dialect.id).toBe('synthetic-query-get-v1');
    expect(runtime.credential).toBe('runtime-token');
  });

  it('fails closed for relative paths, unknown presets, and missing credentials', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const presets = new Map([[fixture.dialect.id, fixture.dialect]]);

    await expect(
      loadRuntimeConfiguration({
        presets,
        env: { QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: 'relative.json' },
      }),
    ).rejects.toThrow('configuration path must be absolute');

    const unknownPath = await writeConfig({
      ...fixture.instance,
      preset: 'unknown-v1',
    });
    await expect(
      loadRuntimeConfiguration({
        presets,
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: unknownPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('preset is unknown');

    const configPath = await writeConfig(fixture.instance);
    await expect(
      loadRuntimeConfiguration({
        presets,
        env: { QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath },
      }),
    ).rejects.toThrow('configuration is unavailable');
  });

  it('rejects blank and unresolved credentials', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const presets = new Map([[fixture.dialect.id, fixture.dialect]]);
    const configPath = await writeConfig(fixture.instance);

    for (const credential of [
      '   ',
      '${SYNTHETIC_MEMORY_TOKEN}',
      '  ${SYNTHETIC_MEMORY_TOKEN}  ',
    ]) {
      await expect(
        loadRuntimeConfiguration({
          presets,
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
        presets,
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: preservedCredential,
        },
      }),
    ).resolves.toMatchObject({ credential: preservedCredential });
  });

  it('fails closed for unavailable, malformed, and oversized configuration files', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const presets = new Map([[fixture.dialect.id, fixture.dialect]]);
    const directory = await makeTemporaryDirectory();
    const environment = {
      SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
    };

    await expect(
      loadRuntimeConfiguration({
        presets,
        env: {
          ...environment,
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: join(directory, 'missing.json'),
        },
      }),
    ).rejects.toThrow('configuration is unavailable');

    const malformedPath = await writeConfigSource('{');
    await expect(
      loadRuntimeConfiguration({
        presets,
        env: {
          ...environment,
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: malformedPath,
        },
      }),
    ).rejects.toThrow('configuration is invalid');

    const exactLimitSource = JSON.stringify(fixture.instance).padEnd(
      64 * 1024,
      ' ',
    );
    const exactLimitPath = await writeConfigSource(exactLimitSource);
    await expect(
      loadRuntimeConfiguration({
        presets,
        env: {
          ...environment,
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: exactLimitPath,
        },
      }),
    ).resolves.toMatchObject({ dialect: { id: fixture.dialect.id } });

    const oversizedPath = await writeConfigSource(`${exactLimitSource} `);
    await expect(
      loadRuntimeConfiguration({
        presets,
        env: {
          ...environment,
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: oversizedPath,
        },
      }),
    ).rejects.toThrow('configuration is invalid');
  });

  it('rejects a preset whose id differs from its registry key', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const configPath = await writeConfig(fixture.instance);

    await expect(
      loadRuntimeConfiguration({
        presets: new Map([
          [
            fixture.instance.preset,
            { ...fixture.dialect, id: 'different-preset-v1' },
          ],
        ]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('preset is invalid');
  });

  it('joins a trailing-slash base path without introducing a double slash', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const instance = structuredClone(fixture.instance);
    instance.endpoint.basePath = '/tenant-a/';
    const configPath = await writeConfig(instance);
    const runtime = await loadRuntimeConfiguration({
      presets: new Map([[fixture.dialect.id, fixture.dialect]]),
      env: {
        QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
        SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
      },
    });

    expect(buildSearchUrl(runtime.instance, runtime.dialect).href).toBe(
      'https://memory.example.com/tenant-a/v2/memories/search/',
    );
  });

  it('accepts explicitly opted-in plain HTTP', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const configPath = await writeConfig(fixture.instance);

    const runtime = await loadRuntimeConfiguration({
      presets: new Map([[fixture.dialect.id, fixture.dialect]]),
      env: {
        QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
        SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
      },
    });

    expect(runtime.instance.endpoint).toMatchObject({
      origin: 'http://memory.internal:8080',
      allowInsecureHttp: true,
    });
  });

  it.each([
    {
      name: 'plain HTTP without opt-in',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.origin = 'http://memory.internal';
        instance.endpoint.allowInsecureHttp = false;
      },
    },
    {
      name: 'credentials in the origin',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.origin = 'https://user:password@memory.example.com';
      },
    },
    {
      name: 'path in the origin',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.origin = 'https://memory.example.com/api';
      },
    },
    {
      name: 'query in the origin',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.origin = 'https://memory.example.com?tenant=x';
      },
    },
    {
      name: 'fragment in the origin',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.origin = 'https://memory.example.com#tenant';
      },
    },
    {
      name: 'encoded base-path traversal, including double encoding',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.basePath = '/safe/%252e%252e/private';
      },
    },
    {
      name: 'ambiguous double slash',
      mutate: (instance: InstanceConfigV1) => {
        instance.endpoint.basePath = '/safe//private';
      },
    },
  ])('rejects $name', async ({ mutate }) => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const instance = parseInstanceConfig(structuredClone(fixture.instance));
    mutate(instance);
    const configPath = await writeConfig(instance);

    await expect(
      loadRuntimeConfiguration({
        presets: new Map([[fixture.dialect.id, fixture.dialect]]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it.each([
    '/safe/../private',
    '/safe/%2e%2e/private',
    '/safe?tenant=x',
    '/safe\\private',
    '/safe//private',
  ])('rejects unsafe preset search path %s', async (searchPath) => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const dialect = structuredClone(fixture.dialect) as DialectV1;
    dialect.search.path = searchPath;
    const configPath = await writeConfig(fixture.instance);

    await expect(
      loadRuntimeConfiguration({
        presets: new Map([[dialect.id, dialect]]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('path is invalid');
  });

  it('rejects scope fields not consumed exactly by the preset', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const missing = structuredClone(fixture.instance);
    delete missing.scope.userId;
    const missingPath = await writeConfig(missing);
    await expect(
      loadRuntimeConfiguration({
        presets: new Map([[fixture.dialect.id, fixture.dialect]]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: missingPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('scope is invalid');

    const extra = structuredClone(fixture.instance);
    extra.scope.appId = 'model-must-not-select-this';
    const extraPath = await writeConfig(extra);
    await expect(
      loadRuntimeConfiguration({
        presets: new Map([[fixture.dialect.id, fixture.dialect]]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: extraPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('scope is invalid');
  });

  it('rejects JSON placement in a GET dialect', async () => {
    const fixture = await readFixture('synthetic-query-get-v1.json');
    const dialect = structuredClone(fixture.dialect) as DialectV1;
    dialect.search.queryLocation = 'json';
    const configPath = await writeConfig(fixture.instance);

    await expect(
      loadRuntimeConfiguration({
        presets: new Map([[dialect.id, dialect]]),
        env: {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
          SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
        },
      }),
    ).rejects.toThrow('preset is invalid');
  });
});

interface SyntheticFixture {
  instance: InstanceConfigV1;
  dialect: DialectV1;
}

async function readFixture(name: string): Promise<SyntheticFixture> {
  return (await readJson(`../test/fixtures/${name}`)) as SyntheticFixture;
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  ) as unknown;
}

async function writeConfig(value: unknown): Promise<string> {
  return writeConfigSource(JSON.stringify(value));
}

async function writeConfigSource(value: string | Buffer): Promise<string> {
  const directory = await makeTemporaryDirectory();
  const path = join(directory, 'config.json');
  await writeFile(path, value);
  return path;
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-mem0-config-'));
  temporaryDirectories.push(directory);
  return directory;
}
