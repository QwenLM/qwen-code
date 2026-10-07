/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { Ajv, type AnySchema } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isWithinRepository,
  loadAutoRecallRuntimeConfiguration,
  loadRuntimeConfiguration,
} from './config.js';
import { parseAutoRecallInstanceConfig } from './schemas.js';
import type { DialectV1, InstanceConfigV2 } from './types.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Mem0 Auto Recall configuration', () => {
  it('accepts the canonical v3 schema and resolves the repository root', async () => {
    const fixture = await readFixture();
    const directory = await makeTemporaryDirectory();
    const instance = autoRecallInstance(fixture.instance, directory);
    const schema = await readJson(
      '../schemas/auto-recall-instance-config.schema.json',
    );
    const validate = new Ajv({ allErrors: true, strict: true }).compile(
      schema as AnySchema,
    );

    expect(validate(instance)).toBe(true);
    expect(parseAutoRecallInstanceConfig(instance).schemaVersion).toBe(3);
    const { configPath } = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
    );

    await expect(
      loadAutoRecallRuntimeConfiguration({
        env: runtimeEnvironment(configPath),
      }),
    ).resolves.toMatchObject({
      instance: {
        schemaVersion: 3,
        autoRecall: { repositoryRoot: await realpath(directory) },
      },
      dialect: { id: fixture.dialect.id },
      credential: 'runtime-token',
    });
  });

  it('rejects on-demand, unknown, and extended configuration shapes', async () => {
    const fixture = await readFixture();
    const directory = await makeTemporaryDirectory();
    const instance = autoRecallInstance(fixture.instance, directory);

    expect(() => parseAutoRecallInstanceConfig(fixture.instance)).toThrow(
      'auto-recall configuration is invalid',
    );
    expect(() =>
      parseAutoRecallInstanceConfig({ ...instance, schemaVersion: 4 }),
    ).toThrow('auto-recall configuration is invalid');
    expect(() =>
      parseAutoRecallInstanceConfig({
        ...instance,
        autoRecall: {
          ...instance.autoRecall,
          dynamicScope: true,
        },
      }),
    ).toThrow('auto-recall configuration is invalid');

    const autoRecall = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
    );
    await expect(
      loadRuntimeConfiguration({
        env: runtimeEnvironment(autoRecall.configPath),
      }),
    ).rejects.toThrow('instance configuration is invalid');

    const onDemand = await writeRuntimeConfiguration(
      fixture.instance,
      fixture.dialect,
    );
    await expect(
      loadAutoRecallRuntimeConfiguration({
        env: runtimeEnvironment(onDemand.configPath),
      }),
    ).rejects.toThrow('auto-recall configuration is invalid');
  });

  it('requires an Auto Recall timeout from 100 through 5000 milliseconds', async () => {
    const fixture = await readFixture();
    const repositoryRoot = await makeTemporaryDirectory();
    const instance = autoRecallInstance(fixture.instance, repositoryRoot);

    for (const timeoutMs of [100, 5000]) {
      expect(
        parseAutoRecallInstanceConfig({ ...instance, timeoutMs }).timeoutMs,
      ).toBe(timeoutMs);
    }
    for (const timeoutMs of [99, 5001]) {
      expect(() =>
        parseAutoRecallInstanceConfig({ ...instance, timeoutMs }),
      ).toThrow('auto-recall configuration is invalid');
    }
  });

  it('rejects relative, missing, and filesystem-root repositories', async () => {
    const fixture = await readFixture();
    const directory = await makeTemporaryDirectory();
    for (const repositoryRoot of [
      'relative/repository',
      join(directory, 'missing'),
      parse(process.cwd()).root,
    ]) {
      const instance = autoRecallInstance(fixture.instance, repositoryRoot);
      const { configPath } = await writeRuntimeConfiguration(
        instance,
        fixture.dialect,
      );

      await expect(
        loadAutoRecallRuntimeConfiguration({
          env: runtimeEnvironment(configPath),
        }),
      ).rejects.toThrow('repository root is invalid');
    }
  });

  it('allows canonical descendants and rejects paths outside the repository', async () => {
    const repositoryRoot = await makeTemporaryDirectory();
    const canonicalRoot = await realpath(repositoryRoot);
    const child = join(repositoryRoot, 'child');
    const outside = await makeTemporaryDirectory();
    await mkdir(child);

    await expect(isWithinRepository(canonicalRoot, child)).resolves.toBe(true);
    await expect(isWithinRepository(canonicalRoot, outside)).resolves.toBe(
      false,
    );
    await expect(
      isWithinRepository(canonicalRoot, 'relative/repository'),
    ).resolves.toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a descendant path that resolves outside through a symbolic link',
    async () => {
      const repositoryRoot = await makeTemporaryDirectory();
      const canonicalRoot = await realpath(repositoryRoot);
      const outside = await makeTemporaryDirectory();
      const escaped = join(repositoryRoot, 'escaped');
      await symlink(outside, escaped, 'dir');

      await expect(isWithinRepository(canonicalRoot, escaped)).resolves.toBe(
        false,
      );
    },
  );

  it('keeps the v3 instance file bounded', async () => {
    const fixture = await readFixture();
    const repositoryRoot = await makeTemporaryDirectory();
    const instance = autoRecallInstance(fixture.instance, repositoryRoot);
    const exact = await writeRuntimeConfiguration(instance, fixture.dialect, {
      instanceSource: (configured) =>
        JSON.stringify(configured).padEnd(MAX_CONFIG_BYTES, ' '),
    });
    await expect(
      loadAutoRecallRuntimeConfiguration({
        env: runtimeEnvironment(exact.configPath),
      }),
    ).resolves.toMatchObject({ instance: { schemaVersion: 3 } });

    const oversized = await writeRuntimeConfiguration(
      instance,
      fixture.dialect,
      {
        instanceSource: (configured) =>
          JSON.stringify(configured).padEnd(MAX_CONFIG_BYTES + 1, ' '),
      },
    );
    await expect(
      loadAutoRecallRuntimeConfiguration({
        env: runtimeEnvironment(oversized.configPath),
      }),
    ).rejects.toThrow('instance configuration is invalid');
  });
});

interface SyntheticFixture {
  instance: InstanceConfigV2;
  dialect: DialectV1;
}

interface RuntimeWriteOptions {
  instanceSource?: (instance: unknown) => string;
}

function autoRecallInstance(
  instance: InstanceConfigV2,
  repositoryRoot: string,
) {
  return {
    ...structuredClone(instance),
    schemaVersion: 3 as const,
    autoRecall: { repositoryRoot },
    timeoutMs: 1500,
  };
}

async function readFixture(): Promise<SyntheticFixture> {
  return (await readJson(
    '../test/fixtures/synthetic-filtered-post-v1.json',
  )) as SyntheticFixture;
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
): Promise<{ configPath: string }> {
  const directory = await makeTemporaryDirectory();
  const configPath = join(directory, 'instance.json');
  const dialectPath = join(directory, 'dialect.json');
  const configuredInstance = {
    ...(instance as Record<string, unknown>),
    dialectPath,
  };
  await writeFile(dialectPath, JSON.stringify(dialect));
  await writeFile(
    configPath,
    options.instanceSource?.(configuredInstance) ??
      JSON.stringify(configuredInstance),
  );
  return { configPath };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-mem0-auto-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runtimeEnvironment(configPath: string): NodeJS.ProcessEnv {
  return {
    QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
    SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
  };
}
