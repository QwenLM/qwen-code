/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtendedSystemInfo } from './systemInfo.js';
import { t } from '../i18n/index.js';

/**
 * Field configuration for system information display
 */
export interface SystemInfoField {
  label: string;
  key: keyof ExtendedSystemInfo;
}

/**
 * Unified field configuration for system information display.
 * This ensures consistent labeling between /about and /bug commands.
 */
export function getSystemInfoFields(
  info: ExtendedSystemInfo,
): SystemInfoField[] {
  const allFields: SystemInfoField[] = [
    {
      label: t('CLI Version'),
      key: 'cliVersion',
    },
    {
      label: t('Git Commit'),
      key: 'gitCommit',
    },
    {
      label: t('Model'),
      key: 'modelVersion',
    },
    {
      label: t('Sandbox'),
      key: 'sandboxEnv',
    },
    {
      label: t('OS Platform'),
      key: 'osPlatform',
    },
    {
      label: t('OS Arch'),
      key: 'osArch',
    },
    {
      label: t('OS Release'),
      key: 'osRelease',
    },
    {
      label: t('Node.js Version'),
      key: 'nodeVersion',
    },
    {
      label: t('NPM Version'),
      key: 'npmVersion',
    },
    {
      label: t('Session ID'),
      key: 'sessionId',
    },
    {
      label: t('Auth Method'),
      key: 'selectedAuthType',
    },
    {
      label: t('Base URL'),
      key: 'baseUrl',
    },
    {
      label: t('Memory Usage'),
      key: 'memoryUsage',
    },
    {
      label: t('IDE Client'),
      key: 'ideClient',
    },
  ];

  // Filter out optional fields that are not present
  return allFields.filter((field) => {
    const value = info[field.key];
    // Optional fields: only show if they exist and are non-empty
    if (
      field.key === 'baseUrl' ||
      field.key === 'gitCommit' ||
      field.key === 'ideClient'
    ) {
      return Boolean(value);
    }
    return true;
  });
}

/**
 * Get the value for a field from system info
 */
export function getFieldValue(
  field: SystemInfoField,
  info: ExtendedSystemInfo,
): string {
  const value = info[field.key];

  if (value === undefined || value === null) {
    return '';
  }

  // Special formatting for selectedAuthType
  if (field.key === 'selectedAuthType') {
    return String(value).startsWith('oauth') ? 'OAuth' : String(value);
  }

  return String(value);
}
