/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';
import type { DaemonGlobOptions, DaemonWorkspaceActions } from '../types.js';

export function useDaemonFiles(): Pick<
  DaemonWorkspaceActions,
  | 'globWorkspace'
  | 'readFileBytes'
  | 'writeFile'
  | 'editFile'
  | 'stat'
  | 'listDirectory'
> & { glob: DaemonWorkspaceActions['globWorkspace'] } {
  const actions = useDaemonWorkspaceActions();
  return {
    glob: actions.globWorkspace,
    globWorkspace: actions.globWorkspace,
    readFileBytes: actions.readFileBytes,
    writeFile: actions.writeFile,
    editFile: actions.editFile,
    stat: actions.stat,
    listDirectory: actions.listDirectory,
  };
}

export type { DaemonGlobOptions };
