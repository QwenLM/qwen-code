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
  isHostedWorkspaceSearchV3Profile,
  isHostedWorkspaceFileLifecycleProfile,
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

it('recognizes /3 search profiles without admitting unknown versions', () => {
  for (const profile of [
    'hosted-workspace-files/3',
    'hosted-workspace-shell/3',
  ]) {
    expect(isHostedWorkspaceProfile(profile)).toBe(true);
    expect(isHostedWorkspaceSearchProfile(profile)).toBe(true);
    expect(isHostedWorkspaceSearchV3Profile(profile)).toBe(true);
    expect(isHostedWorkspaceShellProfile(profile)).toBe(
      profile.includes('shell'),
    );
    expect(isHostedWorkspaceFileLifecycleProfile(profile)).toBe(
      profile.includes('files'),
    );
  }
  expect(isHostedWorkspaceProfile('hosted-workspace-files/4')).toBe(false);
  expect(isHostedWorkspaceSearchV3Profile('hosted-workspace-files/2')).toBe(
    false,
  );
  expect(
    isHostedWorkspaceFileLifecycleProfile('hosted-workspace-files/1'),
  ).toBe(true);
  expect(
    isHostedWorkspaceFileLifecycleProfile('hosted-workspace-files/2'),
  ).toBe(false);
});
