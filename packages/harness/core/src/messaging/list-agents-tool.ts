/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ListAgents` — discovery for `SendMessage`.
 *
 * Lists in-process agents and reachable peer sessions in one place, because
 * both are addressed the same way: by the name shown in the listing.
 */

import type { Config } from '../config/config.js';
import { BRAND_NAME } from '../config/brand.js';
import { defineDeclarativeTool } from '../tools/define-tool.js';
import {
  LIST_AGENTS_DISPLAY_NAME,
  LIST_AGENTS_TOOL_NAME,
} from '../tools/tool-names.js';
import { Kind, type ToolResult } from '../tools/tools.js';
import { DEFAULT_DEFERRED_HINTS } from '../codemode/types.js';
import { IN_PROCESS_TEAMMATE_TASK_TYPE } from '../agents/teams/agent-teams-feature.js';
import { formatPeersForModel, listAllPeers } from './peer-listing.js';

/** Truncation budget for the rendered listing. */
const LIST_AGENTS_MAX_CHARS = 10_000;

function buildListAgentsDescription(): string {
  return `
List the agents you can reach with ${'SendMessage'}.

Returns two groups: agents running inside this session (teammates and background
subagents, addressed by name) and peer sessions — other ${BRAND_NAME} sessions running
on this machine for the same user.

Address a peer by the label shown in its row, or by its handle alone — the
\`-46\` suffix a row carries in its name or states as \`handle -46\`. A label
changes when the session retitles itself; its handle does not. A peer can exit
at any time, so re-run this tool if a send reports that the session is gone.

Call it only when your user asks about other sessions or wants to reach one, or
when a send to a peer reports that it is gone or ambiguous. Do not call it on
your own initiative to look for sessions to message.
`.trim();
}

interface ListAgentsParams {
  [key: string]: never;
}

/** Names of in-process agents that `SendMessage` can reach directly. */
function collectLocalAgentNames(config: Config): string[] {
  const tasks = config.taskRegistry?.all() ?? [];
  const names = new Set<string>();
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    if (
      task.type !== 'local_agent' &&
      task.type !== IN_PROCESS_TEAMMATE_TASK_TYPE
    ) {
      continue;
    }
    const named = task as { agentName?: string; agentId?: string };
    const name = named.agentName ?? named.agentId;
    if (name) names.add(name);
  }
  return [...names].sort();
}

export const ListAgentsTool = defineDeclarativeTool<
  ListAgentsParams,
  ToolResult,
  Config
>({
  name: LIST_AGENTS_TOOL_NAME,
  displayName: LIST_AGENTS_DISPLAY_NAME,
  get description(): string {
    return buildListAgentsDescription();
  },
  kind: Kind.Other,
  exposureHints: DEFAULT_DEFERRED_HINTS,
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  isConcurrencySafe: () => true,
  maxResultSizeChars: LIST_AGENTS_MAX_CHARS,
  getDescription: () => 'List reachable agents',
  execute: async (_params, _toolContext, config): Promise<ToolResult> => {
    const peers = await listAllPeers();
    const listing = formatPeersForModel(peers, {
      localAgents: collectLocalAgentNames(config),
    });
    return {
      llmContent: listing,
      returnDisplay: listing,
      toolUseResult: { listing, peerCount: peers.length },
    };
  },
});
