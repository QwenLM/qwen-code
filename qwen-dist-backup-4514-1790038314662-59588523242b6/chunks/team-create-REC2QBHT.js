// Force strict mode and setup for ESM
"use strict";
import {
  InProcessBackend,
  TeamManager
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import {
  clearAllInboxes
} from "./chunk-4YS7RMCB.js";
import {
  resetTaskList
} from "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import {
  LEADER_NAME,
  MAX_TEAMMATES,
  createTeamFile,
  formatAgentId,
  getTasksDir,
  getTeamDir,
  sanitizeName,
  tryReclaimStaleTeam
} from "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/team-create.ts
init_esbuild_shims();
var TeamCreateInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TeamCreateInvocation");
  }
  getDescription() {
    return `Create team "${this.params.team_name}"`;
  }
  async execute() {
    const teamName = sanitizeName(this.params.team_name);
    if (!teamName) {
      const msg = "Team name is required.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (this.config.getArenaManager()) {
      const msg = "Cannot create a team while an Arena session is active. End the Arena session first.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (this.config.getTeamManager()) {
      const msg = "A team is already active. Delete it before creating a new one.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const leadAgentId = formatAgentId(LEADER_NAME, teamName);
    const teamFile = {
      name: teamName,
      description: this.params.description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: this.config.getSessionId(),
      leadPid: process.pid,
      members: []
    };
    try {
      await createTeamFile(teamName, teamFile);
    } catch (err) {
      if (isNodeError(err) && err.code === "EEXIST") {
        const reclaimed = await tryReclaimStaleTeam(teamName);
        if (!reclaimed) {
          const msg = `Team "${teamName}" already exists and appears to be owned by a live qwen-code session. Pick a different name, or \u2014 if you're sure no other session is using it \u2014 remove the on-disk artifacts manually:
  rm -rf "${getTeamDir(teamName)}" "${getTasksDir(teamName)}"`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg }
          };
        }
        await createTeamFile(teamName, teamFile);
      } else {
        throw err;
      }
    }
    await resetTaskList(teamName);
    await clearAllInboxes(teamName);
    const backend = new InProcessBackend(this.config);
    await backend.init();
    const manager = new TeamManager(
      backend,
      teamFile,
      this.config.getSubagentManager(),
      {
        maxTeammates: this.config.getAgentsSettings().team?.maxTeammates
      }
    );
    this.config.setTeamManager(manager);
    const ctx = {
      teamName,
      leadAgentId,
      teammates: {}
    };
    this.config.setTeamContext(ctx);
    const display = {
      type: "team_result",
      teamName,
      action: "created"
    };
    const llmContent = `Team "${teamName}" created.` + (this.params.description ? ` Description: ${this.params.description}` : "");
    return { llmContent, returnDisplay: display };
  }
};
var TeamCreateTool = class _TeamCreateTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TeamCreateTool.Name,
      ToolDisplayNames.TEAM_CREATE,
      `# TeamCreate

## When to Use

Use this tool proactively whenever:
- The user explicitly asks to use a team, swarm, or group of agents
- The user mentions wanting agents to work together, coordinate, or collaborate
- A task is complex enough that it would benefit from parallel work by multiple agents (e.g., building a full-stack feature with frontend and backend work, refactoring a codebase while keeping tests passing, implementing a multi-step project with research, planning, and coding phases)

When in doubt about whether a task warrants a team, prefer spawning a team.

## Choosing Agent Types for Teammates

When spawning teammates via the Agent tool, choose the \`subagent_type\` based on what tools the agent needs for its task. Each agent type has a different set of available tools \u2014 match the agent to the work:

- **Enforced read-only teammates** use the Agent tool's read_only option. This replaces the selected agent's tool surface with inspection and team-coordination tools, so shell and file writes are unavailable. Use them for research, search, review, or planning tasks.
- **Full-capability agents** (e.g., general-purpose) have access to all tools including file editing, writing, and bash. Use these for tasks that require making changes.
- **Custom agents** defined in \`.qwen/agents/\` may have their own tool restrictions. Check their descriptions to understand what they can and cannot do.

Always review the agent type descriptions and their available tools listed in the Agent tool prompt before selecting a \`subagent_type\` for a teammate.

Create a new team to coordinate multiple agents working on a project. Teams have a 1:1 correspondence with task lists (Team = TaskList).

\`\`\`
{
  "team_name": "my-project",
  "description": "Working on feature X"
}
\`\`\`

This creates:
- A team file at \`~/.qwen/teams/{team-name}/config.json\`
- A corresponding task list directory at \`~/.qwen/tasks/{team-name}/\`

## Team Workflow

1. **Create a team** with TeamCreate - this creates both the team and its task list
2. **Create tasks** using the Task tools (TaskCreate, TaskList, etc.) - they automatically use the team's task list
3. **Spawn teammates** using the Agent tool with explicit \`name\` and \`subagent_type\` parameters to create teammates that join the active team (max ${config.getAgentsSettings().team?.maxTeammates ?? MAX_TEAMMATES} teammates per team). Set \`read_only: true\` for investigation workers; pin a single writer to a leader-owned worktree with \`working_dir\` when code changes are required, then shut it down before removing that worktree.
4. **Assign tasks** using TaskUpdate with \`owner\` to give tasks to idle teammates
5. **Teammates work on assigned tasks** and mark them completed via TaskUpdate
6. **Teammates go idle between turns** - after each turn, teammates automatically go idle and send a notification. IMPORTANT: Be patient with idle teammates! Don't comment on their idleness until it actually impacts your work.
7. **Shutdown your team** - when the task is completed, gracefully shut down each teammate with ${ToolNames.REQUEST_SHUTDOWN} (\`to\`: the teammate name). ${ToolNames.SEND_MESSAGE} carries ordinary text only.

## Task Ownership

Tasks are assigned using TaskUpdate with the \`owner\` parameter. Any agent can set or change task ownership via TaskUpdate.

## Automatic Message Delivery

**IMPORTANT**: Messages from teammates are automatically delivered to you. You do NOT need to manually check your inbox.

When you spawn teammates:
- They will send you messages when they complete tasks or need help
- These messages appear automatically as new conversation turns (like user messages)
- If you're busy (mid-turn), messages are queued and delivered when your turn ends
- The UI shows a brief notification with the sender's name when messages are waiting

Messages will be delivered automatically.

When reporting on teammate messages, you do NOT need to quote the original message\u2014it's already rendered to the user.

## Teammate Idle State

Teammates go idle after every turn\u2014this is completely normal and expected. A teammate going idle immediately after sending you a message does NOT mean they are done or unavailable. Idle simply means they are waiting for input.

- **Idle teammates can receive messages.** Sending a message to an idle teammate wakes them up and they will process it normally.
- **Idle notifications are automatic.** The system sends an idle notification whenever a teammate's turn ends. You do not need to react to idle notifications unless you want to assign new work or send a follow-up message.
- **Do not treat idle as an error.** A teammate sending a message and then going idle is the normal flow\u2014they sent their message and are now waiting for a response. When a teammate's turn ends, the runtime forwards that teammate's final text output of the turn to you automatically; if they also called send_message earlier, that earlier report is delivered too. There is no summary of teammate-to-teammate messages; ask the teammate directly when you need peer-collaboration detail.

## Discovering Team Members

Teammates can read the team config file to discover other team members:
- **Team config location**: \`~/.qwen/teams/{team-name}/config.json\`

The config file contains a \`members\` array with each teammate's:
- \`name\`: Human-readable name (**always use this** for messaging and task assignment)
- \`agentId\`: Unique identifier (for reference only - do not use for communication)
- \`agentType\`: Role/type of the agent

**IMPORTANT**: Always refer to teammates by their NAME (e.g., "team-lead", "researcher", "tester"). Names are used for:
- \`to\` when sending messages
- Identifying task owners

Example of reading team config:
\`\`\`
Use the Read tool to read ~/.qwen/teams/{team-name}/config.json
\`\`\`

## Task List Coordination

Teams share a task list that all teammates can access at \`~/.qwen/tasks/{team-name}/\`.

Teammates should:
1. Check TaskList periodically, **especially after completing each task**, to find available work or see newly unblocked tasks
2. Claim unassigned, unblocked tasks with TaskUpdate (set \`owner\` to your name). **Prefer tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones
3. Create new tasks with \`TaskCreate\` when identifying additional work
4. Mark tasks as completed with \`TaskUpdate\` when done, then check TaskList for next work
5. Coordinate with other teammates by reading the task list status
6. If all available tasks are blocked, notify the team lead or help resolve blocking tasks

**IMPORTANT notes for communication with your team**:
- Do not use terminal tools to view your team's activity; always send a message to your teammates (and remember, refer to them by name).
- Your team cannot hear you if you do not use the SendMessage tool. Always send a message to your teammates if you are responding to them.
- Do NOT send structured JSON status messages like \`{"type":"idle",...}\` or \`{"type":"task_completed",...}\`. Just communicate in plain text when you need to message teammates.
- Use TaskUpdate to mark tasks completed.
- If you are an agent in the team, the system will automatically send idle notifications to the team lead when you stop.`,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          team_name: {
            type: "string",
            description: "Name for the team (alphanumeric and hyphens)."
          },
          description: {
            type: "string",
            description: "Optional description of the team."
          }
        },
        required: ["team_name"],
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TeamCreateTool");
  }
  static Name = ToolNames.TEAM_CREATE;
  createInvocation(params) {
    return new TeamCreateInvocation(this.config, params);
  }
};
export {
  TeamCreateTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
