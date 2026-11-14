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
// #15076: `files/3` adds `todo_write` to its `/2` counterpart.
export const HOSTED_WORKSPACE_FILE_PROFILE_V3 = 'hosted-workspace-files/3';
// Self-paced /loop: `shell/3` adds `loop_wakeup` and the cron union to its
// `/1` counterpart. `shell/2` was retired by the unified Shell lifecycle
// (#15330) and is deliberately not reused, so the persisted vocabulary stays
// unambiguous.
export const HOSTED_WORKSPACE_SHELL_PROFILE_V3 = 'hosted-workspace-shell/3';
// Fixed-interval /loop: the cron trio (cron_create plus the union
// cron_list/cron_delete) ships on the next revisions. shell/4 inherits
// loop_wakeup from shell/3; files/4 and team-lead/2 declare the cron trio
// without loop_wakeup. shell/2 stays retired (#15330).
export const HOSTED_WORKSPACE_FILE_PROFILE_V4 = 'hosted-workspace-files/4';
export const HOSTED_WORKSPACE_SHELL_PROFILE_V4 = 'hosted-workspace-shell/4';
export const HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2 =
  'hosted-workspace-team-lead/2';
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
  | typeof HOSTED_WORKSPACE_FILE_PROFILE_V3
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE_V3
  | typeof HOSTED_WORKSPACE_FILE_PROFILE_V4
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE_V4
  | typeof HOSTED_WORKSPACE_TEAM_LEAD_PROFILE
  | typeof HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2
  | typeof HOSTED_WORKSPACE_READ_PROFILE;

export function isHostedWorkspaceProfile(
  profile: unknown,
): profile is HostedWorkspaceToolProfile {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V4 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V4 ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_READ_PROFILE
  );
}

export function isHostedWorkspaceShellProfile(profile: unknown): boolean {
  return (
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V4 ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE ||
    profile === HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2
  );
}

/**
 * The public Shell revisions, mirroring the control plane's
 * WorkspaceToolProfiles.isPublicShell: shell/1 and shell/3, but not the
 * internal team-lead profile. Routes that admit a public Shell use this so a
 * new revision is admitted in one place; the retired shell/2 stays refused.
 */
export function isHostedWorkspacePublicShellProfile(
  profile: unknown,
): profile is string {
  return (
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V4
  );
}

/** Public Shell admission sets suppressChildAgents. Private Shell lanes omit it. */
export function hostedShellLaneAttachesChildAgents(
  shellLane: boolean,
  suppressChildAgents: boolean,
): boolean {
  return shellLane && !suppressChildAgents;
}

/** Ordinary file and Shell profiles; read-only children use their own list. */
export function isHostedWorkspaceSearchProfile(profile: unknown): boolean {
  return (
    profile === HOSTED_WORKSPACE_FILE_PROFILE ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V2 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_SHELL_PROFILE_V4 ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V3 ||
    profile === HOSTED_WORKSPACE_FILE_PROFILE_V4
  );
}

/**
 * The profiles that declare `glob`, so approval pre-approves it: the
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
