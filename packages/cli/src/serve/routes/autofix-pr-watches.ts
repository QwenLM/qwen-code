/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runStatus,
  type StatusOutcome,
  type WatchStatus,
} from '../../commands/autofix-pr/status.js';
import { parseWorktreePaths } from '../../commands/autofix-pr/state.js';
import { sanitizedGitEnv } from '../../commands/review/lib/worktree.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { applyReadHeaders } from './workspace-file-read.js';

const execFileAsync = promisify(execFile);

/** One `git worktree list`: a hang must not hold the page. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * A watch as the Web Shell sees it: what `status` lists but `thisSession`
 * (the daemon is no session), the worktree's path and what git alone tells
 * (`gitTrusted`, `worktreeWork`), which the listing does not run git for.
 */
export type AutofixPrWatchView = Omit<
  WatchStatus,
  'thisSession' | 'worktreePath' | 'gitTrusted' | 'worktreeWork' | 'pushTarget'
>;

export interface AutofixPrWatchesView {
  v: 1;
  /** False when no git repository is found for the workspace (or git
   * cannot be run there): it holds no watch. */
  available: boolean;
  /** The clone's main worktree: two workspaces of one clone list the same
   * watches. */
  root?: string;
  /** When the files were read, for comparing `lastCheck` with. */
  now?: string;
  watches: AutofixPrWatchView[];
  /** State files that could not be read, with the reason. */
  unreadable?: StatusOutcome['unreadable'];
}

/**
 * Every worktree of the clone of `cwd`, main first; empty when the directory
 * is in no git repository. A watch keeps its files (`.qwen/tmp`) under the
 * worktree it was prepared from — under the daemon, the session's own — so
 * the listing scans all of them to find every watch of the clone. One git
 * call answers, on the listing's own short timeout.
 */
export async function cloneWorktreesOf(cwd: string): Promise<string[]> {
  const opts = {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    // As the helpers run git: an exported `GIT_DIR` or `GIT_CONFIG_*` would
    // point it at another repository.
    env: { ...sanitizedGitEnv(), GIT_TERMINAL_PROMPT: '0' },
  };
  try {
    // NUL-delimited so a worktree path holding a newline cannot fabricate an
    // extra root the listing would then read outside the clone.
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'],
      opts,
    );
    return parseWorktreePaths(stdout);
  } catch {
    // git before 2.36 has no `-z`, and the line form cannot safely list a
    // path that holds a newline, so fall back to the main worktree alone
    // (always the first record) rather than risk a fabricated root.
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', cwd, 'worktree', 'list', '--porcelain'],
        opts,
      );
      const first = stdout
        .split('\n')
        .find((line) => line.startsWith('worktree '));
      return first ? [first.slice('worktree '.length).replace(/\r$/, '')] : [];
    } catch {
      return [];
    }
  }
}

/**
 * What `qwen autofix-pr status` lists for the clone of `cwd`, read from the
 * files alone: no lock is taken, GitHub is not asked, and no git command
 * runs but the one that finds the clone (design Section 6.15). The files
 * are read without blocking, so one put in place of a watch's file cannot
 * hold the daemon.
 */
export async function listAutofixPrWatches(
  cwd: string,
  /** Throws once the workspace's runtime generation closed: a workspace
   * removed or replaced while git was asked lists nothing. */
  assertGenerationOpen?: () => void,
): Promise<AutofixPrWatchesView> {
  assertGenerationOpen?.();
  const worktrees = await cloneWorktreesOf(cwd);
  assertGenerationOpen?.();
  if (worktrees.length === 0) return { v: 1, available: false, watches: [] };
  // The main worktree names the clone for display; the scan covers every
  // worktree, so a watch prepared from any of them is listed.
  const root = worktrees[0]!;
  const outcome = runStatus({ roots: worktrees, git: false, session: null });
  // The CLI prints `unreadable[].error` with the full state-file path; this
  // view crosses the workspace boundary, so a sibling checkout's absolute
  // path and state-file name are redacted (the remedy names only the PR).
  const redactError = (error: string): string => {
    let redacted = error;
    for (const worktree of worktrees) {
      redacted = redacted.split(worktree).join('<worktree>');
    }
    return redacted.replace(/autofix-pr-\d+-state\.json/g, '<state-file>');
  };
  return {
    v: 1,
    available: true,
    root,
    now: outcome.now,
    watches: outcome.watches.map(
      ({
        thisSession: _session,
        worktreePath: _path,
        gitTrusted: _trusted,
        worktreeWork: _work,
        pushTarget: _target,
        ...watch
      }) => watch,
    ),
    ...(outcome.unreadable
      ? {
          unreadable: outcome.unreadable.map(({ pr, error }) => ({
            pr,
            error: redactError(error),
          })),
        }
      : {}),
  };
}

async function respond(
  res: Response,
  cwd: string,
  assertGenerationOpen?: () => void,
): Promise<void> {
  applyReadHeaders(res);
  try {
    res.status(200).json(await listAutofixPrWatches(cwd, assertGenerationOpen));
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    // The reason goes to the daemon's log; the answer names none of its
    // paths.
    writeStderrLine(
      `autofix-pr watches of ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({
      error: 'Could not read the autofix-pr watches of this workspace',
      code: 'autofix_pr_watches_failed',
    });
  }
}

/** `GET /autofix-pr/watches`: the primary workspace's. */
export function registerAutofixPrWatchesRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    isWorkspaceTrusted?: () => boolean;
    /** The primary runtime's generation, captured as a request starts. */
    captureGenerationAssertion?: () => (() => void) | undefined;
  },
): void {
  app.get('/autofix-pr/watches', async (_req, res) => {
    if (deps.isWorkspaceTrusted && !deps.isWorkspaceTrusted()) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    await respond(
      res,
      deps.boundWorkspace,
      deps.captureGenerationAssertion?.(),
    );
  });
}

/** `GET /workspaces/:workspace/autofix-pr/watches`: a registered one's. */
export function registerWorkspaceQualifiedAutofixPrWatchesRoutes(
  app: Application,
  deps: { workspaceRegistry: WorkspaceRegistry },
): void {
  app.get('/workspaces/:workspace/autofix-pr/watches', async (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
    await respond(res, runtime.workspaceCwd, () =>
      runtime.generationGuard?.assertOpen(),
    );
  });
}
