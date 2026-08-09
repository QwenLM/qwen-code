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
export const QWEN_AGENT_VIEW_GENERATION = 'QWEN_AGENT_VIEW_GENERATION';

export const AGENT_VIEW_WORKER_ENV_KEYS = [
  QWEN_AGENT_VIEW_WORKER,
  QWEN_AGENT_VIEW_SESSION_ID,
  QWEN_AGENT_VIEW_SIDEBAND,
  QWEN_AGENT_VIEW_TOKEN,
  QWEN_AGENT_VIEW_ACTIVE_CWD,
  QWEN_AGENT_VIEW_GENERATION,
] as const;

export type AgentViewWorkerEnvKey = (typeof AGENT_VIEW_WORKER_ENV_KEYS)[number];

export interface AgentViewWorkerSidebandEnv {
  sessionId: string;
  sidebandEndpoint: string;
  token: string;
  activeCwd: string;
  workerGeneration: string;
}

type AgentViewWorkerEventWithoutSession =
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'ready' }>,
      'sessionId' | 'workerGeneration' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'heartbeat' }>,
      'sessionId' | 'workerGeneration' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'detach' }>,
      'sessionId' | 'workerGeneration' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'state' }>,
      'sessionId' | 'workerGeneration' | 'sequence'
    >;

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
const workerEventQueues = new Map<string, Promise<void>>();
const workerEventSequences = new Map<string, number>();
const pendingWorkerEvents = new Map<
  string,
  {
    event: AgentViewWorkerEventWithoutSession;
    eventKey: string;
    sequence: number;
  }
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
    [QWEN_AGENT_VIEW_GENERATION]: config.workerGeneration,
  };
}

export function createPersistedAgentViewWorkerEnv(
  config: Omit<AgentViewWorkerSidebandEnv, 'token'>,
): Record<string, string> {
  return {
    [QWEN_AGENT_VIEW_WORKER]: '1',
    [QWEN_AGENT_VIEW_SESSION_ID]: config.sessionId,
    [QWEN_AGENT_VIEW_SIDEBAND]: config.sidebandEndpoint,
    [QWEN_AGENT_VIEW_ACTIVE_CWD]: config.activeCwd,
    [QWEN_AGENT_VIEW_GENERATION]: config.workerGeneration,
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
  const workerGeneration = env[QWEN_AGENT_VIEW_GENERATION];

  if (
    !sessionId ||
    !sidebandEndpoint ||
    !token ||
    !activeCwd ||
    !workerGeneration
  ) {
    return undefined;
  }

  return {
    sessionId,
    sidebandEndpoint,
    token,
    activeCwd,
    workerGeneration,
  };
}

export async function sendAgentViewWorkerEvent(
  event: AgentViewWorkerEventWithoutSession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return undefined;
  const key = `${sideband.sessionId}:${sideband.workerGeneration}`;
  const previous = workerEventQueues.get(key) ?? Promise.resolve();
  const current = previous.then(async () => {
    const eventKey = JSON.stringify(event);
    const pending = pendingWorkerEvents.get(key);
    if (pending) {
      const result = await sendWorkerEventAndRequireAck(
        sideband,
        pending.event,
        pending.sequence,
      );
      pendingWorkerEvents.delete(key);
      workerEventSequences.set(key, pending.sequence + 1);
      if (pending.eventKey === eventKey) return result;
    }
    const sequence = workerEventSequences.get(key) ?? 0;
    try {
      const result = await sendWorkerEventAndRequireAck(
        sideband,
        event,
        sequence,
      );
      workerEventSequences.set(key, sequence + 1);
      return result;
    } catch (error) {
      pendingWorkerEvents.set(key, { event, eventKey, sequence });
      throw error;
    }
  });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  workerEventQueues.set(key, tail);
  void tail.finally(() => {
    if (workerEventQueues.get(key) === tail) {
      workerEventQueues.delete(key);
    }
  });
  return current;
}

export async function readAgentViewWorkerControlEvents(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentViewWorkerControlEvent[]> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return [];

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
  return events.filter(isAgentViewWorkerControlEvent);
}

export async function reportAgentViewWorkerState(
  report: AgentViewWorkerStateReport,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return;

  const event = {
    type: 'state',
    ...report,
    cwd: report.cwd ?? process.cwd(),
  } as const;
  const key = JSON.stringify(event);
  if (key === lastStateReportKeys.get(sideband.sessionId)) return;

  try {
    await sendAgentViewWorkerEvent(event, env);
    lastStateReportKeys.set(sideband.sessionId, key);
  } catch {
    lastStateReportKeys.delete(sideband.sessionId);
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
  workerEventQueues.clear();
  workerEventSequences.clear();
  pendingWorkerEvents.clear();
}

async function sendWorkerEventAndRequireAck(
  sideband: AgentViewWorkerSidebandEnv,
  event: AgentViewWorkerEventWithoutSession,
  sequence: number,
): Promise<unknown> {
  const result = await callAgentViewSupervisor(
    sideband.sidebandEndpoint,
    'workerEvent',
    {
      ...event,
      sessionId: sideband.sessionId,
      token: sideband.token,
      workerGeneration: sideband.workerGeneration,
      sequence,
    },
  );
  if (
    !isRecord(result) ||
    result['accepted'] !== true ||
    result['workerGeneration'] !== sideband.workerGeneration ||
    result['sequence'] !== sequence
  ) {
    throw new Error('Agent View supervisor returned an invalid event ACK.');
  }
  return result;
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
    return typeof value['text'] === 'string';
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
