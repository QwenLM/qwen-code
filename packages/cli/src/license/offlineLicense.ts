/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import prompts from 'prompts';
import {
  activateOfflineLicense,
  OfflineLicenseError,
  type OfflineLicenseStatus,
  verifyOfflineLicense,
} from '@qwen-code/qwen-code-core';

export interface OfflineLicenseSettings {
  licensePath: string;
  activationPath: string;
  publicKeyPem: string;
  requiredFeature: string;
}

export interface EnsureOfflineLicenseOptions extends OfflineLicenseSettings {
  interactive?: boolean;
}

export async function ensureOfflineLicense(
  options: EnsureOfflineLicenseOptions,
): Promise<OfflineLicenseStatus> {
  try {
    return await verifyOfflineLicense(options);
  } catch (error) {
    const interactive = options.interactive ?? isInteractive();
    if (
      !(error instanceof OfflineLicenseError) ||
      error.message !== 'Offline license is not activated.' ||
      !interactive
    ) {
      throw error;
    }
  }

  const activationHash = await promptForActivationHash();
  if (!activationHash) {
    throw new OfflineLicenseError('Offline license activation was cancelled.');
  }

  return await activateOfflineLicense({
    ...options,
    activationHash,
  });
}

async function promptForActivationHash(): Promise<string> {
  const response = await prompts({
    type: 'password',
    name: 'value',
    message: 'Enter offline activation code:',
  });
  return typeof response.value === 'string' ? response.value.trim() : '';
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
