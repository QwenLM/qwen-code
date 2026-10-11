/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The saved Hosted Workspace tool profiles. Creation, load and Workspace
// recovery all read this one vocabulary, so a new profile cannot be
// persisted by one and refused by another.

export const HOSTED_WORKSPACE_FILE_PROFILE = 'hosted-workspace-files/1';
export const HOSTED_WORKSPACE_SHELL_PROFILE = 'hosted-workspace-shell/1';
export const HOSTED_WORKSPACE_FILE_PROFILE_V2 = 'hosted-workspace-files/2';
export const HOSTED_WORKSPACE_SHELL_PROFILE_V2 = 'hosted-workspace-shell/2';
export const HOSTED_WORKSPACE_TEAM_LEAD_PROFILE =
  'hosted-workspace-team-lead/1';

export type HostedWorkspaceToolProfile =
  | typeof HOSTED_WORKSPACE_FILE_PROFILE
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE
  | typeof HOSTED_WORKSPACE_FILE_PROFILE_V2
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE_V2
  | typeof HOSTED_WORKSPACE_TEAM_LEAD_PROFILE;

export function isHostedWorkspaceProfile(
  profile: unknown,
): profile is HostedWorkspaceToolProfile {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE
  );
}

export function isHostedWorkspaceShellProfile(profile: unknown): boolean {
  return (
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE
  );
}

/** Public Shell admission sets suppressChildAgents. Private Shell lanes omit it. */
export function hostedShellLaneAttachesChildAgents(
  shellLane: boolean,
  suppressChildAgents: boolean,
): boolean {
  return shellLane && !suppressChildAgents;
}

export function isHostedWorkspaceSearchProfile(profile: unknown): boolean {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V2
  );
}
