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
 * The clone's main worktree, where every watch of the clone keeps its files
 * (`.qwen/tmp`), whichever of its worktrees the workspace is; null when the
 * directory is in no git repository.
 */
export async function cloneRootOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'worktree', 'list', '--porcelain'],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // As the helpers run git: an exported `GIT_DIR` or `GIT_CONFIG_*`
        // would point it at another repository.
        env: { ...sanitizedGitEnv(), GIT_TERMINAL_PROMPT: '0' },
      },
    );
    const first = stdout.split('\n')[0] ?? '';
    return first.startsWith('worktree ')
      ? first.slice('worktree '.length).replace(/\r$/, '')
      : null;
  } catch {
    return null;
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
  const root = await cloneRootOf(cwd);
  assertGenerationOpen?.();
  if (root === null) return { v: 1, available: false, watches: [] };
  const outcome = runStatus({ root, git: false, session: null });
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
    ...(outcome.unreadable ? { unreadable: outcome.unreadable } : {}),
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
