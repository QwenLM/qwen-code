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

export interface SystemInfoDisplayField {
  label: string;
  value: string;
}

export function getSystemInfoFields(
  info: ExtendedSystemInfo,
): SystemInfoDisplayField[] {
  const fields: SystemInfoDisplayField[] = [];

  addField(fields, t('Qwen Code'), formatCliVersion(info));
  addField(fields, t('Runtime'), formatRuntime(info));
  addField(fields, t('IDE Client'), info.ideClient);
  addField(fields, t('OS'), formatOs(info));
  addField(fields, t('Auth'), formatAuth(info));
  addField(fields, t('Model'), info.modelVersion);
  addField(fields, t('Session ID'), info.sessionId);
  addField(fields, t('Sandbox'), info.sandboxEnv);
  addField(fields, t('Proxy'), formatProxy(info.proxy));
  addField(fields, t('Memory Usage'), info.memoryUsage);

  return fields;
}

function addField(
  fields: SystemInfoDisplayField[],
  label: string,
  value: string,
): void {
  if (value) {
    fields.push({ label, value });
  }
}

function formatCliVersion(info: ExtendedSystemInfo): string {
  if (!info.cliVersion) {
    return '';
  }
  if (!info.gitCommit) {
    return info.cliVersion;
  }
  return `${info.cliVersion} (${info.gitCommit})`;
}

function formatRuntime(info: ExtendedSystemInfo): string {
  if (!info.nodeVersion && !info.npmVersion) {
    return '';
  }
  const node = info.nodeVersion ? `Node.js ${info.nodeVersion}` : '';
  const npm = info.npmVersion ? `npm ${info.npmVersion}` : '';
  return joinParts([node, npm], ' / ');
}

function formatOs(info: ExtendedSystemInfo): string {
  return joinParts(
    [info.osPlatform, info.osArch, formatOsRelease(info.osRelease)],
    ' ',
  ).trim();
}

function formatOsRelease(release: string): string {
  if (!release) {
    return '';
  }
  return `(${release})`;
}

function formatAuth(info: ExtendedSystemInfo): string {
  if (!info.selectedAuthType) {
    return '';
  }
  const authType = formatAuthType(info.selectedAuthType);
  if (!info.baseUrl) {
    return authType;
  }
  return `${authType} (${info.baseUrl})`;
}

function formatAuthType(authType: string): string {
  return authType.startsWith('oauth') ? 'OAuth' : authType;
}

function formatProxy(proxy?: string): string {
  if (!proxy) {
    return 'no proxy';
  }
  return redactProxy(proxy);
}

function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return proxy.replace(/\/\/[^/]*@/, '//***@');
  }
}

function joinParts(parts: string[], separator: string): string {
  return parts.filter((part) => part).join(separator);
}
