// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasWorkspaceExpansionPreference,
  readWorkspaceExpanded,
  writeWorkspaceExpanded,
} from './workspaceExpansion';

describe('workspace expansion persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to expanded and restores the user choice', () => {
    expect(readWorkspaceExpanded('workspace')).toBe(true);
    expect(hasWorkspaceExpansionPreference('workspace')).toBe(false);

    writeWorkspaceExpanded('workspace', false);

    expect(readWorkspaceExpanded('workspace')).toBe(false);
    expect(hasWorkspaceExpansionPreference('workspace')).toBe(true);
  });
});
