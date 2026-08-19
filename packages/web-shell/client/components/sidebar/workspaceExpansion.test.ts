// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasWorkspaceExpansionPreference,
  migrateWorkspaceExpansionPreference,
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

  it('migrates a preference written under a provisional id', () => {
    writeWorkspaceExpanded('primary:/tmp/connection', false);

    migrateWorkspaceExpansionPreference(
      'primary:/tmp/connection',
      'primary:/tmp/primary',
    );

    expect(readWorkspaceExpanded('primary:/tmp/primary')).toBe(false);
    expect(hasWorkspaceExpansionPreference('primary:/tmp/connection')).toBe(
      false,
    );
  });

  it('keeps an existing preference when ids converge', () => {
    writeWorkspaceExpanded('primary:/tmp/connection', false);
    writeWorkspaceExpanded('primary:/tmp/primary', true);

    migrateWorkspaceExpansionPreference(
      'primary:/tmp/connection',
      'primary:/tmp/primary',
    );

    expect(readWorkspaceExpanded('primary:/tmp/primary')).toBe(true);
    expect(hasWorkspaceExpansionPreference('primary:/tmp/connection')).toBe(
      false,
    );
  });
});
