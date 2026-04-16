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
import { clearPermissions } from '../agents/team/permissionSync.js';
import { unregisterLeader } from '../agents/team/leaderPermissionBridge.js';
import { isTeammate } from '../agents/team/identity.js';

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

    // Clean up: stop all agents, remove files.
    await manager.cleanup();

    // Clean up file system artifacts.
    // deleteTeamDirs removes both the team dir (containing inboxes)
    // and the tasks dir, so no separate clearAllInboxes/resetTaskList needed.
    await Promise.allSettled([
      deleteTeamDirs(teamName),
      clearPermissions(teamName),
    ]);

    this.config.setTeamManager(null);
    this.config.setTeamContext(null);
    unregisterLeader();

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
