/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE_V2,
  HOSTED_WORKSPACE_FILE_PROFILE_V3,
  HOSTED_WORKSPACE_FILE_PROFILE_V4,
  HOSTED_WORKSPACE_READ_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE_V3,
  HOSTED_WORKSPACE_SHELL_PROFILE_V4,
  HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
  HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2,
  isHostedWorkspaceGlobProfile,
  isHostedWorkspaceProfile,
  isHostedWorkspacePublicShellProfile,
  isHostedWorkspaceShellProfile,
  isHostedWorkspaceSearchProfile,
} from './hosted-workspace-profiles.js';

it('admits the saved internal TeamLead as Shell execution without search', () => {
  for (const profile of [
    HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
    HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2,
  ]) {
    expect(isHostedWorkspaceProfile(profile)).toBe(true);
    expect(isHostedWorkspaceShellProfile(profile)).toBe(true);
    expect(isHostedWorkspaceSearchProfile(profile)).toBe(false);
  }
});

// Native glob is pre-approved on profiles that declare it; undeclared calls
// are refused before approval and MCP tools use separate names.
it('pre-approves glob only on the search profiles and the read profile', () => {
  for (const profile of [
    HOSTED_WORKSPACE_FILE_PROFILE,
    HOSTED_WORKSPACE_FILE_PROFILE_V2,
    HOSTED_WORKSPACE_SHELL_PROFILE,
    HOSTED_WORKSPACE_FILE_PROFILE_V3,
    HOSTED_WORKSPACE_FILE_PROFILE_V4,
    HOSTED_WORKSPACE_SHELL_PROFILE_V3,
    HOSTED_WORKSPACE_SHELL_PROFILE_V4,
    HOSTED_WORKSPACE_READ_PROFILE,
  ])
    expect(isHostedWorkspaceGlobProfile(profile)).toBe(true);
  for (const profile of [
    HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
    HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2,
    undefined,
  ])
    expect(isHostedWorkspaceGlobProfile(profile)).toBe(false);
  expect(isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_FILE_PROFILE)).toBe(
    true,
  );
  expect(isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_READ_PROFILE)).toBe(
    false,
  );
});

it('rejects the removed Shell profile', () => {
  expect(isHostedWorkspaceProfile('hosted-workspace-shell/2')).toBe(false);
  expect(isHostedWorkspaceShellProfile('hosted-workspace-shell/2')).toBe(false);
  expect(isHostedWorkspaceGlobProfile('hosted-workspace-shell/2')).toBe(false);
});

// The self-paced /loop revision skips the retired `shell/2` and takes
// `shell/3`, a write-capable Shell profile that adds loop_wakeup and the cron
// union.
it('admits the loop wakeup Shell revision shell/3', () => {
  expect(isHostedWorkspaceProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V3)).toBe(
    true,
  );
  expect(isHostedWorkspaceShellProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V3)).toBe(
    true,
  );
  expect(isHostedWorkspaceGlobProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V3)).toBe(
    true,
  );
});

// The fixed-interval /loop revisions: shell/4 inherits shell/3's write-capable
// Shell lane; files/4 is a search profile like files/3; team-lead/2 stays an
// internal Shell lane without search. None reuses the retired shell/2.
it('admits the loop schedule revisions files/4, shell/4 and team-lead/2', () => {
  expect(isHostedWorkspaceProfile(HOSTED_WORKSPACE_FILE_PROFILE_V4)).toBe(true);
  expect(isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_FILE_PROFILE_V4)).toBe(
    true,
  );
  expect(isHostedWorkspaceShellProfile(HOSTED_WORKSPACE_FILE_PROFILE_V4)).toBe(
    false,
  );
  expect(isHostedWorkspaceProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V4)).toBe(
    true,
  );
  expect(isHostedWorkspaceShellProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V4)).toBe(
    true,
  );
  expect(
    isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V4),
  ).toBe(true);
  expect(isHostedWorkspaceProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2)).toBe(
    true,
  );
  expect(
    isHostedWorkspaceShellProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2),
  ).toBe(true);
  expect(
    isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2),
  ).toBe(false);
});

// The public-Shell predicate mirrors the control plane's isPublicShell: every
// public Shell revision, but not the internal team-lead profiles that
// isHostedWorkspaceShellProfile also admits.
it('isHostedWorkspacePublicShellProfile admits the public Shell revisions only', () => {
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_SHELL_PROFILE),
  ).toBe(true);
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V3),
  ).toBe(true);
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_SHELL_PROFILE_V4),
  ).toBe(true);
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE),
  ).toBe(false);
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE_V2),
  ).toBe(false);
  expect(isHostedWorkspacePublicShellProfile('hosted-workspace-shell/2')).toBe(
    false,
  );
  expect(
    isHostedWorkspacePublicShellProfile(HOSTED_WORKSPACE_FILE_PROFILE),
  ).toBe(false);
  expect(isHostedWorkspacePublicShellProfile(undefined)).toBe(false);
});
