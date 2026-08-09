/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../agent-view/protocol.js';
import type { AgentViewSupervisorClientHandle } from '../agent-view/supervisor-runner.js';
import type { Settings } from '../config/settings.js';
import type {
  AgentViewHeaderInfo,
  AgentViewPeekPanel,
} from '../ui/agent-view/AgentViewRoster.js';
import type { AgentViewRosterResult } from '../ui/agent-view/AgentViewApp.js';
import type { AgentRosterRow } from '../ui/agent-view/roster-model.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

export interface AgentsArgs {
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
  dispatchPrompt(prompt: string): Promise<unknown>;
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
  const { ensureAgentViewSupervisor } = await import(
    '../agent-view/supervisor-runner.js'
  );
  const supervisor = await ensureAgentViewSupervisor();
  const result = await supervisor.dispatch(prompt, process.cwd());
  const sessionId = getSessionId(result);
  const shortId = formatSessionShortId(sessionId);
  writeStdoutLine(`Started background agent ${shortId}.`);
  writeStdoutLine(`Open with qwen agent-view.`);
  writeStdoutLine(`Attach with qwen agent-view attach ${shortId}.`);
  writeStdoutLine(`View logs with qwen agent-view logs ${shortId}.`);
}

export async function runAgentsInteractiveSession({
  cwd,
  listCwd,
  supervisor,
  renderRoster,
  header,
}: RunAgentsInteractiveSessionOptions): Promise<void> {
  const loadRows = async () =>
    toRosterRows(toSnapshots(await supervisor.list(listCwd)));
  const actions: AgentsInteractiveActions = {
    dispatchPrompt: async (prompt) => {
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
    subscribeToChanges: (onChange) => supervisor.subscribe(onChange),
  };

  let initialPeekPanel: AgentViewPeekPanel | undefined;
  while (true) {
    const result = await renderRoster(
      await loadRows(),
      actions,
      initialPeekPanel,
      header,
    );
    initialPeekPanel = undefined;
    if (!result || result.type === 'exit') return;
    if (result.type === 'resume') {
      resetTerminalForRoster();
      initialPeekPanel = await adoptResumeSessionFromPicker(cwd, supervisor);
      resetTerminalForRoster();
      continue;
    }
    try {
      await supervisor.attach(result.sessionId);
    } catch (error) {
      initialPeekPanel = {
        title: result.sessionId,
        lines: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      resetTerminalForRoster();
    }
  }
}

export const agentsInteractiveSession = {
  run: runAgentsInteractiveSession,
};

async function defaultRenderAgentsRoster(
  rows: AgentRosterRow[],
  actions: AgentsInteractiveActions,
  initialPeekPanel?: AgentViewPeekPanel,
  header?: AgentViewHeaderInfo,
): Promise<AgentViewRosterResult> {
  const { runAgentViewRosterApp } = await import(
    '../ui/agent-view/AgentViewApp.js'
  );
  return runAgentViewRosterApp(rows, actions, header, initialPeekPanel);
}

async function toRosterRows(
  snapshots: AgentViewSessionSnapshot[],
): Promise<AgentRosterRow[]> {
  const { buildAgentRosterRows } = await import(
    '../ui/agent-view/roster-model.js'
  );
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
      .map((snapshot) => snapshot.rosterEntry)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  });
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

export async function handleAgentsCommand(argv: AgentsArgs): Promise<void> {
  const cwd = path.resolve(argv.cwd ?? process.cwd());
  const listCwd = argv.cwd ? cwd : undefined;
  const { ensureAgentViewSupervisor } = await import(
    '../agent-view/supervisor-runner.js'
  );
  const supervisor = await ensureAgentViewSupervisor();
  if (argv.json) {
    const snapshots = toSnapshots(await supervisor.list(listCwd));
    writeStdoutLine(JSON.stringify(formatAgentsJson(snapshots, argv.all)));
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const snapshots = toSnapshots(await supervisor.list(listCwd));
    writeStdoutLine(formatAgentsText(snapshots));
    return;
  }

  await agentsInteractiveSession.run({
    cwd,
    ...(listCwd ? { listCwd } : {}),
    supervisor,
    renderRoster: defaultRenderAgentsRoster,
    header: await buildAgentViewHeader(cwd),
  });
}

export const agentsCommand: CommandModule<unknown, AgentsArgs> = {
  command: 'list',
  describe: 'List background Agent View sessions',
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
          return 'qwen agent-view list --all requires --json.';
        }
        return true;
      })
      .version(false),
  handler: handleAgentsCommand,
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

async function adoptResumeSessionFromPicker(
  cwd: string,
  supervisor: Pick<AgentViewSupervisorClientHandle, 'adopt' | 'list'>,
): Promise<AgentViewPeekPanel | undefined> {
  const { showResumeSessionPickerItem } = await import(
    '../ui/components/StandaloneSessionPicker.js'
  );
  const session = await showResumeSessionPickerItem(cwd, undefined, {
    includeAgentViewSessions: false,
    allowManagedAgentViewSelection: true,
  });
  if (!session) return undefined;

  if (
    toSnapshots(await supervisor.list()).some(
      (snapshot) => snapshot.sessionId === session.sessionId,
    )
  ) {
    return {
      title: session.sessionId,
      lines: ['Session is already managed by Agent View.'],
    };
  }

  const sessionCwd = path.resolve(session.cwd || cwd);
  try {
    await supervisor.adopt({
      sessionId: session.sessionId,
      projectCwd: sessionCwd,
      activeCwd: sessionCwd,
      terminal: {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      },
    });
    return {
      title: session.sessionId,
      lines: ['Session added to Agent View.'],
    };
  } catch (error) {
    return {
      title: session.sessionId,
      lines: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function resetTerminalForRoster(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H');
}

async function buildAgentViewHeader(cwd: string): Promise<AgentViewHeaderInfo> {
  const [{ getCliVersion }, { loadSettings }] = await Promise.all([
    import('../utils/version.js'),
    import('../config/settings.js'),
  ]);
  try {
    const settings = loadSettings(cwd, {
      skipLoadEnvironment: true,
    }).merged;
    const model = settings.model?.name?.trim() || undefined;
    return {
      version: await getCliVersion(),
      cwd,
      authLabel: formatAuthLabel(settings.security?.auth?.selectedType),
      ...(model ? { model } : {}),
      ...readProviderLabel(settings.modelProviders, model),
    };
  } catch {
    const model = process.env['OPENAI_MODEL']?.trim();
    return {
      version: await getCliVersion(),
      cwd,
      authLabel: process.env['OPENAI_API_KEY'] ? 'API Key' : 'Auth',
      ...(model ? { model } : {}),
    };
  }
}

function readProviderLabel(
  modelProviders: Settings['modelProviders'],
  model: string | undefined,
): Pick<AgentViewHeaderInfo, 'providerLabel'> {
  if (!model || !modelProviders) return {};
  for (const [providerId, models] of Object.entries(modelProviders)) {
    if (
      Array.isArray(models) &&
      models.some((modelConfig) => modelConfig.id === model)
    ) {
      return { providerLabel: formatProviderLabel(providerId) };
    }
  }
  return {};
}

function formatAuthLabel(authType: string | undefined): string {
  if (process.env['OPENAI_API_KEY']) return 'API Key';
  if (!authType) return 'Auth';
  if (authType === 'qwen-oauth') return 'Qwen OAuth';
  return formatProviderLabel(authType);
}

function formatProviderLabel(providerId: string): string {
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
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
  const lines = [
    activity?.waitingFor ? `Waiting: ${activity.waitingFor}` : undefined,
    activity?.queuedPromptCount ? formatQueuedPromptLine(activity) : undefined,
    activity?.lastResult ? `Result: ${activity.lastResult}` : undefined,
    activity?.summary ? `Summary: ${activity.summary}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return {
    title: sessionId,
    lines: lines.length > 0 ? lines : ['No details available.'],
  };
}

function formatQueuedPromptLine(activity: AgentViewActivityFile): string {
  const preview = activity.queuedPromptPreview?.trim();
  return `Waiting for response${preview ? `: ${preview}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
