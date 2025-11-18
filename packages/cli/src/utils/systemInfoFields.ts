/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtendedSystemInfo } from './systemInfo.js';

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
      label: 'CLI Version',
      key: 'cliVersion',
    },
    {
      label: 'Git Commit',
      key: 'gitCommit',
    },
    {
      label: 'Model',
      key: 'modelVersion',
    },
    {
      label: 'Sandbox',
      key: 'sandboxEnv',
    },
    {
      label: 'OS Platform',
      key: 'osPlatform',
    },
    {
      label: 'OS Arch',
      key: 'osArch',
    },
    {
      label: 'OS Release',
      key: 'osRelease',
    },
    {
      label: 'Node.js Version',
      key: 'nodeVersion',
    },
    {
      label: 'NPM Version',
      key: 'npmVersion',
    },
    {
      label: 'Session ID',
      key: 'sessionId',
    },
    {
      label: 'Auth Method',
      key: 'selectedAuthType',
    },
    {
      label: 'Base URL',
      key: 'baseUrl',
    },
    {
      label: 'Memory Usage',
      key: 'memoryUsage',
    },
    {
      label: 'IDE Client',
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
