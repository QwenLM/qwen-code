/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Extension } from '@qwen-code/qwen-code-core';
import { redactUrlCredentials } from '@qwen-code/qwen-code-core/extension/redaction.js';
import type {
  ServeExtensionCapabilities,
  ServeExtensionEntry,
  ServeExtensionSummary,
} from '@qwen-code/acp-bridge/status';

export const redactExtensionDisplaySource = (source: string): string => {
  const redacted = redactUrlCredentials(source);
  if (redacted.startsWith('upload:')) return redacted;
  if (/^[A-Za-z]:[\\/]/.test(redacted)) return redacted;
  try {
    const url = new URL(redacted);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return redacted;
  }
};

export function toExtensionSummary(ext: Extension): ServeExtensionSummary {
  return {
    kind: 'extension',
    id: ext.id,
    name: ext.name,
    ...(ext.displayName ? { displayName: ext.displayName } : {}),
    ...(ext.config.description ? { description: ext.config.description } : {}),
    version: ext.version,
    isActive: ext.isActive,
    path: ext.path,
    ...(ext.installMetadata?.source && ext.installMetadata.type !== 'snapshot'
      ? {
          source: redactExtensionDisplaySource(ext.installMetadata.source),
        }
      : {}),
    ...(ext.installMetadata?.type
      ? { installType: ext.installMetadata.type }
      : {}),
    ...(ext.installMetadata?.originSource
      ? { originSource: ext.installMetadata.originSource }
      : {}),
    ...(ext.installMetadata?.ref ? { ref: ext.installMetadata.ref } : {}),
    ...(ext.installMetadata?.autoUpdate !== undefined
      ? { autoUpdate: ext.installMetadata.autoUpdate }
      : {}),
    ...(ext.installMetadata?.type === 'snapshot'
      ? { credentialPersistence: 'one_time' as const }
      : ext.installMetadata?.credentialPersistence === 'stored'
        ? { credentialPersistence: 'stored' as const }
        : {}),
    updateState:
      ext.installMetadata?.type === 'snapshot'
        ? 'not updatable'
        : ext.installMetadata
          ? 'unknown'
          : 'not updatable',
  };
}

export function toExtensionEntry(ext: Extension): ServeExtensionEntry {
  const capabilities: ServeExtensionCapabilities = {
    mcpServerCount: ext.mcpServers ? Object.keys(ext.mcpServers).length : 0,
    skillCount: ext.skills?.length ?? 0,
    agentCount: ext.agents?.length ?? 0,
    hookCount: ext.hooks
      ? Object.values(ext.hooks).reduce(
          (sum, defs) => sum + (defs?.length ?? 0),
          0,
        )
      : 0,
    commandCount: ext.commands?.length ?? 0,
    contextFileCount: ext.contextFiles.length,
    channelCount: ext.channels ? Object.keys(ext.channels).length : 0,
    hasSettings: (ext.settings?.length ?? 0) > 0,
  };
  return {
    ...toExtensionSummary(ext),
    capabilities,
    details: {
      mcpServers: ext.mcpServers ? Object.keys(ext.mcpServers) : [],
      commands: ext.commands ?? [],
      skills: ext.skills?.map((skill) => skill.name) ?? [],
      agents: ext.agents?.map((agent) => agent.name) ?? [],
      contextFiles: ext.contextFiles,
      settings: ext.resolvedSettings?.map((setting) => setting.name) ?? [],
    },
  };
}
