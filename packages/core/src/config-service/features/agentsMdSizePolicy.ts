/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getConfigValue, subscribeConfigValue } from '../index.js';

export const AGENTS_MD_SIZE_POLICY_KEY = 'agents_md_size_policy';
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32_768;

export interface AgentsMdSizePolicy {
  projectDocMaxBytes: number;
  source: 'qcs' | 'default';
}

export function parseAgentsMdSizePolicy(value: unknown): AgentsMdSizePolicy {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const bytes =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['project_doc_max_bytes']
      : undefined;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0
    ? { projectDocMaxBytes: bytes, source: 'qcs' }
    : { projectDocMaxBytes: DEFAULT_PROJECT_DOC_MAX_BYTES, source: 'default' };
}

export function getAgentsMdSizePolicy(): AgentsMdSizePolicy {
  return parseAgentsMdSizePolicy(getConfigValue(AGENTS_MD_SIZE_POLICY_KEY));
}

const listeners = new Set<(policy: AgentsMdSizePolicy) => void>();

export function onAgentsMdSizePolicyChanged(
  listener: (policy: AgentsMdSizePolicy) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerAgentsMdSizePolicyFeature(): void {
  subscribeConfigValue(AGENTS_MD_SIZE_POLICY_KEY, (value) => {
    const policy = parseAgentsMdSizePolicy(value);
    for (const listener of listeners) listener(policy);
  });
}
