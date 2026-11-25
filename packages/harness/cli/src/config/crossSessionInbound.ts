/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layered resolution of `security.crossSessionInbound`.
 *
 * Trusted scopes win first-hit; the repository's own file may only tighten.
 * Without the tighten-only rule a checked-in `.qwen/settings.json` could
 * downgrade a user's `hold` to `accept` for anyone who clones the repo, which is
 * exactly the escalation this setting exists to prevent.
 *
 * The local project file is trusted rather than treated as repo-shared,
 * because `settings.local.json` is the reader's own per-project override and is
 * not what a repository ships to whoever clones it. This is the same trust line
 * `permissions/autoModeClassifierInit.ts` draws when it reads the user and local
 * files but pointedly not the project one. Grouping it with the project file
 * had two costs: a user who set `hold` globally could not relax it for a single
 * project, and their own `hold` was attributed to the repository, which made
 * `inbound-policy.ts` ask per message instead of honouring it as the standing
 * instruction it was.
 *
 * The trust gate on that scope is not optional. `LoadedSettings` projects an
 * untrusted `project` to empty but leaves `local` as read from disk
 * (`settings.ts:355-361`), so every direct reader applies the gate itself —
 * `mergeSettings` and `getExplicitLoadingPhrasesMode` both do. Reading `local`
 * without it would let an untrusted project loosen the policy, which is the
 * regression this whole rule exists to prevent.
 *
 * The `accept` baseline the comparison falls back to when no trusted scope spoke
 * is a stand-in, not the real default: with nothing configured the gate uses
 * permission-mode parity, which can itself decide `hold` or `refuse`. So a repo
 * value that compares as "tightening" here is not always tightening in fact —
 * `core/messaging/inbound-policy.ts` is what makes a repo-sourced hold ask
 * rather than park, precisely because this comparison cannot tell.
 */

import {
  INBOUND_SEVERITY,
  type CrossSessionInbound,
  type CrossSessionInboundSource,
} from '@qwen-code/core';
import type { LoadedSettings, SettingsFile } from './settings.js';
import type { Settings } from './settingsSchema.js';

const VALID_VALUES: readonly string[] = ['accept', 'hold', 'refuse'];

/** Human-facing scope label, used by `/peers` to name the file to edit. */
export type CrossSessionInboundScope =
  | 'flag'
  | 'user'
  | 'project'
  | 'local';

export interface ResolvedCrossSessionInboundSetting {
  policy: CrossSessionInbound;
  /** Coarse trust class consumed by core for hold attribution. */
  source: CrossSessionInboundSource;
  /** Precise scope, for telling the user which file to change. */
  scope: CrossSessionInboundScope;
  /** Path of the file that set it, when the scope has one. */
  path?: string;
}

function readScope(settings: Settings | undefined): CrossSessionInbound | undefined {
  const value = settings?.security?.crossSessionInbound;
  return typeof value === 'string' && VALID_VALUES.includes(value)
    ? (value as CrossSessionInbound)
    : undefined;
}

function describe(
  file: SettingsFile | undefined,
  scope: CrossSessionInboundScope,
  source: CrossSessionInboundSource,
): ResolvedCrossSessionInboundSetting | undefined {
  const policy = readScope(file?.settings);
  if (policy === undefined) return undefined;
  return {
    policy,
    source,
    scope,
    ...(file?.path ? { path: file.path } : {}),
  };
}

/**
 * Resolves the effective inbound policy along with where it came from, or
 * undefined when no scope sets one (in which case the caller falls back to
 * permission-mode parity).
 *
 * The scope travels with the value because a repository setting can override a
 * user's own choice by design, and without attribution that user has no way to
 * discover why their setting is being ignored.
 */
export function resolveCrossSessionInbound(
  loadedSettings: LoadedSettings,
): ResolvedCrossSessionInboundSetting | undefined {
  let resolved: ResolvedCrossSessionInboundSetting | undefined;

  // Trusted scopes: the first one that expresses an opinion wins outright.
  // Ordered as the rest of the codebase orders them — flag, then this project's
  // personal override, then the user-wide default.
  for (const candidate of [
    describe(loadedSettings.flag, 'flag', 'user'),
    loadedSettings.isTrusted
      ? describe(loadedSettings.local, 'local', 'user')
      : undefined,
    describe(loadedSettings.user, 'user', 'user'),
  ]) {
    if (candidate) {
      resolved = candidate;
      break;
    }
  }

  // The repository's shared file: honoured only when strictly more restrictive.
  const project = describe(loadedSettings.project, 'project', 'repo');
  if (
    project &&
    INBOUND_SEVERITY[project.policy] >
      INBOUND_SEVERITY[resolved?.policy ?? 'accept']
  ) {
    resolved = project;
  }

  return resolved;
}
