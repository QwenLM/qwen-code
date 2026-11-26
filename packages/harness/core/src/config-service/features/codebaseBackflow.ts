/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_FEATURE_PREFIX } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import {
  parseBoolean,
  parseEnabledGateValue,
} from './gateParseUtils.js';

export const CODEBASE_BACKFLOW_FEATURE_GATE = 'codebase_backflow';
export const CODEBASE_BACKFLOW_FEATURE_ENV =
  `${ENV_FEATURE_PREFIX}CODEBASE_BACKFLOW`;

export interface CodebaseBackflowConfig {
  enabled: boolean;
  allowedOrgIds: readonly string[];
}

const DEFAULT_CONFIG: CodebaseBackflowConfig = {
  enabled: false,
  allowedOrgIds: [],
};

let currentConfig = DEFAULT_CONFIG;
const listeners = new Set<(enabled: boolean) => void>();

function getEnvironmentOverride(): boolean | undefined {
  const raw = process.env[CODEBASE_BACKFLOW_FEATURE_ENV];
  return raw === undefined || raw.trim() === ''
    ? undefined
    : parseEnabledGateValue(raw);
}

export function isCodebaseBackflowEnabled(): boolean {
  return getCodebaseBackflowConfig().enabled;
}

export function getCodebaseBackflowConfig(): CodebaseBackflowConfig {
  resolveRemoteConfig();
  const environmentOverride = getEnvironmentOverride();
  return environmentOverride === undefined
    ? currentConfig
    : { ...currentConfig, enabled: environmentOverride };
}

export function isCodebaseBackflowOrganizationAllowed(
  organizationId: string | undefined,
): boolean {
  if (!organizationId) return false;
  return getCodebaseBackflowConfig().allowedOrgIds.includes(organizationId);
}

function resolveRemoteConfig(): void {
  const remoteValue = getConfigValue(CODEBASE_BACKFLOW_FEATURE_GATE);
  if (remoteValue !== undefined) {
    const parsed = parseConfig(remoteValue);
    if (parsed !== undefined) currentConfig = parsed;
  }
}

function parseConfig(value: unknown): CodebaseBackflowConfig | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const enabled = parseBoolean(record['enabled']);
  const rawAllowedOrgIds = record['allowed_org_ids'];
  if (enabled === undefined || !Array.isArray(rawAllowedOrgIds)) {
    return undefined;
  }

  const allowedOrgIds: string[] = [];
  for (const rawOrgId of rawAllowedOrgIds) {
    if (typeof rawOrgId !== 'string' || rawOrgId.trim() === '') {
      return undefined;
    }
    allowedOrgIds.push(rawOrgId.trim());
  }

  return {
    enabled,
    allowedOrgIds: [...new Set(allowedOrgIds)],
  };
}

export function subscribeCodebaseBackflowEnabled(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  if (isCodebaseBackflowEnabled()) {
    queueMicrotask(() => {
      if (listeners.has(listener)) notifyListener(listener, true);
    });
  }
  return () => listeners.delete(listener);
}

function notifyListener(
  listener: (enabled: boolean) => void,
  enabled: boolean,
): void {
  try {
    listener(enabled);
  } catch (error) {
    runLogger.warn(
      '[config-service] codebase_backflow listener failed',
      error,
    );
  }
}

function notifyListeners(enabled: boolean): void {
  for (const listener of listeners) notifyListener(listener, enabled);
}

export function registerCodebaseBackflowFeature(): void {
  subscribeConfigValue(CODEBASE_BACKFLOW_FEATURE_GATE, (value) => {
    if (value === undefined) {
      return;
    }

    const parsed = parseConfig(value);
    if (parsed === undefined) {
      runLogger.warn(
        '[config-service] Ignoring invalid codebase_backflow feature gate value',
        { value },
      );
      return;
    }
    currentConfig = parsed;
    notifyListeners(getEnvironmentOverride() ?? parsed.enabled);
    runLogger.log(
      '[config-service] codebase_backflow feature gate value received',
      {
        enabled: parsed.enabled,
        allowedOrgCount: parsed.allowedOrgIds.length,
      },
    );
  });
}
