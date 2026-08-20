/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CheckRepoActions, SimpleGitFactory } from 'simple-git';

export type SimpleGitModule = {
  CheckRepoActions: typeof CheckRepoActions;
  simpleGit: SimpleGitFactory;
};

let simpleGitModulePromise: Promise<SimpleGitModule> | undefined;

function isSimpleGitModule(
  candidate: Partial<SimpleGitModule> | undefined,
): candidate is SimpleGitModule {
  return (
    candidate !== undefined &&
    'simpleGit' in candidate &&
    typeof candidate.simpleGit === 'function' &&
    'CheckRepoActions' in candidate &&
    typeof candidate.CheckRepoActions === 'object' &&
    candidate.CheckRepoActions !== null
  );
}

export function loadSimpleGit(): Promise<SimpleGitModule> {
  simpleGitModulePromise ??= import('simple-git').then((module) => {
    const imported = module as unknown as Partial<SimpleGitModule> & {
      default?: SimpleGitModule;
    };
    const candidate = isSimpleGitModule(imported)
      ? imported
      : 'default' in imported
        ? imported.default
        : undefined;
    if (!isSimpleGitModule(candidate)) {
      throw new Error('simple-git module does not match the expected API');
    }
    return {
      CheckRepoActions: candidate.CheckRepoActions,
      simpleGit: candidate.simpleGit,
    };
  });
  return simpleGitModulePromise;
}
