/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  resolveArtifactWorkspaceOwner,
  useArtifactWorkspaceTargetFromRuntime,
  type ArtifactWorkspaceActions,
  type ArtifactWorkspaceOwner,
  type ArtifactWorkspaceTarget,
} from './artifact-workspace-target.js';

export {
  resolveArtifactWorkspaceOwner,
  type ArtifactWorkspaceActions,
  type ArtifactWorkspaceOwner,
  type ArtifactWorkspaceTarget,
};

export function useArtifactWorkspaceTarget(
  workspaceCwd: string | undefined,
): ArtifactWorkspaceTarget | undefined {
  const workspace = useWorkspace();
  const primaryActions = useWorkspaceActions();
  return useArtifactWorkspaceTargetFromRuntime(
    workspace,
    primaryActions,
    workspaceCwd,
  );
}
