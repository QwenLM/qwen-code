/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import process from 'node:process';
import type { DesktopRuntimeResponse } from '../types.js';
import type { AcpSessionClient } from './sessionService.js';

let packageVersionPromise: Promise<string> | undefined;

export async function getRuntimeInfo(
  acpClient?: AcpSessionClient,
): Promise<DesktopRuntimeResponse> {
  const account = await getAccountInfo(acpClient);

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
      acpReady: acpClient?.isConnected === true,
    },
    platform: {
      type: platform(),
      arch: arch(),
      release: release(),
    },
    auth: {
      status:
        account && hasAccountSignal(account) ? 'authenticated' : 'unknown',
      account,
    },
  };
}

async function getAccountInfo(
  acpClient: AcpSessionClient | undefined,
): Promise<DesktopRuntimeResponse['auth']['account']> {
  if (!acpClient || acpClient.isConnected !== true) {
    return null;
  }

  try {
    const result = await acpClient.extMethod('getAccountInfo', {});
    return {
      authType: getNullableString(result['authType']),
      model: getNullableString(result['model']),
      baseUrl: getNullableString(result['baseUrl']),
      apiKeyEnvKey: getNullableString(result['apiKeyEnvKey']),
    };
  } catch {
    return null;
  }
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hasAccountSignal(
  account: NonNullable<DesktopRuntimeResponse['auth']['account']>,
): boolean {
  return Boolean(account.authType || account.model || account.baseUrl);
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
