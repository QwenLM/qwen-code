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
import {
  GIT_METADATA_RESTORE_KEYS,
  REMOTE_GIT_TRANSPORT_KEYS,
} from './git-branches.js';

export type SimpleGitModule = {
  CheckRepoActions: typeof CheckRepoActions;
  simpleGit: SimpleGitFactory;
};

// gitEnv() (utils/git-branches.ts) scrubs ambient git variables and then
// deliberately restores exactly these operator-set ones. simple-git v4's
// environment guard throws when a task env names a guarded key the client
// did not opt into, so every client from this loader names them — the
// worktree service alone applies `.env(gitEnv())` at ~25 call sites.
// Derived from gitEnv()'s own restore set (plus GIT_ALLOW_PROTOCOL, which
// gitEnv() restores on a separate filtered path) so the two cannot drift.
export const GIT_ENV_RESTORED_KEYS = [
  ...GIT_METADATA_RESTORE_KEYS,
  'GIT_ALLOW_PROTOCOL',
] as const;

/**
 * Every guarded name this loader opts its clients into: the set `gitEnv()`
 * restores for `.env()` clients, plus the ambient operator configuration a
 * client that inherits `process.env` would otherwise lose to the v4 guard —
 * transport credentials, TLS client certificates, the SSH variant, the
 * no-prompt switch and the operator's config-tier pins (global, system and
 * the no-system switch). Naming a key only lets a
 * value already in the child environment survive; it never injects one, so
 * the `.env(gitEnv())` clients keep their scrub. Exec-capable keys
 * (GIT_EXEC_PATH, GIT_PROXY_COMMAND, editors, …) stay unnamed on purpose:
 * the guard deleting them is the hardening this loader exists for.
 */
export const LOADER_ALLOWED_ENVIRONMENT_KEYS = [
  ...GIT_ENV_RESTORED_KEYS,
  ...REMOTE_GIT_TRANSPORT_KEYS,
  'GIT_SSL_CERT',
  'GIT_SSL_KEY',
  'GIT_SSH_VARIANT',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
] as const;

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
 * global flag (e.g. `--no-optional-locks` on a `status` probe) is safe for
 * the same reason: it is a fixed token, not a
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
      // v4 deletes every guarded key the client did not name, so a client
      // that never applies `.env()` loses the operator's SSH/askpass
      // identity. Naming a key only lets one already in the child env
      // survive, so the `.env(gitEnv())` clients keep their scrub.
      allowEnvironment: [
        ...LOADER_ALLOWED_ENVIRONMENT_KEYS,
        ...(options?.allowEnvironment ?? []),
      ],
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
