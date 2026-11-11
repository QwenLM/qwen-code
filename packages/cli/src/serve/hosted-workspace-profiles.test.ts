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
  HOSTED_WORKSPACE_READ_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE_V3,
  HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
  isHostedWorkspaceGlobProfile,
  isHostedWorkspaceProfile,
  isHostedWorkspaceShellProfile,
  isHostedWorkspaceSearchProfile,
} from './hosted-workspace-profiles.js';

it('admits the saved internal TeamLead as Shell execution without search', () => {
  expect(isHostedWorkspaceProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE)).toBe(
    true,
  );
  expect(
    isHostedWorkspaceShellProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE),
  ).toBe(true);
  expect(
    isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_TEAM_LEAD_PROFILE),
  ).toBe(false);
  expect(isHostedWorkspaceProfile('hosted-workspace-team-lead/2')).toBe(false);
});

// Native glob is pre-approved on profiles that declare it; undeclared calls
// are refused before approval and MCP tools use separate names.
it('pre-approves glob only on the search profiles and the read profile', () => {
  for (const profile of [
    HOSTED_WORKSPACE_FILE_PROFILE,
    HOSTED_WORKSPACE_FILE_PROFILE_V2,
    HOSTED_WORKSPACE_SHELL_PROFILE,
    HOSTED_WORKSPACE_FILE_PROFILE_V3,
    HOSTED_WORKSPACE_READ_PROFILE,
  ])
    expect(isHostedWorkspaceGlobProfile(profile)).toBe(true);
  for (const profile of [HOSTED_WORKSPACE_TEAM_LEAD_PROFILE, undefined])
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
