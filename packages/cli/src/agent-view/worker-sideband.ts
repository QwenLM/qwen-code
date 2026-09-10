/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { callAgentViewSupervisor } from './supervisor-client.js';
import type {
  AgentViewInputKind,
  AgentViewWorkerControlEvent,
  AgentViewSessionState,
  AgentViewWorkerEvent,
} from './protocol.js';

export const QWEN_AGENT_VIEW_WORKER = 'QWEN_AGENT_VIEW_WORKER';
export const QWEN_AGENT_VIEW_SESSION_ID = 'QWEN_AGENT_VIEW_SESSION_ID';
export const QWEN_AGENT_VIEW_SIDEBAND = 'QWEN_AGENT_VIEW_SIDEBAND';
export const QWEN_AGENT_VIEW_TOKEN = 'QWEN_AGENT_VIEW_TOKEN';
export const QWEN_AGENT_VIEW_ACTIVE_CWD = 'QWEN_AGENT_VIEW_ACTIVE_CWD';

export const AGENT_VIEW_WORKER_ENV_KEYS = [
  QWEN_AGENT_VIEW_WORKER,
  QWEN_AGENT_VIEW_SESSION_ID,
  QWEN_AGENT_VIEW_SIDEBAND,
  QWEN_AGENT_VIEW_TOKEN,
  QWEN_AGENT_VIEW_ACTIVE_CWD,
] as const;

export type AgentViewWorkerEnvKey = (typeof AGENT_VIEW_WORKER_ENV_KEYS)[number];

export interface AgentViewWorkerSidebandEnv {
  sessionId: string;
  sidebandEndpoint: string;
  token: string;
  activeCwd: string;
}

type AgentViewWorkerEventWithoutSession =
  | Omit<Extract<AgentViewWorkerEvent, { type: 'ready' }>, 'sessionId'>
  | Omit<Extract<AgentViewWorkerEvent, { type: 'heartbeat' }>, 'sessionId'>
  | Omit<Extract<AgentViewWorkerEvent, { type: 'detach' }>, 'sessionId'>
  | Omit<Extract<AgentViewWorkerEvent, { type: 'state' }>, 'sessionId'>;

export interface AgentViewWorkerStateReport {
  sessionState: AgentViewSessionState;
  cwd?: string;
  summary?: string;
  waitingFor?: string;
  inputKind?: AgentViewInputKind;
  lastResult?: string;
}

export interface AgentViewWorkerHeartbeat {
  dispose(): void;
}

const lastStateReportKeys = new Map<string, string>();
const stateReportChains = new Map<string, Promise<void>>();
const pendingStateReports = new Map<string, AgentViewWorkerStateReport>();
const activePrompts = new Map<
  string,
  { promptId: string; phase: 'received' | 'ready' | 'accepted' }
>();

export function createAgentViewWorkerSidebandEnv(
  config: AgentViewWorkerSidebandEnv,
): Record<AgentViewWorkerEnvKey, string> {
  return {
    [QWEN_AGENT_VIEW_WORKER]: '1',
    [QWEN_AGENT_VIEW_SESSION_ID]: config.sessionId,
    [QWEN_AGENT_VIEW_SIDEBAND]: config.sidebandEndpoint,
    [QWEN_AGENT_VIEW_TOKEN]: config.token,
    [QWEN_AGENT_VIEW_ACTIVE_CWD]: config.activeCwd,
  };
}

export function isAgentViewWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[QWEN_AGENT_VIEW_WORKER] === '1';
}

export function readAgentViewWorkerSidebandEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentViewWorkerSidebandEnv | undefined {
  if (!isAgentViewWorkerEnv(env)) {
    return undefined;
  }

  const sessionId = env[QWEN_AGENT_VIEW_SESSION_ID];
  const sidebandEndpoint = env[QWEN_AGENT_VIEW_SIDEBAND];
  const token = env[QWEN_AGENT_VIEW_TOKEN];
  const activeCwd = env[QWEN_AGENT_VIEW_ACTIVE_CWD];

  if (!sessionId || !sidebandEndpoint || !token || !activeCwd) {
    return undefined;
  }

  return {
    sessionId,
    sidebandEndpoint,
    token,
    activeCwd,
  };
}

export async function sendAgentViewWorkerEvent(
  event: AgentViewWorkerEventWithoutSession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return undefined;
  return callAgentViewSupervisor(sideband.sidebandEndpoint, 'workerEvent', {
    ...event,
    // Stamp at emit time so the dequeue ordering guard (event.at vs
    // lastQueuedPromptAt) protects in production — worker events are
    // otherwise built without an `at` field.
    at: new Date().toISOString(),
    sessionId: sideband.sessionId,
    token: sideband.token,
  });
}

export async function readAgentViewWorkerControlEvents(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentViewWorkerControlEvent[]> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return [];
  const pendingReport = pendingStateReports.get(sideband.sessionId);
  if (pendingReport) {
    await reportAgentViewWorkerState(pendingReport, env);
  }

  const result = await callAgentViewSupervisor(
    sideband.sidebandEndpoint,
    'workerControl',
    {
      sessionId: sideband.sessionId,
      token: sideband.token,
    },
    { timeoutMs: 1000 },
  );

  if (!isRecord(result)) return [];
  const events = result['events'];
  if (!Array.isArray(events)) return [];
  return events.filter(isAgentViewWorkerControlEvent).filter((event) => {
    if (event.type !== 'prompt') return true;
    const active = activePrompts.get(sideband.sessionId);
    if (active?.promptId === event.promptId) return false;
    activePrompts.set(sideband.sessionId, {
      promptId: event.promptId,
      phase: 'received',
    });
    return true;
  });
}

export async function reportAgentViewWorkerState(
  report: AgentViewWorkerStateReport,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return;
  const activePrompt = activePrompts.get(sideband.sessionId);
  if (
    activePrompt &&
    activePrompt.phase === 'received' &&
    report.sessionState === 'idle'
  ) {
    activePrompt.phase = 'ready';
  }
  const promptId =
    activePrompt &&
    (activePrompt.phase === 'accepted' ||
      (activePrompt.phase === 'ready' && report.sessionState === 'working'))
      ? activePrompt.promptId
      : undefined;
  if (promptId && activePrompt?.phase === 'ready') {
    activePrompt.phase = 'accepted';
  }
  if (promptId) {
    pendingStateReports.set(sideband.sessionId, report);
  }

  const event = {
    type: 'state',
    ...report,
    ...(promptId ? { promptId } : {}),
    // activeCwd is guaranteed by readAgentViewWorkerSidebandEnv and survives
    // a deleted cwd, unlike process.cwd(), which throws ENOENT.
    cwd: report.cwd ?? sideband.activeCwd,
  } as const;
  const key = JSON.stringify(event);
  const sendAndRecord = async () => {
    if (key === lastStateReportKeys.get(sideband.sessionId)) {
      if (pendingStateReports.get(sideband.sessionId) === report) {
        pendingStateReports.delete(sideband.sessionId);
      }
      return;
    }

    try {
      await sendAgentViewWorkerEvent(event, env);
      lastStateReportKeys.set(sideband.sessionId, key);
      if (pendingStateReports.get(sideband.sessionId) === report) {
        pendingStateReports.delete(sideband.sessionId);
      }
      const currentPrompt = activePrompts.get(sideband.sessionId);
      if (
        event.promptId &&
        currentPrompt?.phase === 'accepted' &&
        (event.sessionState === 'idle' ||
          event.sessionState === 'completed' ||
          event.sessionState === 'stopped' ||
          event.sessionState === 'failed')
      ) {
        activePrompts.delete(sideband.sessionId);
      }
    } catch {
      lastStateReportKeys.delete(sideband.sessionId);
    }
  };
  const previous = stateReportChains.get(sideband.sessionId);
  const run = previous
    ? previous.catch(() => {}).then(sendAndRecord)
    : sendAndRecord();
  stateReportChains.set(sideband.sessionId, run);
  try {
    await run;
  } finally {
    if (stateReportChains.get(sideband.sessionId) === run) {
      stateReportChains.delete(sideband.sessionId);
    }
  }
}

export function startAgentViewWorkerHeartbeat(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = 15_000,
): AgentViewWorkerHeartbeat | undefined {
  if (!readAgentViewWorkerSidebandEnv(env)) return undefined;
  const interval = setInterval(() => {
    void sendAgentViewWorkerEvent({ type: 'heartbeat' }, env).catch(() => {});
  }, intervalMs);
  interval.unref?.();
  return {
    dispose() {
      clearInterval(interval);
    },
  };
}

export function resetAgentViewWorkerStateReportForTests(): void {
  lastStateReportKeys.clear();
  stateReportChains.clear();
  pendingStateReports.clear();
  activePrompts.clear();
}

function isAgentViewWorkerControlEvent(
  value: unknown,
): value is AgentViewWorkerControlEvent {
  if (
    !isRecord(value) ||
    !Number.isInteger(value['sequence']) ||
    typeof value['at'] !== 'string'
  ) {
    return false;
  }
  if (value['type'] === 'redraw') {
    return true;
  }
  if (value['type'] === 'stop') {
    return true;
  }
  if (value['type'] === 'prompt') {
    return (
      typeof value['promptId'] === 'string' && typeof value['text'] === 'string'
    );
  }
  return (
    value['type'] === 'answer' &&
    (value['text'] === undefined || typeof value['text'] === 'string') &&
    (value['callId'] === undefined || typeof value['callId'] === 'string') &&
    (value['outcome'] === undefined ||
      isAgentViewWorkerAnswerOutcome(value['outcome'])) &&
    (value['payload'] === undefined || isRecord(value['payload']))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentViewWorkerAnswerOutcome(value: unknown): boolean {
  return (
    value === 'proceed_once' ||
    value === 'proceed_always' ||
    value === 'proceed_always_project' ||
    value === 'proceed_always_user' ||
    value === 'modify_with_editor' ||
    value === 'restore_previous' ||
    value === 'cancel'
  );
}
