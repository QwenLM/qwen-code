// Force strict mode and setup for ESM
"use strict";
import {
  disposeInboxLocks,
  unregisterLeader
} from "./chunk-4YS7RMCB.js";
import {
  deleteTeamDirs
} from "./chunk-YVYK3JYU.js";
import "./chunk-MLXTMF7H.js";
import {
  isTeammate
} from "./chunk-S6LOFUVP.js";
import "./chunk-VGC4I5JJ.js";
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

// packages/core/src/tools/team-delete.ts
init_esbuild_shims();
var debug = createDebugLogger("TEAM_DELETE");
var TeamDeleteInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TeamDeleteInvocation");
  }
  getDescription() {
    return "Delete current team";
  }
  async execute() {
    if (isTeammate()) {
      const msg2 = "Only the team leader can delete the team.";
      return {
        llmContent: msg2,
        returnDisplay: msg2,
        error: { message: msg2 }
      };
    }
    const manager = this.config.getTeamManager();
    if (!manager) {
      const msg2 = "No active team to delete.";
      return {
        llmContent: msg2,
        returnDisplay: msg2,
        error: { message: msg2 }
      };
    }
    const teamFile = manager.getTeamFile();
    const teamName = teamFile.name;
    try {
      await manager.cleanup();
    } catch (err) {
      debug.warn("Team cleanup failed; resetting team state anyway:", err);
    }
    let fsCleanupError;
    try {
      await deleteTeamDirs(teamName);
    } catch (err) {
      debug.warn("First cleanup sweep failed; retrying after delay:", err);
    }
    await new Promise((r) => setTimeout(r, 250));
    try {
      await deleteTeamDirs(teamName);
    } catch (err) {
      fsCleanupError = err;
      debug.warn(
        "Filesystem cleanup failed; resetting team state anyway:",
        err
      );
    }
    disposeInboxLocks(teamName);
    this.config.setTeamManager(null);
    this.config.setTeamContext(null);
    unregisterLeader();
    if (fsCleanupError) {
      const detail = fsCleanupError instanceof Error ? fsCleanupError.message : String(fsCleanupError);
      const msg2 = `Team "${teamName}" was torn down, but filesystem cleanup failed: ${detail}. Team directories may remain on disk.`;
      return { llmContent: msg2, returnDisplay: msg2, error: { message: msg2 } };
    }
    const display = {
      type: "team_result",
      teamName,
      action: "deleted"
    };
    const msg = `Team "${teamName}" deleted.`;
    return { llmContent: msg, returnDisplay: display };
  }
};
var TeamDeleteTool = class _TeamDeleteTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TeamDeleteTool.Name,
      ToolDisplayNames.TEAM_DELETE,
      "Delete the current team. Stops all teammates, cleans up team files, tasks, and inboxes. Only the team leader can use this.",
      "delete" /* Delete */,
      {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TeamDeleteTool");
  }
  static Name = ToolNames.TEAM_DELETE;
  createInvocation(params) {
    return new TeamDeleteInvocation(this.config, params);
  }
};
export {
  TeamDeleteTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
