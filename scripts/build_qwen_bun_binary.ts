#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  buildBunBinary,
  type BunBinaryBuildOptions,
} from './bun-binary-compiler.ts';
import {
  commonBuildDefine,
  repoRoot,
  resolveBytecodeOptions,
  resolveSplittingOptions,
  resolveBunCompileExecArgv,
} from './bun-build-config.ts';
import { buildWindowsVersionInfoArgs } from './windows-version-info.js';

export function qwenBinaryBuildOptions(
  args = process.argv.slice(2),
): BunBinaryBuildOptions {
  const root = repoRoot();
  const pkg = createRequire(import.meta.url)(
    path.join(root, 'package.json'),
  ) as { version: string };
  const brand = {
    cliBin: 'qwen',
    productName: 'Qwen Code',
    companyName: 'Qwen Team',
    legalCopyright: 'Copyright (C) 2026 Qwen Team',
  };
  const binaryName = process.env['PRODUCT_NAME'] || 'qwen';
  const entrypoint = path.resolve(root, 'packages/cli/bin.ts');
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
  const icon = path.join(root, `assets/${binaryName}.ico`);
  const releaseBaseUrl = process.env['QWEN_CODE_RELEASE_BASE_URL'] || undefined;
  return {
    entrypoint,
    binaryName,
    version: pkg.version,
    target,
    runtimeAssetIds: ['builtin-skills'],
    compileOptions: () => ({
      bytecode: resolveBytecodeOptions(),
      splitting: resolveSplittingOptions(),
      execArgv: resolveBunCompileExecArgv(),
    }),
    windowsIconPath: existsSync(icon) ? icon : undefined,
    windowsVersionInfoArgs: (binaryPath) =>
      buildWindowsVersionInfoArgs(brand, pkg.version, binaryPath),
    define: {
      ...commonBuildDefine({
        pkgVersion: pkg.version,
      }),
      ...(releaseBaseUrl
        ? {
            'process.env.QWEN_CODE_RELEASE_BASE_URL':
              JSON.stringify(releaseBaseUrl),
          }
        : {}),
    },
  };
}

if (import.meta.main) await buildBunBinary(qwenBinaryBuildOptions());
