/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ManagedExtensionProcessMode } from './managed-extension-process.js';

export interface ManagedExtensionRuntimeConfiguration {
  readonly enabled: true;
  readonly mode: ManagedExtensionProcessMode;
  readonly cacheDirectory: string;
  readonly cgroupRoot?: string;
}

export const MANAGED_EXTENSION_LINUX_CAPABILITY_DIGEST = `sha256:${createHash('sha256').update('managed-extension-execution/1;linux-process-tree/1').digest('hex')}`;
export const MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST = `sha256:${createHash('sha256').update('managed-extension-execution/1;darwin-developer-process-group/1').digest('hex')}`;

export function parseManagedExtensionRuntimeConfiguration(
  value: unknown,
  capabilityDigest: string,
): ManagedExtensionRuntimeConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Managed extension profile.');
  const config = value as Record<string, unknown>;
  if (
    ![
      'cacheDirectory,enabled,mode',
      'cacheDirectory,cgroupRoot,enabled,mode',
    ].includes(Object.keys(config).sort().join(',')) ||
    config['enabled'] !== true ||
    typeof config['cacheDirectory'] !== 'string' ||
    !path.isAbsolute(config['cacheDirectory']) ||
    config['cacheDirectory'].includes('\0') ||
    !(
      (config['mode'] === 'linux-cgroup' &&
        capabilityDigest === MANAGED_EXTENSION_LINUX_CAPABILITY_DIGEST) ||
      (config['mode'] === 'developer-process-group' &&
        capabilityDigest === MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST)
    )
  )
    throw new Error(
      'Managed extension profile conflicts with its capability digest.',
    );
  if (
    config['mode'] === 'linux-cgroup' &&
    (typeof config['cgroupRoot'] !== 'string' ||
      !path.isAbsolute(config['cgroupRoot']))
  )
    throw new Error(
      'Managed Linux extensions require a delegated cgroup root.',
    );
  if (
    config['mode'] === 'developer-process-group' &&
    config['cgroupRoot'] !== undefined
  )
    throw new Error('Developer process groups do not use cgroups.');
  return Object.freeze({
    enabled: true,
    mode: config['mode'],
    cacheDirectory: config['cacheDirectory'],
    ...(typeof config['cgroupRoot'] === 'string'
      ? { cgroupRoot: config['cgroupRoot'] }
      : {}),
  });
}
