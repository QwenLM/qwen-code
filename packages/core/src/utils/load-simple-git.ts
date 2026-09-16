/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CheckRepoActions,
  SimpleGitFactory,
  SimpleGitOptions,
} from 'simple-git';
import { NO_EXEC_CONFIG_SETTINGS } from './gitUtils.js';

export type SimpleGitModule = {
  CheckRepoActions: typeof CheckRepoActions;
  simpleGit: SimpleGitFactory;
};

let simpleGitModulePromise: Promise<SimpleGitModule> | undefined;

/**
 * Wraps the simple-git factory so no client it produces can be turned into a
 * program launch by the repository it is pointed at.
 *
 * Every git call in this repository that goes through simple-git goes through
 * this loader, which makes it the one place the guard has to exist — a call
 * site added later inherits it. Guarding only the read-only commands would be
 * theatre here: `add --all`, `reset` and `stash create` were all measured to
 * run the helper too, and the worktree flows reach a `diff` through exactly
 * those.
 *
 * `allowUnsafeFsMonitor` is unavoidable: simple-git's argv parser refuses the
 * key by name whatever value it carries, so its blocklist would reject our own
 * guard. What that blocklist buys is narrower than it looks — it screens a
 * *caller-supplied* value and does nothing about the repository's own config,
 * and a planted `.git/config` was measured running its helper through an
 * unmodified simple-git client. What turning it off costs is real, though:
 * config from this option is emitted before the subcommand, so a `-c
 * core.fsmonitor=` that a caller put in *command* argv lands after ours and
 * wins (measured). The position that decides it is the subcommand — git only
 * reads `-c` before the subcommand, so no caller value can reach the guard as
 * long as nothing caller-derived precedes the subcommand. A leading *literal*
 * global flag (e.g. `--no-optional-locks` on the `worktreeCleanup` status
 * probe) is safe for the same reason: it is a fixed token, not a
 * caller-supplied entry, so it can neither carry a `-c` nor push one ahead of
 * the subcommand. A call site must keep it that way: no caller-derived entry
 * before the subcommand, and, as on the extension git client, no user- or
 * extension-derived config.
 */
function guardFsmonitor(factory: SimpleGitFactory): SimpleGitFactory {
  const guarded = (
    first?: string | Partial<SimpleGitOptions>,
    second?: Partial<SimpleGitOptions>,
  ) => {
    const baseDir = typeof first === 'string' ? first : undefined;
    const options = typeof first === 'string' ? second : first;
    const merged: Partial<SimpleGitOptions> = {
      ...options,
      config: [...(options?.config ?? []), ...NO_EXEC_CONFIG_SETTINGS],
      unsafe: { ...options?.unsafe, allowUnsafeFsMonitor: true },
    };
    return baseDir === undefined ? factory(merged) : factory(baseDir, merged);
  };
  return guarded as SimpleGitFactory;
}

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
      simpleGit: guardFsmonitor(candidate.simpleGit),
    };
  });
  return simpleGitModulePromise;
}
