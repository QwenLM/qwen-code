/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import {
  EnvironmentAttachment,
  environmentAttachmentSchema,
  isEnvironmentMessage,
  type EnvironmentSnapshot,
  type EnvironmentChange,
} from '../models/environment-attachment.js';
import type { AttachmentToolUseContext } from '../types.js';
import type { Config } from '../../config/config.js';
import type { Message } from '../../protocol/transcript/message.js';
import { getCwd, runWithShellSession } from '../../utils/Shell.js';
import {
  findGitRootAsync,
  resolveGitRepositoryLayout,
} from '../../utils/gitUtils.js';

import {
  ENV_WINDOWS_SHELL_KIND,
  WINDOWS_SHELL_KIND_GIT_BASH,
} from '../../utils/windowsPaths.js';

/** Fields whose change invalidates deltas and requires a fresh full block. */
const MACHINE_FIELDS = [
  'platform',
  'shell',
  'osVersion',
  'architecture',
  'nodeVersion',
] as const satisfies ReadonlyArray<keyof EnvironmentSnapshot>;

interface GitEnvironment {
  isGitRepo: boolean;
  isWorktree: boolean;
}

const gitEnvironmentCaches = new WeakMap<
  Config,
  {
    generation: string;
    roots: Map<string, Promise<string | null>>;
    worktrees: Map<string, Promise<boolean>>;
  }
>();

// Completed probes (including non-Git) are reused for the session; failures
// are evicted so a later call can still recover and report.
function memoizeProbe<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  probe: () => Promise<T>,
): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = probe().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

async function getGitEnvironment(
  config: Config,
  cwd: string,
): Promise<GitEnvironment> {
  const generation = `${config.getSessionId?.()}\0${config.getTargetDir()}`;
  let cache = gitEnvironmentCaches.get(config);
  if (cache?.generation !== generation) {
    cache = { generation, roots: new Map(), worktrees: new Map() };
    gitEnvironmentCaches.set(config, cache);
  }
  let root: string | null;
  try {
    root = await memoizeProbe(cache.roots, path.resolve(cwd), () =>
      findGitRootAsync(cwd, { throwOnError: true }),
    );
  } catch {
    return {
      isGitRepo: false,
      isWorktree: false,
    };
  }
  // Unreadable worktree metadata does not undo a detected .git marker.
  const isWorktree =
    root !== null &&
    (await memoizeProbe(cache.worktrees, root, async () => {
      const layout = await resolveGitRepositoryLayout(root, {
        throwOnError: true,
      });
      return layout?.isWorktree === true;
    }).catch(() => false));
  return {
    isGitRepo: root !== null,
    isWorktree,
  };
}

function changedFields(
  previous: EnvironmentSnapshot,
  current: EnvironmentSnapshot,
): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];
  if (previous.workingDirectory !== current.workingDirectory) {
    changes.push({
      field: 'workingDirectory',
      from: previous.workingDirectory,
    });
  }
  if (previous.isWorktree !== current.isWorktree) {
    changes.push({ field: 'isWorktree' });
  }
  if (previous.isGitRepo !== current.isGitRepo) {
    changes.push({ field: 'isGitRepo' });
  }
  const before = new Set(previous.additionalWorkingDirectories);
  const after = new Set(current.additionalWorkingDirectories);
  const added = [...after].filter((directory) => !before.has(directory));
  const removed = [...before].filter((directory) => !after.has(directory));
  if (added.length || removed.length) {
    changes.push({ field: 'additionalWorkingDirectories', added, removed });
  }
  return changes;
}

/**
 * The baseline is the last announcement the model saw; a malformed trailing
 * payload yields no baseline because the model never received it. Deltas also
 * need a full snapshot somewhere earlier in history to be meaningful.
 */
function findBaseline(
  messages: readonly Message[],
): EnvironmentSnapshot | undefined {
  let previous: EnvironmentSnapshot | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isEnvironmentMessage(message)) continue;
    const parsed = environmentAttachmentSchema.safeParse(message.attachment);
    if (!previous) {
      if (!parsed.success) return undefined;
      previous = parsed.data.snapshot;
    }
    if (parsed.success && parsed.data.changes === undefined) {
      return previous;
    }
  }
  return undefined;
}

/**
 * Compare with announcements retained in model-visible history, not with a
 * generation-time cache. Undelivered candidates do not advance the baseline;
 * resume, rewind, fork and compaction naturally use their own retained history.
 */
export async function getEnvironmentAttachments(
  ctx: AttachmentToolUseContext,
  messages: readonly Message[] = [],
): Promise<EnvironmentAttachment[]> {
  const { config } = ctx;
  if (!config) return [];

  // Config/attachment cwd can remain at the project root after Bash cd.
  // The Shell session/agent context owns the effective working directory.
  const cwd = runWithShellSession(config, getCwd);
  const additionalWorkingDirectories = config
    .getWorkspaceContext()
    .getDirectories()
    .filter((directory) => directory !== config.getTargetDir());
  const shell =
    process.env['SHELL'] ??
    (process.env[ENV_WINDOWS_SHELL_KIND] ===
    WINDOWS_SHELL_KIND_GIT_BASH
      ? 'Git Bash'
      : undefined) ??
    process.env['COMSPEC'] ??
    'unknown';
  const git = await getGitEnvironment(config, cwd);
  const snapshot: EnvironmentSnapshot = {
    workingDirectory: cwd,
    additionalWorkingDirectories,
    isWorktree: config.getWorktreeSettings?.() !== undefined || git.isWorktree,
    isGitRepo: git.isGitRepo,
    platform: process.platform,
    shell,
    osVersion: os.release(),
    architecture: process.arch,
    nodeVersion: process.version,
  };

  const previous = findBaseline(messages);
  if (
    !previous ||
    MACHINE_FIELDS.some((field) => previous[field] !== snapshot[field])
  ) {
    return [new EnvironmentAttachment({ type: 'environment', snapshot })];
  }
  const changes = changedFields(previous, snapshot);
  return changes.length > 0
    ? [new EnvironmentAttachment({ type: 'environment', snapshot, changes })]
    : [];
}
