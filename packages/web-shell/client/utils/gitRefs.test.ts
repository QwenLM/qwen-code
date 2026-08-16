/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  displayBranchName,
  qualifyLocalBranchRef,
  qualifyRemoteBranchRef,
} from './gitRefs';

describe('qualifyLocalBranchRef', () => {
  it('prefixes a plain short name', () => {
    expect(qualifyLocalBranchRef('release')).toBe('refs/heads/release');
    expect(qualifyLocalBranchRef('feature/topic')).toBe(
      'refs/heads/feature/topic',
    );
  });

  it('absorbs the heads/ disambiguation prefix git adds for ambiguous names', () => {
    // Branch `release` + tag `release`: refname:short reports `heads/release`.
    expect(qualifyLocalBranchRef('heads/release')).toBe('refs/heads/release');
  });

  it('keeps an already fully qualified name unchanged', () => {
    expect(qualifyLocalBranchRef('refs/heads/release')).toBe(
      'refs/heads/release',
    );
  });
});

describe('qualifyRemoteBranchRef', () => {
  it('prefixes a plain remote-tracking name', () => {
    expect(qualifyRemoteBranchRef('origin/main')).toBe(
      'refs/remotes/origin/main',
    );
  });

  it('absorbs the remotes/ disambiguation prefix', () => {
    expect(qualifyRemoteBranchRef('remotes/origin/main')).toBe(
      'refs/remotes/origin/main',
    );
  });

  it('keeps an already fully qualified name unchanged', () => {
    expect(qualifyRemoteBranchRef('refs/remotes/origin/main')).toBe(
      'refs/remotes/origin/main',
    );
  });
});

describe('displayBranchName', () => {
  it('returns plain names unchanged', () => {
    expect(displayBranchName('release')).toBe('release');
    expect(displayBranchName('origin/main')).toBe('origin/main');
  });

  it('strips namespace and disambiguation prefixes', () => {
    expect(displayBranchName('refs/heads/release')).toBe('release');
    expect(displayBranchName('heads/release')).toBe('release');
    expect(displayBranchName('refs/remotes/origin/main')).toBe('origin/main');
    expect(displayBranchName('remotes/origin/main')).toBe('origin/main');
  });
});
