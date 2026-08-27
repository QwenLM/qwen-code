/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * team_delete tool — deletes the current team and cleans up.
 */

import type { ToolInvocation, ToolResult, TeamResultDisplay } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { deleteTeamDirs } from '../agents/team/teamHelpers.js';
import { disposeInboxLocks } from '../agents/team/mailbox.js';
import { unregisterLeader } from '../agents/team/leaderPermissionBridge.js';
import { isTeammate } from '../agents/team/identity.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debug = createDebugLogger('TEAM_DELETE');

export type TeamDeleteParams = Record<string, never>;

class TeamDeleteInvocation extends BaseToolInvocation<
  TeamDeleteParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: TeamDeleteParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Delete current team';
  }

  async execute(): Promise<ToolResult> {
    if (isTeammate()) {
      const msg = 'Only the team leader can delete the team.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const manager = this.config.getTeamManager();
    if (!manager) {
      const msg = 'No active team to delete.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const teamFile = manager.getTeamFile();
    const teamName = teamFile.name;

    // Clean up: stop all agents, remove files. If cleanup throws (e.g. a
    // backend times out waiting for an agent to settle), swallow it and
    // still tear down the on-disk artifacts and reset Config state below —
    // otherwise the session is left permanently in a "team active" state
    // that blocks every future team_create with no recovery short of a
    // restart.
    try {
      await manager.cleanup();
    } catch (err) {
      debug.warn('Team cleanup failed; resetting team state anyway:', err);
    }

    // Clean up file system artifacts.
    // deleteTeamDirs removes both the team dir (containing inboxes)
    // and the tasks dir, so no separate clearAllInboxes/resetTaskList needed.
    //
    // Belt-and-suspenders: a teammate's tool call that didn't
    // settle inside `manager.cleanup()`'s wait window can still
    // call `writeMessage`, which `mkdir(recursive)`s the inboxes
    // directory and recreates `~/.qwen/teams/{name}/...` *after*
    // we delete it — leaving an orphan dir that wedges the team
    // name on the next `team_create`. Sweep once more after a
    // short delay to catch the race.
    //
    // Filesystem errors (EACCES, EIO, etc.) must NOT prevent the
    // state-reset tail below — otherwise the session is left
    // permanently in a "team active" state with no recovery. Each
    // sweep is wrapped separately so a first-sweep failure cannot
    // skip the delayed second sweep (the race-catcher above). A
    // failure is surfaced only if the FINAL sweep still fails: if
    // the retry succeeds the directories are gone and deletion
    // genuinely completed.
    let fsCleanupError: unknown;
    try {
      await deleteTeamDirs(teamName);
    } catch (err) {
      debug.warn('First cleanup sweep failed; retrying after delay:', err);
    }
    await new Promise((r) => setTimeout(r, 250));
    try {
      await deleteTeamDirs(teamName);
    } catch (err) {
      fsCleanupError = err;
      debug.warn(
        'Filesystem cleanup failed; resetting team state anyway:',
        err,
      );
    }

    // Drop this team's in-process inbox locks now that its inboxes are
    // gone, so the lock map doesn't retain a dead Mutex per inbox for
    // the process lifetime. After the final dir sweep so a late
    // writeMessage can't immediately re-create an entry.
    disposeInboxLocks(teamName);

    this.config.setTeamManager(null);
    this.config.setTeamContext(null);
    unregisterLeader();

    if (fsCleanupError) {
      // State was reset so the session is not wedged, but the cleanup
      // failure must NOT be converted into a complete-success claim —
      // directories may remain on disk (issue #10210).
      const detail =
        fsCleanupError instanceof Error
          ? fsCleanupError.message
          : String(fsCleanupError);
      const msg =
        `Team "${teamName}" was torn down, but filesystem cleanup ` +
        `failed: ${detail}. Team directories may remain on disk.`;
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const display: TeamResultDisplay = {
      type: 'team_result',
      teamName,
      action: 'deleted',
    };
    const msg = `Team "${teamName}" deleted.`;
    return { llmContent: msg, returnDisplay: display };
  }
}

export class TeamDeleteTool extends BaseDeclarativeTool<
  TeamDeleteParams,
  ToolResult
> {
  static readonly Name = ToolNames.TEAM_DELETE;

  constructor(private config: Config) {
    super(
      TeamDeleteTool.Name,
      ToolDisplayNames.TEAM_DELETE,
      'Delete the current team. Stops all teammates, ' +
        'cleans up team files, tasks, and inboxes. ' +
        'Only the team leader can use this.',
      Kind.Delete,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TeamDeleteParams,
  ): ToolInvocation<TeamDeleteParams, ToolResult> {
    return new TeamDeleteInvocation(this.config, params);
  }
}
