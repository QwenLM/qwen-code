/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { FatalError } from '@qwen-code/qwen-code-core';
import type { Argv, CommandModule } from 'yargs';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../agent-view/protocol.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { MAX_AGENT_VIEW_ARGV_PROMPT_BYTES } from '../agent-view/supervisor-dispatch.js';
import { requireAgentViewEnabled } from '../agent-view/feature.js';
import type { Settings } from '../config/settingsSchema.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';
import {
  attachCommand,
  killCommand,
  logsCommand,
  respawnCommand,
  rmCommand,
  stopCommand,
} from './agent-session.js';
import { agentDaemonCommand } from './agent-daemon.js';

interface AgentsArgs {
  cwd?: string;
  json?: boolean;
  all?: boolean;
}

export async function handleAgentViewBackgroundPrompt(
  prompt: string,
  settings?: Settings,
): Promise<void> {
  requireAgentViewEnabled(settings);
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new FatalError('Cannot use --bg/--background without a prompt.', 1);
  }
  if (
    Buffer.byteLength(normalizedPrompt, 'utf8') >
    MAX_AGENT_VIEW_ARGV_PROMPT_BYTES
  ) {
    throw new FatalError(
      `Background agent prompts are limited to ${MAX_AGENT_VIEW_ARGV_PROMPT_BYTES} UTF-8 bytes.`,
      1,
    );
  }
  const supervisor = await ensureAgentViewSupervisor();
  const result = await supervisor.dispatch(normalizedPrompt, process.cwd());
  const sessionId = getSessionId(result);
  const shortId = formatSessionShortId(sessionId);
  writeStdoutLine(`Started background agent ${shortId}.`);
  writeStdoutLine(`Open with qwen agents.`);
  writeStdoutLine(`Attach with qwen agents attach ${shortId}.`);
  writeStdoutLine(`View logs with qwen agents logs ${shortId}.`);
}

function formatAgentsText(snapshots: AgentViewSessionSnapshot[]): string {
  const active = snapshots.filter(isActiveAgentSnapshot);
  if (active.length === 0) {
    return 'No background agents.';
  }
  return active
    .map((snapshot) => {
      const name = snapshot.rosterEntry?.displayName
        ? ` ${snapshot.rosterEntry.displayName}`
        : '';
      const summary = snapshot.activity?.summary
        ? ` ${snapshot.activity.summary}`
        : '';
      return `${snapshot.sessionId} ${snapshot.state.sessionState} ${snapshot.state.processState} ${snapshot.state.activeCwd}${name}${summary}`;
    })
    .join('\n');
}

export const agentsListCommand: CommandModule<unknown, AgentsArgs> = {
  command: ['$0', 'list'],
  describe: 'List background agents',
  builder: (yargs: Argv) =>
    yargs
      .option('cwd', {
        type: 'string',
        description: 'Workspace directory to inspect',
      })
      .option('json', {
        type: 'boolean',
        nargs: 0,
        default: false,
        description: 'Print machine-readable JSON',
      })
      .option('all', {
        type: 'boolean',
        nargs: 0,
        default: false,
        description: 'Include completed and stopped agents',
      })
      .check((argv) => {
        if (argv.all === true && argv.json !== true) {
          return 'qwen agents --all requires --json.';
        }
        return true;
      })
      .version(false),
  handler: async (argv) => {
    requireAgentViewEnabled();
    const listCwd = argv.cwd ? path.resolve(argv.cwd) : undefined;
    const supervisor = await ensureAgentViewSupervisor();
    if (argv.json) {
      const snapshots = toSnapshots(await supervisor.list(listCwd));
      writeStdoutLine(JSON.stringify(formatAgentsJson(snapshots, argv.all)));
      return;
    }

    const snapshots = toSnapshots(await supervisor.list(listCwd));
    writeStdoutLine(formatAgentsText(snapshots));
  },
};

export const agentsCommand: CommandModule = {
  command: 'agents',
  describe: 'Manage Agent View background agents',
  builder: (yargs: Argv) =>
    yargs
      .check((argv) =>
        argv['background'] === true || argv['continue'] === true
          ? '`qwen agents` cannot be combined with --bg/--background or --continue/-c.'
          : true,
      )
      // Hoisted from the list subcommand so the space form
      // `agents --cwd <dir>` is consumed at this level instead of failing
      // strict mode (the $0 builder only applies once yargs descends).
      .option('cwd', {
        type: 'string',
        description: 'Workspace directory to inspect',
      })
      .check((argv) => {
        const separatorTail = (argv as { '--'?: unknown })['--'];
        return Array.isArray(separatorTail) && separatorTail.length > 0
          ? '`qwen agents` does not accept arguments after `--`.'
          : true;
      })
      // Session verbs are subcommands of `qwen agents` so they cannot
      // hijack natural-language prompts at the top level.
      .command(agentsListCommand)
      .command(attachCommand)
      .command(logsCommand)
      .command(stopCommand)
      .command(killCommand)
      .command(respawnCommand)
      .command(rmCommand)
      .command(agentDaemonCommand)
      .version(false),
  handler: () => {},
};

function formatAgentsJson(
  snapshots: AgentViewSessionSnapshot[],
  includeAll = false,
): Array<Record<string, unknown>> {
  return snapshots
    .filter((snapshot) => includeAll || isActiveAgentSnapshot(snapshot))
    .map((snapshot) => {
      const attached = snapshot.state.attachState === 'attached';
      const name = snapshot.rosterEntry?.displayName;
      return {
        sessionId: snapshot.sessionId,
        ...(name ? { name } : {}),
        state: snapshot.state.sessionState,
        processState: snapshot.state.processState,
        projectCwd: snapshot.state.projectCwd,
        activeCwd: snapshot.state.activeCwd,
        attached,
        pinned: Boolean(snapshot.rosterEntry?.pinned),
        createdAt: snapshot.state.createdAt,
        updatedAt: snapshot.state.updatedAt,
        ...(snapshot.activity?.summary
          ? { summary: snapshot.activity.summary }
          : {}),
        ...(snapshot.activity?.waitingFor
          ? { waitingFor: snapshot.activity.waitingFor }
          : {}),
        ...(snapshot.activity?.queuedPromptCount
          ? { queuedPromptCount: snapshot.activity.queuedPromptCount }
          : {}),
      };
    });
}

function isActiveAgentSnapshot(snapshot: AgentViewSessionSnapshot): boolean {
  if (
    snapshot.state.sessionState === 'completed' ||
    snapshot.state.sessionState === 'stopped' ||
    snapshot.state.sessionState === 'failed'
  ) {
    return false;
  }
  return snapshot.state.processState !== 'exited';
}

function toSnapshots(value: unknown): AgentViewSessionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toSnapshot)
    .filter((snapshot): snapshot is AgentViewSessionSnapshot =>
      Boolean(snapshot),
    );
}

function toSnapshot(value: unknown): AgentViewSessionSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (isSessionState(value)) {
    return {
      sessionId: value.sessionId,
      state: value,
    };
  }
  const state = value['state'];
  if (!isSessionState(state)) return undefined;
  return {
    sessionId:
      typeof value['sessionId'] === 'string'
        ? value['sessionId']
        : state.sessionId,
    state,
    ...(isLaunch(value['launch']) ? { launch: value['launch'] } : {}),
    ...(isActivity(value['activity']) ? { activity: value['activity'] } : {}),
    ...(isWorker(value['worker']) ? { worker: value['worker'] } : {}),
    ...(isRosterEntry(value['rosterEntry'])
      ? { rosterEntry: value['rosterEntry'] }
      : {}),
  };
}

function isSessionState(value: unknown): value is AgentViewSessionStateFile {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['sessionState'] === 'string' &&
    typeof value['processState'] === 'string' &&
    typeof value['projectCwd'] === 'string' &&
    typeof value['activeCwd'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function isActivity(value: unknown): value is AgentViewActivityFile {
  return isRecord(value) && typeof value['lastActivityAt'] === 'string';
}

function isLaunch(value: unknown): value is AgentViewLaunchFile {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    Array.isArray(value['argv'])
  );
}

function isWorker(value: unknown): value is AgentViewWorkerFile {
  return isRecord(value) && typeof value['protocolVersion'] === 'number';
}

function isRosterEntry(
  value: unknown,
): value is AgentViewSessionSnapshot['rosterEntry'] {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['projectCwd'] === 'string' &&
    typeof value['activeCwd'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function getSessionId(value: unknown): string {
  if (isRecord(value) && typeof value['sessionId'] === 'string') {
    return value['sessionId'];
  }
  throw new Error('Agent dispatch did not return a session id.');
}

function formatSessionShortId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return sessionId.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
