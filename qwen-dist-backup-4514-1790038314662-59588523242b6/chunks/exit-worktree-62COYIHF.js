// Force strict mode and setup for ESM
"use strict";
import {
  clearWorktreeSession,
  isSessionRuntimeActive,
  readWorktreeSession
} from "./chunk-M5YIHMXP.js";
import {
  GitWorktreeService,
  readWorktreeSessionMarker,
  worktreeBranchForSlug
} from "./chunk-KS6F6LZQ.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-AUFTA63J.js";
import "./chunk-25FMWESU.js";
import "./chunk-CA63HYHU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/exit-worktree.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
import * as path from "node:path";
var debugLogger = createDebugLogger("EXIT_WORKTREE");
var exitWorktreeDescription = `Exits a worktree previously created by ${ToolNames.ENTER_WORKTREE}.

## Behavior

- \`action='keep'\` \u2014 preserves the worktree directory and branch on disk so it can be revisited later. Use when work is in progress and the user might come back to it.
- \`action='remove'\` \u2014 deletes the worktree directory and branch. **Refuses to run** if the worktree contains uncommitted changes (tracked or untracked) unless \`discard_changes: true\` is set. Use when the work is committed (or intentionally being discarded).

## When to Use

Only invoke this tool when the user explicitly asks to leave or clean up a worktree (e.g. "exit the worktree", "remove that worktree", "we're done with the worktree"). Always pass the same \`name\` that was used with \`${ToolNames.ENTER_WORKTREE}\`.
`;
var ExitWorktreeInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "ExitWorktreeInvocation");
  }
  getDescription() {
    return this.params.action === "remove" ? `Remove worktree "${this.params.name}"` : `Keep worktree "${this.params.name}"`;
  }
  /**
   * `action: 'remove'` deletes a worktree directory and (when safe) its
   * branch. Other destructive tools (`edit`, `write_file`,
   * `run_shell_command`) prompt by default; this tool should too. The
   * `keep` action is non-destructive (it only restores the original
   * working directory) and falls back to the framework default.
   */
  async getDefaultPermission() {
    return this.params.action === "remove" ? "ask" : "allow";
  }
  /**
   * Override the framework's default `type: 'info'` confirmation for
   * `action: 'remove'` so it is NOT silently auto-approved in
   * `AUTO_EDIT` mode.
   *
   * Background: `permissionFlow.ts:isAutoEditApproved` auto-approves
   * any tool whose `confirmationDetails.type` is `'edit'` or `'info'`
   * when the session is in `AUTO_EDIT`. The base `BaseToolInvocation`
   * returns `type: 'info'` by default, which means a `getDefaultPermission`
   * of `'ask'` still gets bypassed in AUTO_EDIT — the data-loss path
   * we explicitly closed for `DEFAULT` mode. Returning `type: 'exec'`
   * (the same bucket `run_shell_command` lives in) keeps the
   * confirmation prompt for AUTO_EDIT users too. `keep` falls through
   * to the base info-type since it is non-destructive.
   */
  async getConfirmationDetails(_abortSignal) {
    if (this.params.action !== "remove") {
      return super.getConfirmationDetails(_abortSignal);
    }
    const target = await this.resolveConfirmationTarget();
    const worktreePath = target.worktreePath;
    const branch = target.branch;
    const command = `git worktree remove ${worktreePath} && git branch -d ${branch}`;
    const details = {
      type: "exec",
      title: `Remove worktree "${this.params.name}"`,
      command,
      rootCommand: "git",
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
    return details;
  }
  async execute(_signal) {
    const cwd = this.config.getTargetDir();
    const probe = new GitWorktreeService(cwd);
    const projectRoot = await probe.getRepoTopLevel() ?? cwd;
    let service = projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);
    let worktreePath = service.getUserWorktreePath(this.params.name);
    let branch = worktreeBranchForSlug(this.params.name);
    let currentWorktreeSession = null;
    let currentSessionInWorktree = false;
    let ownerProjectRoot = projectRoot;
    let exists = false;
    try {
      exists = await isDirectory(worktreePath);
    } catch (error) {
      debugLogger.warn(`exit_worktree: cannot stat ${worktreePath}: ${error}`);
      return errorResult(
        `Cannot access worktree at ${worktreePath} (${error instanceof Error ? error.message : String(error)}).`
      );
    }
    if (!exists) {
      const resolved = await this.resolveCurrentSessionWorktree();
      if (resolved) {
        service = resolved.service;
        worktreePath = resolved.worktreePath;
        branch = resolved.branch;
        currentWorktreeSession = resolved.session;
        exists = true;
      } else {
        const current = await resolveManagedWorktreeFromCwd(
          cwd,
          this.params.name
        );
        if (current) {
          service = new GitWorktreeService(current.repoRoot);
          worktreePath = current.worktreePath;
          branch = worktreeBranchForSlug(this.params.name);
          currentSessionInWorktree = true;
          ownerProjectRoot = current.repoRoot;
          exists = true;
        }
      }
    }
    if (!exists) {
      return errorResult(
        `Worktree "${this.params.name}" not found at ${worktreePath}.`
      );
    }
    if (this.params.action === "keep") {
      const output2 = {
        action: "keep",
        worktreePath,
        worktreeBranch: branch,
        message: `Kept worktree "${this.params.name}" at ${worktreePath}. Resume work there by referencing this path in subsequent tool calls.`
      };
      return {
        llmContent: JSON.stringify(output2),
        returnDisplay: `Kept worktree **${this.params.name}** at \`${worktreePath}\``
      };
    }
    const owner = await readWorktreeSessionMarker(worktreePath);
    const currentSessionId = this.config.getSessionId();
    if (owner !== null && owner !== currentSessionId) {
      currentWorktreeSession ??= await this.readCurrentWorktreeSession();
      const currentSessionOwnsPath = currentWorktreeSession?.slug === this.params.name && currentWorktreeSession.supersededBy === void 0 && samePath(currentWorktreeSession.worktreePath, worktreePath);
      const ownerActive = await isSessionRuntimeActive(
        owner,
        currentWorktreeSession ? [
          currentWorktreeSession.originalCwd,
          currentWorktreeSession.worktreePath
        ] : [ownerProjectRoot, worktreePath]
      ).catch((error) => {
        debugLogger.warn(
          `exit_worktree: failed to check owner runtime ${owner}: ${error}`
        );
        return true;
      });
      if (ownerActive || !currentSessionOwnsPath && !currentSessionInWorktree) {
        return errorResult(
          `Refusing to remove worktree "${this.params.name}" \u2014 it was created by a different session (owner=${owner}). Resume the owning session to drop it, or remove it manually with \`git worktree remove ${worktreePath}\`.`
        );
      }
      debugLogger.warn(
        `exit_worktree: allowing session ${currentSessionId} to remove ${worktreePath}; stale marker owner=${owner}`
      );
    }
    if (owner === null) {
      debugLogger.warn(
        `exit_worktree: worktree ${worktreePath} has no session marker; allowing removal from session ${currentSessionId}`
      );
    }
    if (!this.params.discard_changes) {
      const counts = await service.countWorktreeChanges(worktreePath);
      if (counts === null) {
        return errorResult(
          `Cannot inspect worktree "${this.params.name}" \u2014 git status failed against ${worktreePath}. Check filesystem permissions and repository integrity, then call ${ToolNames.EXIT_WORKTREE} again.`
        );
      }
      const total = counts.tracked + counts.untracked;
      if (total > 0) {
        return errorResult(
          `Refusing to remove worktree "${this.params.name}" \u2014 it has ${counts.tracked} tracked change(s) and ${counts.untracked} untracked file(s). Commit or stash first, or call again with \`discard_changes: true\`.`
        );
      }
    }
    let hasUnmerged = true;
    try {
      hasUnmerged = await service.hasUnmergedWorktreeCommits(this.params.name);
    } catch (error) {
      debugLogger.warn(
        `exit_worktree: hasUnmergedWorktreeCommits failed for ${branch}: ${error}`
      );
    }
    if (hasUnmerged) {
      return errorResult(
        `Refusing to remove worktree "${this.params.name}" \u2014 its branch \`${branch}\` has commits that no other branch or remote ref points at, and deleting the branch would lose them. Merge, push, or rename the branch first, then call ${ToolNames.EXIT_WORKTREE} again.`
      );
    }
    const result = await service.removeUserWorktree(this.params.name, {
      deleteBranch: true
    });
    if (!result.success) {
      return errorResult(result.error ?? "Failed to remove worktree.");
    }
    if (result.branchPreserved) {
      await this.maybeClearWorktreeSession();
      const output2 = {
        action: "remove",
        worktreePath,
        worktreeBranch: branch,
        message: `Removed worktree directory "${this.params.name}" but kept branch ${branch} (git refused a safe delete at the last moment \u2014 possibly a race with another process). Recover with \`git branch -D ${branch}\` if you really want to discard it.`
      };
      return {
        llmContent: JSON.stringify(output2),
        returnDisplay: `Removed worktree directory **${this.params.name}**, branch \`${branch}\` preserved`
      };
    }
    debugLogger.debug(
      `Removed user worktree: ${worktreePath} (branch=${branch})`
    );
    await this.maybeClearWorktreeSession();
    const output = {
      action: "remove",
      worktreePath,
      worktreeBranch: branch,
      message: `Removed worktree "${this.params.name}" and deleted branch ${branch}.`
    };
    return {
      llmContent: JSON.stringify(output),
      returnDisplay: `Removed worktree **${this.params.name}** (branch \`${branch}\`)`
    };
  }
  /**
   * Clears the WorktreeSession sidecar file iff its `slug` matches the
   * worktree being exited. We skip the clear when the sidecar names a
   * different slug because the user might have multiple worktrees on
   * disk while the sidecar tracks only one — wiping it on every exit
   * would orphan the currently-tracked worktree from the CLI's view.
   *
   * Best-effort: failures are logged, never raised.
   */
  async maybeClearWorktreeSession() {
    try {
      const sessionPath = this.config.getSessionService().getWorktreeSessionPath(this.config.getSessionId());
      const existing = await readWorktreeSession(sessionPath);
      if (existing && existing.slug === this.params.name) {
        await clearWorktreeSession(sessionPath);
      }
    } catch (error) {
      debugLogger.warn(
        `exit_worktree: failed to clear WorktreeSession sidecar: ${error}`
      );
    }
  }
  async readCurrentWorktreeSession() {
    try {
      const sessionPath = this.config.getSessionService().getWorktreeSessionPath(this.config.getSessionId());
      return await readWorktreeSession(sessionPath);
    } catch (error) {
      debugLogger.warn(
        `exit_worktree: failed to read current WorktreeSession sidecar: ${error}`
      );
      return null;
    }
  }
  async resolveCurrentSessionWorktree() {
    const session = await this.readCurrentWorktreeSession();
    if (!session || session.slug !== this.params.name) {
      return null;
    }
    const service = new GitWorktreeService(session.originalCwd);
    const expectedPath = service.getUserWorktreePath(this.params.name);
    if (!samePath(session.worktreePath, expectedPath)) {
      return null;
    }
    try {
      if (!await isDirectory(session.worktreePath)) {
        return null;
      }
    } catch (error) {
      debugLogger.warn(
        `exit_worktree: cannot stat sidecar worktree ${session.worktreePath}: ${error}`
      );
      return null;
    }
    return {
      service,
      worktreePath: session.worktreePath,
      branch: session.worktreeBranch,
      session
    };
  }
  async resolveConfirmationTarget() {
    const cwd = this.config.getTargetDir();
    const probe = new GitWorktreeService(cwd);
    const projectRoot = await probe.getRepoTopLevel() ?? cwd;
    const service = projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);
    const worktreePath = service.getUserWorktreePath(this.params.name);
    try {
      if (await isDirectory(worktreePath)) {
        return {
          worktreePath,
          branch: worktreeBranchForSlug(this.params.name)
        };
      }
    } catch {
      return {
        worktreePath,
        branch: worktreeBranchForSlug(this.params.name)
      };
    }
    const resolved = await this.resolveCurrentSessionWorktree();
    if (resolved) {
      return {
        worktreePath: resolved.worktreePath,
        branch: resolved.branch
      };
    }
    const current = await resolveManagedWorktreeFromCwd(cwd, this.params.name);
    if (current) {
      return {
        worktreePath: current.worktreePath,
        branch: worktreeBranchForSlug(this.params.name)
      };
    }
    return {
      worktreePath,
      branch: worktreeBranchForSlug(this.params.name)
    };
  }
};
function errorResult(message) {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: `Error: ${message}`,
    error: { message }
  };
}
__name(errorResult, "errorResult");
async function isDirectory(filePath) {
  try {
    const stat2 = await fs.stat(filePath);
    return stat2.isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
__name(isDirectory, "isDirectory");
function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}
__name(samePath, "samePath");
async function resolveManagedWorktreeFromCwd(cwd, slug) {
  let cursor = path.resolve(cwd);
  while (true) {
    if (path.basename(cursor) === slug && path.basename(path.dirname(cursor)) === "worktrees" && path.basename(path.dirname(path.dirname(cursor))) === ".qwen") {
      const repoRoot = path.dirname(path.dirname(path.dirname(cursor)));
      if (await isDirectory(cursor)) {
        return { repoRoot, worktreePath: cursor };
      }
      return null;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}
__name(resolveManagedWorktreeFromCwd, "resolveManagedWorktreeFromCwd");
var ExitWorktreeTool = class _ExitWorktreeTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _ExitWorktreeTool.Name,
      ToolDisplayNames.EXIT_WORKTREE,
      exitWorktreeDescription,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Slug of the worktree to exit (must match the name used in enter_worktree)."
          },
          action: {
            type: "string",
            enum: ["keep", "remove"],
            description: '"keep" preserves the worktree on disk; "remove" deletes it and its branch.'
          },
          discard_changes: {
            type: "boolean",
            description: 'When action="remove", must be true to delete a worktree with uncommitted changes.'
          }
        },
        required: ["name", "action"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#"
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — only invoked when the user explicitly asks to leave a worktree
      false,
      // alwaysLoad
      "worktree exit leave remove keep cleanup"
    );
    this.config = config;
  }
  static {
    __name(this, "ExitWorktreeTool");
  }
  static Name = ToolNames.EXIT_WORKTREE;
  validateToolParams(params) {
    if (typeof params.name !== "string" || params.name.trim() === "") {
      return 'Parameter "name" must be a non-empty string.';
    }
    const slugError = GitWorktreeService.validateUserWorktreeSlug(params.name, {
      allowPrBackedShape: true
    });
    if (slugError) return slugError;
    if (params.action !== "keep" && params.action !== "remove") {
      return 'Parameter "action" must be either "keep" or "remove".';
    }
    if (params.discard_changes !== void 0 && typeof params.discard_changes !== "boolean") {
      return 'Parameter "discard_changes" must be a boolean.';
    }
    return null;
  }
  createInvocation(params) {
    return new ExitWorktreeInvocation(this.config, params);
  }
};
export {
  ExitWorktreeTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
