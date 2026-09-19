/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application, RequestHandler, Response } from 'express';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import {
  commitIsReachable,
  dryRunGitWorktreePrune,
  listGitWorktrees,
  lockGitWorktree,
  pruneGitWorktrees,
  removeGitWorktree,
  unlockGitWorktree,
  worktreeHoldsSubmodules,
  type GitWorktreeEntry,
} from '@qwen-code/qwen-code-core/utils/git-worktrees.js';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';
import {
  gitErrorText,
  redactGitMessage,
  sendGitError,
} from './workspace-git-branches.js';

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The reason written on the locks that shield other stale registrations for
 * the duration of a prune. Recognisable, because a crash between the lock and
 * the unlock leaves it on screen.
 */
const PRUNE_GUARD_REASON = 'qwen-code: held while pruning another worktree';

/**
 * A shield lock this route left behind, which is not a user's lock.
 *
 * It only exists when a removal died between taking the lock and releasing
 * it, and git will neither prune nor force past it, so the entry it sits on
 * would be stuck. Recognising it is what makes that recoverable.
 */
function isOwnGuardLock(entry: GitWorktreeEntry): boolean {
  return entry.locked === PRUNE_GUARD_REASON;
}

function samePath(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b);
}

/**
 * Whether git would find anything at this path to validate.
 *
 * `lstat` rather than `existsSync`, which follows symlinks and so calls a
 * dangling one gone while git, finding the link itself, fails validating
 * `<path>/.git` against it. Any other `lstat` failure counts as nothing
 * found, because this answers what git's removal will do and the daemon not
 * being able to look does not stop git.
 */
function pathIsAbsent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether anything is still at this path — the question the user is answered
 * with, so it errs the other way from {@link pathIsAbsent}.
 *
 * Only `ENOENT` and `ENOTDIR` say the path is really gone. Every other
 * failure means the daemon could not look, and reporting "the directory went"
 * on the strength of not being able to see it is how a whole checkout
 * survives a removal in silence.
 */
function somethingRemainsAt(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/**
 * Whether this worktree still has a checkout of its own to read.
 *
 * Asking about one that does not is worse than not asking:
 * `getGitWorkingTreeStatus` resolves the repository by walking *up* from the
 * path it is given, so a broken entry under `<repo>/.qwen/worktrees/` gets
 * answered with the **main** worktree's branch and counters, attributed to the
 * worktree the caller asked about.
 *
 * git reaches a linked worktree through a `<path>/.git` *gitfile*, so that is
 * the test: a missing one means the checkout is gone (which git's own
 * `prunable` mark does not always say — a *locked* worktree never gets it),
 * and a `.git` directory there is a repository someone created in its place,
 * whose branch would misattribute just as badly. Only the main worktree
 * legitimately has a directory.
 *
 * It screens the shape, not the pairing: a gitfile belonging to a *different*
 * repository passes, and that repository's branch and counters are then
 * reported under this entry — and reused for the dirty refusal, so the user
 * can be told this worktree has changes that in fact live in the other one.
 * Doing better means repeating git's own back-pointer validation, or another
 * git process per probe. git applies that validation itself and refuses every
 * removal of such an entry at every force level, so what is at stake is a
 * wrong answer and a wrong refusal, never a deletion.
 */
function isReadableCheckout(entry: GitWorktreeEntry): boolean {
  try {
    return fs.statSync(path.join(entry.path, '.git')).isFile() || entry.isMain;
  } catch {
    return false;
  }
}

/**
 * Whether {@link isReadableCheckout} said no because the daemon could not
 * look, rather than because there is nothing of ours there.
 *
 * The two are worlds apart for a refusal: a worktree git has lost holds no
 * uncommitted work to warn about, while one behind an unreadable parent may
 * hold plenty — and saying nothing about it is the same as saying there is
 * none.
 */
function checkoutIsUnseeable(entry: GitWorktreeEntry): boolean {
  try {
    fs.statSync(path.join(entry.path, '.git'));
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

function managedSlug(
  entry: GitWorktreeEntry,
  managedDir: string,
): string | undefined {
  const relative = path.relative(realpathOrSelf(managedDir), entry.path);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep)[0]
    : undefined;
}

function toWire(
  entry: GitWorktreeEntry,
  runtime: WorkspaceRuntime,
  managedDir: string,
): Record<string, unknown> {
  const slug = managedSlug(entry, managedDir);
  // `git worktree lock --reason` text: written by anyone who can run git in
  // this repository, unbounded, and free to quote absolute paths. It goes to
  // a browser, so it is redacted and bounded like any other git prose.
  const locked =
    entry.locked !== undefined
      ? redactGitMessage(entry.locked, runtime.workspaceCwd)
      : undefined;
  return {
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    detached: entry.detached,
    bare: entry.bare,
    ...(locked !== undefined ? { locked } : {}),
    ...(entry.prunable !== undefined ? { prunable: entry.prunable } : {}),
    isMain: entry.isMain,
    isWorkspace: samePath(entry.path, runtime.workspaceCwd),
    ...(slug ? { slug } : {}),
  };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ error, code, ...extra });
}

/**
 * Live sessions whose checkout is this worktree, counted across every
 * registered runtime rather than only the selected one.
 *
 * This is the one place the route reads outside the runtime it resolved, and
 * it is deliberate: a worktree of this repository can host a session that
 * belongs to a *different* registered workspace, and deleting the directory
 * out from under it is exactly the harm the refusal exists to prevent. The
 * selected runtime still decides everything else, and still owns the git
 * invocation.
 *
 * `listManaged` rather than `listAll`, because a workspace that is draining,
 * blocked, or mid-replacement still holds a live bridge with live sessions,
 * and those are the sessions a removal would strand. Ids key the set so the
 * number the user is shown counts each session once.
 */
function countLiveSessionsIn(
  registry: WorkspaceRegistry,
  worktreePath: string,
): number {
  const target = realpathOrSelf(worktreePath);
  const sessionIds = new Set<string>();
  for (const runtime of registry.listManaged()) {
    for (const session of runtime.bridge.listWorkspaceSessions(
      runtime.workspaceCwd,
    )) {
      // Sessions usually carry the very path git listed, so compare the
      // strings before spending a `realpath` syscall on each one.
      if (
        session.worktree !== undefined &&
        (session.worktree.path === worktreePath ||
          realpathOrSelf(session.worktree.path) === target)
      ) {
        sessionIds.add(session.sessionId);
      }
    }
  }
  return sessionIds.size;
}

async function findWorktree(
  runtime: WorkspaceRuntime,
  target: unknown,
): Promise<GitWorktreeEntry | null | undefined> {
  if (typeof target !== 'string' || !target) return undefined;
  const entries = await listGitWorktrees(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  return entries.find((entry) => entry.path === target) ?? null;
}

/**
 * Workspace-scoped: every route resolves inside the selected runtime and
 * lists, inspects, or removes worktrees of that workspace's repository only.
 * The single exception is the removal refusal, which counts live sessions
 * across every registered workspace's live bridge — see
 * {@link countLiveSessionsIn}.
 */
export function registerWorkspaceQualifiedGitWorktreeRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  app.get('/workspaces/:workspace/git/worktrees', async (req, res) => {
    const route = 'GET /workspaces/:workspace/git/worktrees';
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    try {
      runtime.generationGuard?.assertOpen();
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      deps.sendBridgeError(res, err, { route });
      return;
    }
    try {
      applyReadHeaders(res);
      const entries = await listGitWorktrees(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
      ).catch(() => null);
      if (!entries) {
        res.status(200).json({
          v: 1,
          workspaceCwd: runtime.workspaceCwd,
          available: false,
          worktrees: [],
        });
        return;
      }
      const managedDir = new GitWorktreeService(
        runtime.workspaceCwd,
      ).getUserWorktreesDir();
      // Listing a repository takes as long as git takes, and the workspace
      // can be replaced meanwhile. Answering then would describe a
      // repository this connection no longer owns.
      runtime.generationGuard?.assertOpen();
      res.status(200).json({
        v: 1,
        workspaceCwd: runtime.workspaceCwd,
        available: true,
        worktrees: entries.map((entry) => toWire(entry, runtime, managedDir)),
      });
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      sendGitError(res, err, route, deps.sendBridgeError, runtime.workspaceCwd);
    }
  });

  app.get('/workspaces/:workspace/git/worktrees/status', async (req, res) => {
    const route = 'GET /workspaces/:workspace/git/worktrees/status';
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    try {
      runtime.generationGuard?.assertOpen();
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      deps.sendBridgeError(res, err, { route });
      return;
    }
    try {
      applyReadHeaders(res);
      const entry = await findWorktree(runtime, req.query['path']);
      if (entry === undefined) {
        sendError(res, 400, 'invalid_path', 'path query parameter is required');
        return;
      }
      if (entry === null) {
        sendError(
          res,
          404,
          'worktree_not_found',
          'No worktree of this repository has that path',
        );
        return;
      }
      // A broken worktree has no state of its own to report, and probing for
      // it would answer about the main worktree instead — see
      // {@link isReadableCheckout}.
      const status = isReadableCheckout(entry)
        ? await getGitWorkingTreeStatus(entry.path)
        : null;
      runtime.generationGuard?.assertOpen();
      res.status(200).json(
        status
          ? {
              v: 1,
              path: entry.path,
              available: true,
              branch: status.branch,
              detached: status.detached,
              staged: status.staged,
              unstaged: status.unstaged,
              untracked: status.untracked,
              conflicted: status.conflicted,
              ahead: status.ahead,
              behind: status.behind,
            }
          : { v: 1, path: entry.path, available: false },
      );
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      // git's stderr names absolute host paths; the destructive route has
      // always redacted it and these two read routes reach the same git.
      sendGitError(res, err, route, deps.sendBridgeError, runtime.workspaceCwd);
    }
  });

  app.post(
    '/workspaces/:workspace/git/worktrees/remove',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/git/worktrees/remove';
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, { route });
        return;
      }
      const body = safeBody(req);
      const force = body['force'] === true;
      let entry: GitWorktreeEntry | null | undefined;
      try {
        entry = await findWorktree(runtime, body['path']);
      } catch (err) {
        sendGitError(
          res,
          err,
          route,
          deps.sendBridgeError,
          runtime.workspaceCwd,
        );
        return;
      }
      if (entry === undefined) {
        sendError(res, 400, 'invalid_path', 'path is required');
        return;
      }
      if (entry === null) {
        sendError(
          res,
          404,
          'worktree_not_found',
          'No worktree of this repository has that path',
        );
        return;
      }
      // `bare` is redundancy, not a second way in: git prints the bare
      // entry first, which is what makes it main. Cheap to keep on a
      // destructive path, so no test pins it on its own.
      if (entry.isMain || entry.bare) {
        sendError(
          res,
          409,
          'worktree_is_main',
          'The main worktree cannot be removed',
        );
        return;
      }
      if (
        deps.workspaceRegistry
          .listAllEntries()
          .some((registered) => samePath(registered.workspaceCwd, entry.path))
      ) {
        sendError(
          res,
          409,
          'worktree_is_workspace',
          'This worktree is the root of a registered workspace and cannot be removed here',
        );
        return;
      }
      // A shield lock this route left behind is not a user's lock, and git
      // refuses a locked worktree at every force level while prune skips it.
      // Releasing it is the only way back, so it happens whether or not the
      // request forces — and the mark it suppressed is re-read, because the
      // fallback that clears such an entry is keyed on it.
      let prunable = entry.prunable;
      if (isOwnGuardLock(entry)) {
        await unlockGitWorktree(
          runtime.workspaceCwd,
          entry.path,
          runtime.env.effectiveEnv,
        ).catch(() => {});
        const refreshed = await findWorktree(runtime, entry.path).catch(
          () => null,
        );
        if (refreshed) prunable = refreshed.prunable;
      }
      const stillRegistered = async (): Promise<boolean> =>
        (
          await listGitWorktrees(runtime.workspaceCwd, runtime.env.effectiveEnv)
        ).some((left) => left.path === entry.path);
      try {
        // Everything the second click would discard is gathered before any of
        // it is reported. Whichever refusal wins, the user answers it once
        // and `force` then overrides all of them at once — so a lock or a
        // live session reported on its own would hide the uncommitted work
        // behind a sentence that never mentions it.
        if (!force) {
          // A worktree git can no longer reach has no uncommitted work of
          // its own to protect — usually the directory is gone entirely, and
          // where it survives without its gitfile git has stopped treating
          // its contents as a checkout. Asking anyway would answer about the
          // main worktree (see {@link isReadableCheckout}) and refuse this
          // removal over changes that live somewhere else.
          let changes = 0;
          let statusUnknown = false;
          let operation: string | undefined;
          if (isReadableCheckout(entry)) {
            // `countHiddenUntracked`, because a repository that sets
            // `status.showUntrackedFiles = no` hides those files from git's
            // own safety check as well, and this gate is what is left.
            const status = await getGitWorkingTreeStatus(entry.path, {
              countHiddenUntracked: true,
            });
            if (!status) statusUnknown = true;
            else {
              changes =
                status.staged +
                status.unstaged +
                status.untracked +
                status.conflicted;
              // A halted rebase, merge, cherry-pick, revert or bisect can
              // leave every counter at zero and still be work: its state
              // lives in the admin directory the removal deletes.
              operation = status.operation;
            }
          } else if (checkoutIsUnseeable(entry)) {
            statusUnknown = true;
          }
          // A detached worktree is the only thing pointing at its own HEAD.
          // Its commits are not "uncommitted work" and no counter sees them,
          // yet nothing keeps them once the entry goes — which is the one
          // loss here that no amount of looking on disk can undo.
          let unmergedHead: string | undefined;
          if (entry.detached && entry.head) {
            const reachable = await commitIsReachable(
              runtime.workspaceCwd,
              entry.head,
              runtime.env.effectiveEnv,
            ).catch(() => false);
            if (!reachable) unmergedHead = entry.head;
          }
          // What a refusal about something else still has to mention. Not
          // knowing counts too: "could not be checked" is a warning, and
          // returning it on its own here would hide a live session behind it.
          const alsoDiscards = {
            ...(statusUnknown
              ? { statusUnknown: true }
              : changes > 0
                ? { changes }
                : {}),
            ...(operation ? { operation } : {}),
            ...(unmergedHead ? { unmergedHead } : {}),
          };
          // One exit for every refusal, because the invariant is that
          // whichever one answers names everything the second click takes —
          // and a per-branch payload is how a branch comes to forget one.
          // The submodule probe hangs off it rather than off the git call
          // that refuses: a worktree stopped by any gate above never reaches
          // git, and its nested repository goes just the same.
          const refuse = async (
            code: string,
            message: string,
            extra: Record<string, unknown> = {},
          ): Promise<void> => {
            const submodules = isReadableCheckout(entry)
              ? await worktreeHoldsSubmodules(
                  entry.path,
                  runtime.env.effectiveEnv,
                ).catch(() => false)
              : false;
            sendError(res, 409, code, message, {
              ...extra,
              ...alsoDiscards,
              ...(submodules ? { submodules: true } : {}),
            });
          };
          // Reads every registered workspace's bridge, so a forced removal
          // never pays for an answer it would ignore.
          const liveSessions = countLiveSessionsIn(
            deps.workspaceRegistry,
            entry.path,
          );
          if (liveSessions > 0) {
            await refuse(
              'worktree_in_use',
              'Sessions are still running in this worktree',
              { sessions: liveSessions },
            );
            return;
          }
          // git refuses a locked worktree and says so by naming the override
          // ("use 'remove -f -f' to override or unlock first"). Refusing here
          // instead turns that into the same second click a dirty worktree
          // gets: the listing already carries the lock, so this costs nothing
          // and the alternative is git's sentence with nothing to press.
          // `--force --force` clears a lock on a checkout git can still
          // reach, and on one whose path holds nothing at all — there is
          // nothing left to validate. A dangling symlink is not that: git
          // finds the link and fails on it, so it stays with the shapes
          // below. What it never clears is a directory
          // that outlived its gitfile, and prune skips it for the lock, so
          // reporting *that* as a lock would offer a second click with
          // nowhere to land. Leave it to git and report git's own refusal.
          if (
            !isOwnGuardLock(entry) &&
            entry.locked !== undefined &&
            (isReadableCheckout(entry) || pathIsAbsent(entry.path))
          ) {
            await refuse('worktree_locked', 'The worktree is locked', {
              ...(entry.locked
                ? {
                    reason: redactGitMessage(
                      entry.locked,
                      runtime.workspaceCwd,
                    ),
                  }
                : {}),
            });
            return;
          }
          if (unmergedHead) {
            await refuse(
              'worktree_unmerged_commits',
              'No branch keeps the commits this worktree points at',
            );
            return;
          }
          if (changes > 0) {
            await refuse(
              'worktree_dirty',
              'The worktree has uncommitted changes',
            );
            return;
          }
          if (operation) {
            await refuse(
              'worktree_operation_in_progress',
              'A git operation is unfinished in this worktree',
            );
            return;
          }
          if (statusUnknown) {
            await refuse(
              'worktree_status_unknown',
              'The working tree state could not be read',
            );
            return;
          }
        }
        try {
          await removeGitWorktree(
            runtime.workspaceCwd,
            entry.path,
            { force },
            runtime.env.effectiveEnv,
          );
        } catch (removeError) {
          // A rejection does not mean nothing happened: git deletes the
          // checkout and drops the registration as two steps, either can
          // fail, and a failed deletion does not stop the drop — so the
          // registration this route removes may already be gone. Ask the
          // listing rather than assume, or a retry of a request that
          // succeeded would answer 404.
          if (await stillRegistered()) {
            // git refuses, at every force level, to remove a registration
            // it has marked prunable — a directory that outlived its gitfile,
            // or a path that is no longer a directory at all; `git worktree
            // prune` is the only command that clears those. It is
            // repository-wide — it
            // drops every registration git has already marked stale — which
            // is why it is the fallback and never the first move. It deletes
            // no files.
            if (prunable === undefined) {
              // git refused and the registration still stands, so nothing
              // happened. Several of its refusals clear under
              // `--force --force` — a worktree holding initialised
              // submodules is git's own example, and `git status` calls such
              // a worktree clean, so nothing earlier could have caught it.
              // Reported as an unclassified failure the tab can only show,
              // this is a dead end for a removal the daemon can perform.
              //
              // Only for a checkout git can still reach: where
              // `isReadableCheckout` already says it cannot, no force level
              // clears it and a second click would spend itself on the same
              // refusal. That test is about the gitfile's shape, so the one
              // it does not screen out is a gitfile belonging to another
              // repository, which is offered a force that fails.
              if (!force && isReadableCheckout(entry)) {
                // git's usual reason for refusing a checkout it can reach is
                // a submodule, and what it does not say is that forcing takes
                // the submodule's own repository too — leaving the branch it
                // kept naming a commit nothing can fetch.
                const submodules = await worktreeHoldsSubmodules(
                  entry.path,
                  runtime.env.effectiveEnv,
                ).catch(() => false);
                sendError(
                  res,
                  409,
                  'worktree_remove_refused',
                  'git refused to remove this worktree',
                  {
                    detail: gitErrorText(removeError, runtime.workspaceCwd)
                      .message,
                    ...(submodules ? { submodules: true } : {}),
                  },
                );
                return;
                // (This arm is outside the `!force` gathering above, so it
                // asks for itself.)
              }
              throw removeError;
            }
            // `git worktree prune` has no per-path form: it drops every
            // registration git has marked stale, and with each one the admin
            // directory holding that worktree's HEAD and reflog — the last
            // thing pointing at commits nothing else keeps. git skips locked
            // worktrees, so the others are locked for the duration and this
            // becomes the per-path removal the rest of the route is.
            const held: string[] = [];
            try {
              // Locking makes an entry stop being prunable, so a listing
              // that comes back with nothing new means everything it can see
              // is shielded. Anything that goes stale in between shows up in
              // the next pass.
              let covered = false;
              for (let pass = 0; pass < 3 && !covered; pass += 1) {
                const exposed = (
                  await listGitWorktrees(
                    runtime.workspaceCwd,
                    runtime.env.effectiveEnv,
                  )
                ).filter(
                  (other) =>
                    other.prunable !== undefined &&
                    !samePath(other.path, entry.path),
                );
                if (exposed.length === 0) {
                  covered = true;
                  break;
                }
                for (const other of exposed) {
                  try {
                    await lockGitWorktree(
                      runtime.workspaceCwd,
                      other.path,
                      PRUNE_GUARD_REASON,
                      runtime.env.effectiveEnv,
                    );
                  } catch {
                    // The user asked about this worktree, not that one.
                    throw removeError;
                  }
                  held.push(other.path);
                }
              }
              if (!covered) throw removeError;
              // The listing is not the same set as what prune drops: a
              // registration whose gitdir file is missing or empty is invisible
              // to it and cannot be locked either, yet prune takes it — and
              // with it the last anchor for commits nothing else keeps. git's
              // own dry run is the complete answer, so the shield is proven
              // against that: exactly one entry left to drop, and it is the
              // one that was asked for.
              const wouldDrop = await dryRunGitWorktreePrune(
                runtime.workspaceCwd,
                runtime.env.effectiveEnv,
              );
              if (wouldDrop.length !== 1) throw removeError;
              await pruneGitWorktrees(
                runtime.workspaceCwd,
                runtime.env.effectiveEnv,
              );
            } finally {
              for (const path of held) {
                await unlockGitWorktree(
                  runtime.workspaceCwd,
                  path,
                  runtime.env.effectiveEnv,
                ).catch(() => {
                  // Left locked with a reason that names this route, which
                  // the next removal of that entry recognises and releases —
                  // git itself would refuse it at every force level.
                });
              }
            }
            // git never marks a locked worktree prunable, so prune clears
            // what the listing showed — but the listing is a snapshot, and a
            // lock taken since then would make prune skip this one silently.
            // Confirm the registration actually went rather than inferring it
            // from prune having run: reporting a removal that did not happen
            // is the failure this route inherited and is not about to repeat.
            if (await stillRegistered()) throw removeError;
          }
        }
        // Removal is not all-or-nothing. git deletes the checkout first and
        // drops the registration second, and it drops it even when the
        // deletion failed — a read-only subtree, a file another process holds
        // open — while the prune fallback deletes no files at all. Both land
        // here, registration gone and something still at the path, and the
        // confirmation the user answered promised the directory would go. Say
        // which one happened instead of letting that promise stand — and say
        // it whenever the daemon cannot prove otherwise, since the case it
        // cannot see is exactly the one where a whole checkout survives.
        res.status(200).json({
          removed: true,
          path: entry.path,
          ...(somethingRemainsAt(entry.path) ? { directoryRemains: true } : {}),
        });
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        sendGitError(
          res,
          err,
          route,
          deps.sendBridgeError,
          runtime.workspaceCwd,
        );
      }
    },
  );
}
