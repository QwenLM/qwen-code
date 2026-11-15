/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { gitModeIntentMustReset } from './gitModeIntent';

describe('gitModeIntentMustReset', () => {
  const trustedGit = {
    sessionId: null,
    workspaceTrusted: true,
    gitStatus: { branch: 'main' },
  };

  it('keeps the intent while the workspace is a trusted git repo', () => {
    expect(gitModeIntentMustReset(trustedGit)).toBe(false);
  });

  it('keeps the intent across a transient status gap', () => {
    // Not fetched yet, or one failed poll round: nothing definitive.
    expect(
      gitModeIntentMustReset({ ...trustedGit, gitStatus: undefined }),
    ).toBe(false);
  });

  it('resets once git status answers with no branch', () => {
    expect(
      gitModeIntentMustReset({ ...trustedGit, gitStatus: { branch: null } }),
    ).toBe(true);
  });

  it('keeps the intent for a detached HEAD (tag/SHA checkout) (R7)', () => {
    // Mirrors App.gitModeEligible: branch:null with detached:true is the
    // shared-checkout shape the worktree default isolates, not a non-Git
    // workspace, so the armed worktree intent must survive the reset effect.
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: null, detached: true, hasHead: true },
      }),
    ).toBe(false);
  });

  it('still resets a detached HEAD with an unborn HEAD (R7)', () => {
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: null, detached: true, hasHead: false },
      }),
    ).toBe(true);
  });

  it('resets a non-Git workspace (no branch and not detached) (R7)', () => {
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: null, detached: false },
      }),
    ).toBe(true);
  });

  it('resets on a definitive unborn HEAD even with a branch present', () => {
    // The fast status that armed the intent may omit hasHead; the fresh
    // status reporting hasHead:false must drop the worktree intent in the
    // same render the chip hides, or the first prompt 409s with no control
    // left to undo it.
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: 'main', hasHead: false },
      }),
    ).toBe(true);
  });

  it('keeps the intent while hasHead is absent or true', () => {
    // undefined is transient (one-sided absence on the wire), not a reset.
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: 'main', hasHead: undefined },
      }),
    ).toBe(false);
    expect(
      gitModeIntentMustReset({
        ...trustedGit,
        gitStatus: { branch: 'main', hasHead: true },
      }),
    ).toBe(false);
  });

  it('resets when a session exists or the workspace is not trusted', () => {
    expect(gitModeIntentMustReset({ ...trustedGit, sessionId: 's1' })).toBe(
      true,
    );
    expect(
      gitModeIntentMustReset({ ...trustedGit, workspaceTrusted: false }),
    ).toBe(true);
    expect(
      gitModeIntentMustReset({ ...trustedGit, workspaceTrusted: undefined }),
    ).toBe(true);
  });
});
