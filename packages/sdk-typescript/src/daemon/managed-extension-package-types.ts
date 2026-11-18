/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ManagedPackageManifest {
  schemaVersion: 1;
  compilerVersion: 1;
  name: string;
  version: string;
  target: { platform: 'linux' | 'darwin'; arch: 'arm64' | 'x64' | 'any' };
  components: Array<
    'skills' | 'commands' | 'agents' | 'context' | 'mcp' | 'hooks' | 'settings'
  >;
  sourceType?: string;
  sourceRevision?: string;
}
export interface ManagedPackagePreparationRequest {
  source: string;
  ref?: string;
  target: ManagedPackageManifest['target'];
  consent: true;
}
export interface ManagedPackagePreparation {
  packageDigest: string;
  manifest: ManagedPackageManifest;
  sourceRevision: string;
  archiveUrl: string;
}
