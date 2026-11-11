/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { qwenBinaryBuildOptions } from '../build_qwen_bun_binary.ts';
import {
  commonBuildDefine,
  resolveBytecodeOptions,
  resolveSplittingOptions,
} from '../bun-build-config.ts';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Qwen release source build configuration', () => {
  it('keeps Qwen identity in bundled code despite launch environment overrides', async () => {
    const { build } = await import('esbuild');
    const directory = await mkdtemp(join(tmpdir(), 'qwen-brand-build-'));
    temporary.push(directory);
    const entry = join(directory, 'brand.cjs');
    await build({
      entryPoints: [
        resolve(import.meta.dirname, '../../packages/core/src/config/brand.ts'),
      ],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: commonBuildDefine({ pkgVersion: '1.0.0' }),
    });
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        'const brand=require(process.argv[1]);process.stdout.write(JSON.stringify([brand.BRAND_NAME,brand.BRAND_CLI_BIN,brand.BRAND_USER_CONFIG_DIR_NAME,brand.BRAND_PLUGIN_META_DIR]))',
        entry,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BRAND_NAME: 'Other product',
          BRAND_CLI_BIN: 'other-cli',
          BRAND_USER_CONFIG_DIR_NAME: '.other',
          BRAND_PLUGIN_META_DIR: '.other-plugin',
        },
      },
    );
    expect(JSON.parse(output)).toEqual([
      'Qwen Code',
      'qwen',
      '.qwen',
      '.qwen-plugin',
    ]);
  });

  it('uses Qwen environment switches for default compiler options', () => {
    vi.stubEnv('QWEN_CODE_BYTECODE_ENABLE', '0');
    vi.stubEnv('QWEN_CODE_SPLITTING_ENABLE', '0');
    expect(resolveBytecodeOptions()).toEqual({});
    expect(resolveSplittingOptions()).toEqual({});
    expect(qwenBinaryBuildOptions([]).compileOptions?.()).toEqual({
      bytecode: {},
      splitting: {},
      execArgv: ['--use-system-ca', '--no-deprecation'],
    });
  });

  it('passes Qwen identity and paths with spaces to the Windows version patcher', () => {
    const binaryPath = 'C:\\构建 目录\\qwen.exe';
    const args = qwenBinaryBuildOptions([]).windowsVersionInfoArgs(binaryPath);
    expect(args[0]).toBe(binaryPath);
    const fields = Object.fromEntries(
      Array.from({ length: (args.length - 1) / 2 }, (_, index) => [
        args[index * 2 + 1],
        args[index * 2 + 2],
      ]),
    );
    expect(fields).toMatchObject({
      '--product-name': 'Qwen Code',
      '--company-name': 'Qwen Team',
      '--internal-name': 'qwen',
      '--original-filename': 'qwen.exe',
    });
  });

  it('bakes the selected source into the binary independently of runtime environment', async () => {
    const { build } = await import('esbuild');
    const directory = await mkdtemp(join(tmpdir(), 'qwen-binary-build-'));
    temporary.push(directory);
    const base = 'https://bucket.example.test/qwencode/1.x';
    const entry = join(directory, 'source.cjs');
    vi.stubEnv('QWEN_CODE_RELEASE_BASE_URL', base);
    await build({
      entryPoints: [
        resolve(
          import.meta.dirname,
          '../../packages/cli/src/installation/qwen/paths.ts',
        ),
      ],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: qwenBinaryBuildOptions([]).define,
    });
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        'const config=require(process.argv[1]);process.stdout.write(config.getQwenReleaseBaseURL())',
        entry,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          QWEN_CODE_RELEASE_BASE_URL: 'https://different.example.test',
        },
      },
    );
    expect(output).toBe(base);
  });
});
