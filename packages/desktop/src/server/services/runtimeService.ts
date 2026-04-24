/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import process from 'node:process';
import type { DesktopRuntimeResponse } from '../types.js';

let packageVersionPromise: Promise<string> | undefined;

export async function getRuntimeInfo(): Promise<DesktopRuntimeResponse> {
  return {
    ok: true,
    desktop: {
      version: await getDesktopVersion(),
      electronVersion: process.versions['electron'] ?? null,
      nodeVersion: process.versions.node,
    },
    cli: {
      path: process.env['QWEN_DESKTOP_CLI_PATH'] ?? null,
      channel: 'Desktop',
      acpReady: false,
    },
    platform: {
      type: platform(),
      arch: arch(),
      release: release(),
    },
    auth: {
      status: 'unknown',
      account: null,
    },
  };
}

function getDesktopVersion(): Promise<string> {
  packageVersionPromise ??= readDesktopPackageVersion();
  return packageVersionPromise;
}

async function readDesktopPackageVersion(): Promise<string> {
  const packageJsonUrl = new URL('../../../package.json', import.meta.url);
  const packageJson = JSON.parse(
    await readFile(packageJsonUrl, 'utf8'),
  ) as unknown;

  if (
    packageJson &&
    typeof packageJson === 'object' &&
    'version' in packageJson &&
    typeof packageJson.version === 'string'
  ) {
    return packageJson.version;
  }

  throw new Error('Desktop package version is missing.');
}
