/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../mcp/mcpServerConfig.js';

export interface ManagedResourcePolicy {
  readonly userVisible: boolean;
  readonly userCanDisable: boolean;
  readonly disabled: boolean;
}

export interface ManagedSkillResource extends ManagedResourcePolicy {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly filePath: string;
  readonly sourceId: string;
}

export interface ManagedMcpResource extends ManagedResourcePolicy {
  readonly id: string;
  readonly name: string;
  readonly originalName: string;
  readonly displayName: string;
  readonly sourceId: string;
  readonly config: MCPServerConfig;
  readonly rootsDir?: string;
}

export interface ManagedResourcesProvider {
  getIdentityGeneration?(): string | undefined;
  subscribeMcpChanges?(listener: () => void): () => void;
  readSkills(): Promise<readonly ManagedSkillResource[]>;
  readMcpServers(): Promise<readonly ManagedMcpResource[]>;
  setSkillEnabled(
    resource: ManagedSkillResource,
    enabled: boolean,
  ): Promise<void>;
  setMcpServerEnabled(
    resource: ManagedMcpResource,
    enabled: boolean,
  ): Promise<void>;
}

export function isManagedResourceLocked(
  resource: Pick<ManagedResourcePolicy, 'userVisible' | 'userCanDisable'>,
): boolean {
  return !resource.userVisible || !resource.userCanDisable;
}

export function isManagedMcpEnabled(resource: ManagedMcpResource): boolean {
  return (
    !resource.config.disabled &&
    (isManagedResourceLocked(resource) || !resource.disabled)
  );
}

export type ManagedMcpRefreshTarget = Pick<
  ManagedMcpResource,
  'sourceId' | 'name' | 'originalName'
>;

/** Include both sides of a shadow relation, including withdrawn resources. */
export function managedMcpRefreshNames(
  before: readonly ManagedMcpResource[],
  after: readonly ManagedMcpResource[],
  names: readonly string[],
): Set<string> {
  const affected = new Set(names);
  const resources = [...before, ...after];
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of resources) {
      if (!affected.has(resource.name) && !affected.has(resource.originalName))
        continue;
      for (const name of [resource.name, resource.originalName]) {
        if (!affected.has(name)) {
          affected.add(name);
          changed = true;
        }
      }
    }
  }
  return affected;
}
