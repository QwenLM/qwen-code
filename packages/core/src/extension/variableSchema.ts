/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface VariableDefinition {
  type: 'string';
  description: string;
  default?: string;
  required?: boolean;
}

export interface VariableSchema {
  [key: string]: VariableDefinition;
}

export interface LoadExtensionContext {
  extensionDir: string;
  workspaceDir?: string;
  /** Trust symlinked manifest/hooks files (link-mode installs read the user's
   *  own dev tree). Defaults to strict confinement. */
  trustSymlinks?: boolean;
  /** Out-of-band link grant: set by the store snapshot (CLI link installs)
   *  or by the installing flow itself. Never derived from the extension's
   *  own payload — a hand-placed manifest cannot self-grant. */
  trustedLinkSource?: string;
}

const PATH_SEPARATOR_DEFINITION = {
  type: 'string',
  description: 'The path separator.',
} as const;

export const VARIABLE_SCHEMA = {
  extensionPath: {
    type: 'string',
    description: 'The path of the extension in the filesystem.',
  },
  CLAUDE_PLUGIN_ROOT: {
    type: 'string',
    description: 'The path of the extension in the filesystem.',
  },
  workspacePath: {
    type: 'string',
    description: 'The absolute path of the current workspace.',
  },
  '/': PATH_SEPARATOR_DEFINITION,
  pathSeparator: PATH_SEPARATOR_DEFINITION,
} as const;
