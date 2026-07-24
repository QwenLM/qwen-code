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

export function loadSimpleGit(): Promise<SimpleGitModule> {
  simpleGitModulePromise ??= import('simple-git').then((module) => {
    const imported = module as unknown as Partial<SimpleGitModule> & {
      default?: SimpleGitModule;
    };
    const candidate =
      imported.simpleGit && imported.CheckRepoActions
        ? (imported as SimpleGitModule)
        : imported.default;
    if (!candidate) {
      throw new Error('simple-git module does not match the expected API');
    }
    return {
      CheckRepoActions: candidate.CheckRepoActions,
      simpleGit: candidate.simpleGit,
    };
  });
  return simpleGitModulePromise;
}
