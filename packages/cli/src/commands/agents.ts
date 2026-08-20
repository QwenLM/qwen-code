/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import {
  readLastJsonStringFieldSync,
  Storage,
} from '@qwen-code/qwen-code-core';
import { loadSettings, type Settings } from '../config/settings.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewRosterEntry,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../agent-view/protocol.js';
import type { AgentViewSupervisorClientHandle } from '../agent-view/supervisor-runner.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { runAgentViewRosterApp } from '../ui/agent-view/AgentViewApp.js';
import type { AgentViewRosterResult } from '../ui/agent-view/AgentViewApp.js';
import type {
  AgentViewHeaderInfo,
  AgentViewPeekPanel,
} from '../ui/agent-view/AgentViewRoster.js';
import { showResumeSessionPickerItem } from '../ui/components/StandaloneSessionPicker.js';
import type { AgentRosterRow } from '../ui/agent-view/roster-model.js';
import { buildAgentRosterRows } from '../ui/agent-view/roster-model.js';
import { getAuthTypeFromEnv } from '../utils/modelConfigUtils.js';
import {
  cleanSingleLineText,
  stripUnsafeCharacters,
} from '../ui/utils/textUtils.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { getCliVersion } from '../utils/version.js';
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

type AgentsInteractiveSupervisor = Pick<
  AgentViewSupervisorClientHandle,
  | 'list'
  | 'subscribe'
  | 'dispatch'
  | 'adopt'
  | 'attach'
  | 'peek'
  | 'send'
  | 'answer'
  | 'pin'
  | 'rename'
  | 'stop'
  | 'remove'
>;

export interface AgentsInteractiveActions {
  dispatchPrompt(prompt: string, attach: boolean): Promise<unknown>;
  peekSelected(sessionId: string): Promise<AgentViewPeekPanel>;
  sendToSession(sessionId: string, text: string): Promise<unknown>;
  answerSession(sessionId: string, text: string): Promise<unknown>;
  pinSession(sessionId: string): Promise<unknown>;
  renameSession(sessionId: string, displayName: string): Promise<unknown>;
  stopSession(sessionId: string): Promise<unknown>;
  removeSession(sessionId: string): Promise<unknown>;
  loadRows(): Promise<AgentRosterRow[]>;
  subscribeToChanges?(onChange: () => void): { dispose(): void };
}

export interface RunAgentsInteractiveSessionOptions {
  cwd: string;
  listCwd?: string;
  supervisor: AgentsInteractiveSupervisor;
  renderRoster(
    rows: AgentRosterRow[],
    actions: AgentsInteractiveActions,
    initialPeekPanel?: AgentViewPeekPanel,
    header?: AgentViewHeaderInfo,
  ): Promise<AgentViewRosterResult | void> | AgentViewRosterResult | void;
  header?: AgentViewHeaderInfo;
}

export async function handleAgentViewBackgroundPrompt(
  prompt: string,
): Promise<void> {
  const supervisor = await ensureAgentViewSupervisor();
  const result = await supervisor.dispatch(prompt, process.cwd());
  const sessionId = getSessionId(result);
  const shortId = formatSessionShortId(sessionId);
  writeStdoutLine(`Started background agent ${shortId}.`);
  writeStdoutLine(`Open with qwen agents.`);
  writeStdoutLine(`Attach with qwen agents attach ${shortId}.`);
  writeStdoutLine(`View logs with qwen agents logs ${shortId}.`);
}

export async function runAgentsInteractiveSession({
  cwd,
  listCwd,
  supervisor,
  renderRoster,
  header,
}: RunAgentsInteractiveSessionOptions): Promise<void> {
  // Cache only discovered transcript titles; a new session may be titled
  // after its first roster poll.
  const titleCache = new Map<string, string>();
  const loadRows = async () =>
    toRosterRows(toSnapshots(await supervisor.list(listCwd)), titleCache);
  const actions: AgentsInteractiveActions = {
    dispatchPrompt: async (prompt, _attach) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) {
        throw new Error('Prompt cannot be empty.');
      }

      return supervisor.dispatch(trimmedPrompt, cwd);
    },
    peekSelected: async (sessionId) =>
      formatPeekPanel(await supervisor.peek(sessionId)),
    sendToSession: (sessionId, text) => supervisor.send(sessionId, text),
    answerSession: (sessionId, text) => supervisor.answer(sessionId, text),
    pinSession: (sessionId) => supervisor.pin(sessionId),
    renameSession: (sessionId, displayName) =>
      supervisor.rename(sessionId, displayName),
    stopSession: (sessionId) => supervisor.stop(sessionId),
    removeSession: (sessionId) => supervisor.remove(sessionId),
    loadRows,
    subscribeToChanges: (onChange) =>
      supervisor.subscribe(() => {
        titleCache.clear();
        onChange();
      }),
  };

  let initialPeekPanel: AgentViewPeekPanel | undefined;
  const foregroundSubscription = supervisor.subscribe(() => {});
  try {
    while (true) {
      let rows: AgentRosterRow[] = [];
      try {
        rows = await loadRows();
      } catch (error) {
        initialPeekPanel = {
          title: 'Agent View',
          lines: [error instanceof Error ? error.message : String(error)],
          error: true,
        };
      }
      const result = await renderRoster(
        rows,
        actions,
        initialPeekPanel,
        header,
      );
      initialPeekPanel = undefined;
      if (!result || result.type === 'exit') {
        return;
      }
      if (result.type === 'resume') {
        resetTerminalForRoster();
        await waitForTerminalHandoff();
        try {
          initialPeekPanel = await adoptResumeSessionFromPicker(
            cwd,
            supervisor,
          );
        } catch (error) {
          initialPeekPanel = {
            title: 'Resume',
            lines: [error instanceof Error ? error.message : String(error)],
            error: true,
          };
        }
        resetTerminalForRoster();
        await waitForTerminalHandoff();
        continue;
      }
      if (result.type === 'attach') {
        try {
          await supervisor.attach(result.sessionId);
        } catch (error) {
          initialPeekPanel = {
            title: result.sessionId,
            lines: [error instanceof Error ? error.message : String(error)],
            error: true,
          };
        } finally {
          resetTerminalForRoster();
        }
      }
    }
  } finally {
    foregroundSubscription.dispose();
  }
}

async function adoptResumeSessionFromPicker(
  cwd: string,
  supervisor: Pick<AgentViewSupervisorClientHandle, 'adopt' | 'peek'>,
): Promise<AgentViewPeekPanel | undefined> {
  const session = await showResumeSessionPickerItem(cwd, undefined, {
    includeAgentViewSessions: false,
    allowManagedAgentViewSelection: true,
  });
  if (!session) {
    return undefined;
  }
  const { sessionId } = session;
  const sessionCwd = path.resolve(session.cwd || cwd);

  try {
    await supervisor.peek(sessionId);
    return {
      title: sessionId,
      lines: ['Session is already managed by Agent View.'],
      preferLines: true,
    };
  } catch {
    // Not currently managed; adopt it below.
  }

  try {
    await supervisor.adopt({
      sessionId,
      projectCwd: sessionCwd,
      activeCwd: sessionCwd,
      terminal: {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      },
    });
    return {
      title: sessionId,
      lines: ['Session added to Agent View.'],
      preferLines: true,
    };
  } catch (error) {
    return {
      title: sessionId,
      lines: [error instanceof Error ? error.message : String(error)],
      error: true,
    };
  }
}

function resetTerminalForRoster(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H');
}

// One macrotask tick is enough: resetTerminalForRoster writes synchronously
// to stdout, and a single setImmediate lets ink flush its final unmount output
// before the next TUI (session picker) takes over the terminal.
async function waitForTerminalHandoff(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export const agentsInteractiveSession = {
  run: runAgentsInteractiveSession,
};

async function defaultRenderAgentsRoster(
  rows: AgentRosterRow[],
  actions: AgentsInteractiveActions,
  initialPeekPanel?: AgentViewPeekPanel,
  header?: AgentViewHeaderInfo,
): Promise<AgentViewRosterResult | void> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return runAgentViewRosterApp(rows, actions, header, initialPeekPanel);
  }
  writeStdoutLine(formatRosterRowsText(rows));
}

function toRosterRows(
  snapshots: AgentViewSessionSnapshot[],
  titleCache: Map<string, string>,
): AgentRosterRow[] {
  if (snapshots.length === 0) {
    return [];
  }
  return buildAgentRosterRows({
    sessions: snapshots.map((snapshot) => snapshot.state),
    launches: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.sessionId, snapshot.launch]),
    ),
    activities: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.sessionId, snapshot.activity]),
    ),
    workers: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.sessionId, snapshot.worker]),
    ),
    rosterEntries: snapshots
      .map((snapshot) => getRosterEntryWithTitle(snapshot, titleCache))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  });
}

function getRosterEntryWithTitle(
  snapshot: AgentViewSessionSnapshot,
  titleCache: Map<string, string>,
): AgentViewRosterEntry | undefined {
  if (snapshot.rosterEntry?.displayName) {
    return snapshot.rosterEntry;
  }
  let title = titleCache.get(snapshot.sessionId);
  if (title === undefined) {
    title = readTranscriptTitle(snapshot);
    if (title) {
      titleCache.set(snapshot.sessionId, title);
    }
  }
  if (!title) {
    return snapshot.rosterEntry;
  }
  return {
    sessionId: snapshot.sessionId,
    projectCwd: snapshot.rosterEntry?.projectCwd ?? snapshot.state.projectCwd,
    activeCwd: snapshot.rosterEntry?.activeCwd ?? snapshot.state.activeCwd,
    ...(snapshot.rosterEntry?.pinned ? { pinned: true } : {}),
    displayName: title,
    createdAt: snapshot.rosterEntry?.createdAt ?? snapshot.state.createdAt,
    updatedAt: snapshot.rosterEntry?.updatedAt ?? snapshot.state.updatedAt,
  };
}

function readTranscriptTitle(
  snapshot: AgentViewSessionSnapshot,
): string | undefined {
  const cwdCandidates = Array.from(
    new Set([snapshot.state.activeCwd, snapshot.state.projectCwd]),
  );
  for (const cwd of cwdCandidates) {
    try {
      const filePath = path.join(
        new Storage(cwd).getProjectDir(),
        'chats',
        `${snapshot.sessionId}.jsonl`,
      );
      const title = readLastJsonStringFieldSync(
        filePath,
        'customTitle',
        // Strict marker: a loose 'custom_title' substring would also match
        // tool/assistant records that merely mention the marker.
        '"subtype":"custom_title"',
      )?.trim();
      if (title) return title;
    } catch {
      // Missing transcripts are fine; new sessions may not have a title yet.
    }
  }
  return undefined;
}

function formatRosterRowsText(rows: AgentRosterRow[]): string {
  if (rows.length === 0) {
    return 'No background agents.';
  }
  return rows
    .map((row) => {
      // Non-TTY output has no ink sanitize-ansi protection, so untrusted
      // session text must be stripped here.
      const cleanSummary = cleanSingleLineText(row.summary ?? '');
      const summary = cleanSummary ? ` ${cleanSummary}` : '';
      return `${row.sessionId} ${row.stateLabel} ${row.aliveIndicator} ${cleanSingleLineText(row.cwd)} ${row.ageLabel}${summary}`;
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
        default: false,
        description: 'Print machine-readable JSON',
      })
      .option('all', {
        type: 'boolean',
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
    const cwd = path.resolve(argv.cwd ?? process.cwd());
    const listCwd = argv.cwd ? path.resolve(argv.cwd) : undefined;
    const supervisor = await ensureAgentViewSupervisor();
    if (argv.json) {
      const snapshots = toSnapshots(await supervisor.list(listCwd));
      writeStdoutLine(JSON.stringify(formatAgentsJson(snapshots, argv.all)));
      return;
    }

    await agentsInteractiveSession.run({
      cwd,
      ...(listCwd ? { listCwd } : {}),
      supervisor,
      renderRoster: defaultRenderAgentsRoster,
      header: await buildAgentViewHeader(cwd),
    });
  },
};

async function buildAgentViewHeader(cwd: string): Promise<AgentViewHeaderInfo> {
  return {
    version: await getCliVersion(),
    cwd,
    ...readConfiguredModelHeader(cwd),
  };
}

function readConfiguredModelHeader(
  cwd: string,
): Pick<AgentViewHeaderInfo, 'authLabel' | 'model' | 'providerLabel'> {
  try {
    const settings = loadSettings(cwd, {
      skipLoadEnvironment: true,
    }).merged;
    const model =
      readConfiguredModelFromSettings(settings) ||
      process.env['OPENAI_MODEL']?.trim() ||
      process.env['QWEN_MODEL']?.trim() ||
      undefined;
    return {
      authLabel: formatAuthLabel(
        settings.security?.auth?.selectedType || getAuthTypeFromEnv(),
      ),
      ...(model ? { model } : {}),
      ...readProviderLabel(settings.modelProviders, model),
    };
  } catch {
    const model =
      process.env['OPENAI_MODEL']?.trim() || process.env['QWEN_MODEL']?.trim();
    return {
      authLabel: process.env['OPENAI_API_KEY'] ? 'API Key' : 'Auth',
      ...(model ? { model } : {}),
    };
  }
}

function readProviderLabel(
  modelProviders: Settings['modelProviders'],
  model: string | undefined,
): Pick<AgentViewHeaderInfo, 'providerLabel'> {
  if (!model || !modelProviders) {
    return {};
  }
  for (const [providerId, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models)) continue;
    if (models.some((modelConfig) => modelConfig.id === model)) {
      return { providerLabel: formatProviderLabel(providerId) };
    }
  }
  return {};
}

function readConfiguredModelFromSettings(
  settings: Settings,
): string | undefined {
  return settings.model?.name?.trim() || undefined;
}

function formatAuthLabel(authType: string | undefined): string {
  if (!authType) return 'Auth';
  if (authType === 'qwen-oauth') return 'Qwen OAuth';
  if (authType === 'openai') return 'API Key';
  return formatProviderLabel(authType);
}

function formatProviderLabel(providerId: string): string {
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

export const agentsCommand: CommandModule = {
  command: 'agents',
  describe: 'Manage Agent View background agents',
  builder: (yargs: Argv) =>
    yargs
      .check(() => {
        const assignedBoolean = process.argv
          .slice(2)
          .find((token) => /^--(?:json|all)=/.test(token));
        if (assignedBoolean) {
          writeStderrLine(
            `${assignedBoolean.split('=')[0]} is a boolean flag and does not accept an assigned value.`,
          );
          process.exit(1);
        }
        return true;
      })
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

function formatPeekPanel(value: unknown): AgentViewPeekPanel {
  if (!isRecord(value)) {
    return { title: 'Agent', lines: ['No details available.'] };
  }

  const sessionId =
    typeof value['sessionId'] === 'string' ? value['sessionId'] : 'Agent';
  const activity = isActivity(value['activity'])
    ? value['activity']
    : undefined;
  // Activity fields carry untrusted worker/model output; strip unsafe
  // control sequences before they reach the operator's terminal.
  const lines = [
    activity?.waitingFor
      ? `Waiting: ${stripUnsafeCharacters(activity.waitingFor)}`
      : undefined,
    activity?.queuedPromptCount ? formatQueuedPromptLine(activity) : undefined,
    activity?.lastResult
      ? `Result: ${stripUnsafeCharacters(activity.lastResult)}`
      : undefined,
    activity?.summary
      ? `Summary: ${stripUnsafeCharacters(activity.summary)}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    title: sessionId,
    lines: lines.length > 0 ? lines : ['No details available.'],
  };
}

function formatQueuedPromptLine(activity: AgentViewActivityFile): string {
  const preview = activity.queuedPromptPreview?.trim();
  const suffix = preview ? `: ${stripUnsafeCharacters(preview)}` : '';
  return `Waiting for response${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
