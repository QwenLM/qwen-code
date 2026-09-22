// Force strict mode and setup for ESM
"use strict";
import {
  writeWorktreeSession
} from "./chunk-M5YIHMXP.js";
import {
  GitWorktreeService,
  writeWorktreeSessionMarker
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
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/enter-worktree.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("ENTER_WORKTREE");
var enterWorktreeDescription = `Creates an isolated git worktree at \`<projectRoot>/.qwen/worktrees/<slug>\` and returns its absolute path so subsequent file edits, shell commands, and other tools can operate inside it.

## When to Use

Only invoke this tool when the user **explicitly asks for a worktree** \u2014 e.g. "start a worktree", "use a worktree", "work in a worktree", "create a worktree".

## When NOT to Use

Do NOT call this tool when the user simply asks to fix a bug, implement a feature, create a branch, or check out code \u2014 those tasks belong to the regular working directory unless the user specifically mentions worktrees.

## Behavior

- Requires the current project to be a git repository.
- Creates a new branch \`worktree-<slug>\` based on the current branch.
- Returns the absolute \`worktreePath\`. From that point on, route every file path you create or edit through this directory; absolute paths are recommended.
- The worktree persists across the session until \`exit_worktree\` is invoked.
`;
var EnterWorktreeInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "EnterWorktreeInvocation");
  }
  getDescription() {
    return this.params.name ? `Enter worktree "${this.params.name}"` : "Enter a new worktree";
  }
  async execute(_signal) {
    const cwd = this.config.getTargetDir();
    if (/\.qwen[\\/]worktrees[\\/]/.test(cwd)) {
      const reason = "Already inside a git worktree. Call exit_worktree first, or return to the main repository checkout before creating a new worktree.";
      debugLogger.warn(`enter_worktree: ${reason} (cwd=${cwd})`);
      return errorResult(reason);
    }
    const probe = new GitWorktreeService(cwd);
    const gitCheck = await probe.checkGitAvailable();
    if (!gitCheck.available) {
      const reason = gitCheck.error ?? "Git is not available.";
      debugLogger.warn(`enter_worktree: ${reason}`);
      return errorResult(reason);
    }
    const isRepo = await probe.isGitRepository();
    if (!isRepo) {
      const reason = `Cannot create a worktree: ${cwd} is not a git repository. Initialize the repo with \`git init\` first.`;
      debugLogger.warn(`enter_worktree: ${reason}`);
      return errorResult(reason);
    }
    const projectRoot = await probe.getRepoTopLevel() ?? cwd;
    const service = projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);
    const requested = this.params.name && this.params.name.length > 0 ? this.params.name : void 0;
    const slug = requested ?? GitWorktreeService.generateAutoSlug();
    const validation = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (validation) {
      debugLogger.warn(`enter_worktree: invalid slug ${slug}: ${validation}`);
      return errorResult(validation);
    }
    let baseBranch;
    try {
      baseBranch = await service.getCurrentBranch();
    } catch (error) {
      debugLogger.warn(
        `enter_worktree: getCurrentBranch failed at ${projectRoot}: ${error}`
      );
    }
    let originalHeadCommit = "";
    try {
      originalHeadCommit = await service.getCurrentCommitHash();
    } catch (error) {
      debugLogger.warn(
        `enter_worktree: getCurrentCommitHash failed at ${projectRoot}: ${error}`
      );
    }
    const result = await service.createUserWorktree(slug, baseBranch, {
      symlinkDirectories: this.config.getWorktreeSymlinkDirectories()
    });
    if (!result.success || !result.worktree) {
      const reason = result.error ?? "Failed to create worktree.";
      debugLogger.warn(`enter_worktree: createUserWorktree failed: ${reason}`);
      return errorResult(reason);
    }
    try {
      await writeWorktreeSessionMarker(
        result.worktree.path,
        this.config.getSessionId()
      );
    } catch (error) {
      debugLogger.warn(
        `enter_worktree: failed to write session marker at ${result.worktree.path}: ${error}`
      );
    }
    try {
      await writeWorktreeSession(
        this.config.getSessionService().getWorktreeSessionPath(this.config.getSessionId()),
        {
          slug,
          worktreePath: result.worktree.path,
          worktreeBranch: result.worktree.branch,
          originalCwd: projectRoot,
          originalBranch: baseBranch ?? "HEAD",
          originalHeadCommit
        }
      );
    } catch (error) {
      debugLogger.warn(
        `enter_worktree: failed to write WorktreeSession sidecar: ${error}`
      );
    }
    const output = {
      worktreePath: result.worktree.path,
      worktreeBranch: result.worktree.branch,
      message: `Created worktree "${slug}" at ${result.worktree.path} on branch ${result.worktree.branch}. Use this absolute path for all subsequent file operations until you call ${ToolNames.EXIT_WORKTREE}.`
    };
    debugLogger.debug(
      `Created user worktree: ${output.worktreePath} (branch=${output.worktreeBranch})`
    );
    return {
      llmContent: JSON.stringify(output),
      returnDisplay: `Worktree **${slug}** created on branch \`${result.worktree.branch}\`
\`${result.worktree.path}\``
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
var EnterWorktreeTool = class _EnterWorktreeTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _EnterWorktreeTool.Name,
      ToolDisplayNames.ENTER_WORKTREE,
      enterWorktreeDescription,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Optional slug (letters, digits, dot, underscore, hyphen; max 64 chars). Auto-generated when omitted."
          }
        },
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#"
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — only invoked when the user explicitly asks for a worktree
      false,
      // alwaysLoad
      "worktree git isolated branch new"
    );
    this.config = config;
  }
  static {
    __name(this, "EnterWorktreeTool");
  }
  static Name = ToolNames.ENTER_WORKTREE;
  validateToolParams(params) {
    if (params.name !== void 0) {
      if (typeof params.name !== "string") {
        return 'Parameter "name" must be a string.';
      }
      if (params.name.length === 0) {
        return null;
      }
      const error = GitWorktreeService.validateUserWorktreeSlug(params.name);
      if (error) return error;
    }
    return null;
  }
  createInvocation(params) {
    return new EnterWorktreeInvocation(this.config, params);
  }
};
export {
  EnterWorktreeTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
