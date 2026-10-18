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
// #13753 I3: a snapshot child's profile, `read_file` and `glob` only. The
// control plane gives it to a child bound to a read-only snapshot copy, so
// nothing the child declares writes.
export const HOSTED_WORKSPACE_READ_PROFILE = 'hosted-workspace-read/1';

export type HostedWorkspaceToolProfile =
  | typeof HOSTED_WORKSPACE_FILE_PROFILE
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE
  | typeof HOSTED_WORKSPACE_FILE_PROFILE_V2
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE_V2
  | typeof HOSTED_WORKSPACE_TEAM_LEAD_PROFILE
  | typeof HOSTED_WORKSPACE_READ_PROFILE;

export function isHostedWorkspaceProfile(
  profile: unknown,
): profile is HostedWorkspaceToolProfile {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE ||
    profile === HOSTED_WORKSPACE_READ_PROFILE
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

/** The `/2` profiles; the read profile is not one (see the glob predicate). */
export function isHostedWorkspaceSearchProfile(profile: unknown): boolean {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V2
  );
}

/**
 * The profiles that declare `glob`, so approval pre-approves it: the `/2`
 * search profiles and the read profile (#13753 I3).
 */
export function isHostedWorkspaceGlobProfile(profile: unknown): boolean {
  return (
    isHostedWorkspaceSearchProfile(profile) ||
    profile === HOSTED_WORKSPACE_READ_PROFILE
  );
}

export function isHostedWorkspaceReadProfile(profile: unknown): boolean {
  return profile === HOSTED_WORKSPACE_READ_PROFILE;
}
