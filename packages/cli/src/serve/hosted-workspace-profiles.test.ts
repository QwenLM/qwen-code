/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE_V2,
  HOSTED_WORKSPACE_READ_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE_V2,
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

// Approval pre-approves a call named glob only where the profile declares
// glob; elsewhere an MCP tool may carry that name (#13753 I3).
it('pre-approves glob only on the /2 search profiles and the read profile', () => {
  for (const profile of [
    HOSTED_WORKSPACE_FILE_PROFILE_V2,
    HOSTED_WORKSPACE_SHELL_PROFILE_V2,
    HOSTED_WORKSPACE_READ_PROFILE,
  ])
    expect(isHostedWorkspaceGlobProfile(profile)).toBe(true);
  for (const profile of [
    HOSTED_WORKSPACE_FILE_PROFILE,
    HOSTED_WORKSPACE_SHELL_PROFILE,
    HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
    undefined,
  ])
    expect(isHostedWorkspaceGlobProfile(profile)).toBe(false);
  expect(isHostedWorkspaceSearchProfile(HOSTED_WORKSPACE_READ_PROFILE)).toBe(
    false,
  );
});
