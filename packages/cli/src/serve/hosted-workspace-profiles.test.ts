/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import {
  HOSTED_WORKSPACE_TEAM_LEAD_PROFILE,
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
