/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { callAgentViewSupervisor } from './supervisor-client.js';
import * as path from 'node:path';
import type {
  AgentViewCoordinationOutcome,
  AgentViewCoordinationWriteMode,
  AgentViewInputSnapshot,
  AgentViewInputKind,
  AgentViewPendingInput,
  AgentViewWorkerControlEvent,
  AgentViewSessionState,
  AgentViewWorkerEvent,
} from './protocol.js';

export const QWEN_AGENT_VIEW_WORKER = 'QWEN_AGENT_VIEW_WORKER';
export const QWEN_AGENT_VIEW_SESSION_ID = 'QWEN_AGENT_VIEW_SESSION_ID';
export const QWEN_AGENT_VIEW_SIDEBAND = 'QWEN_AGENT_VIEW_SIDEBAND';
export const QWEN_AGENT_VIEW_TOKEN = 'QWEN_AGENT_VIEW_TOKEN';
export const QWEN_AGENT_VIEW_ACTIVE_CWD = 'QWEN_AGENT_VIEW_ACTIVE_CWD';
export const QWEN_AGENT_VIEW_PROJECT_CWD = 'QWEN_AGENT_VIEW_PROJECT_CWD';
export const QWEN_AGENT_VIEW_GENERATION = 'QWEN_AGENT_VIEW_GENERATION';
export const QWEN_AGENT_VIEW_COORDINATION_MODE =
  'QWEN_AGENT_VIEW_COORDINATION_MODE';
export const QWEN_AGENT_VIEW_TASK_PATH = 'QWEN_AGENT_VIEW_TASK_PATH';
export const QWEN_AGENT_VIEW_PROMPT_ID = 'QWEN_AGENT_VIEW_PROMPT_ID';
export const QWEN_AGENT_VIEW_ATTEMPT_ID = 'QWEN_AGENT_VIEW_ATTEMPT_ID';
export const QWEN_AGENT_VIEW_INPUT_SNAPSHOT = 'QWEN_AGENT_VIEW_INPUT_SNAPSHOT';

export const AGENT_VIEW_WORKER_ENV_KEYS = [
  QWEN_AGENT_VIEW_WORKER,
  QWEN_AGENT_VIEW_SESSION_ID,
  QWEN_AGENT_VIEW_SIDEBAND,
  QWEN_AGENT_VIEW_TOKEN,
  QWEN_AGENT_VIEW_ACTIVE_CWD,
  QWEN_AGENT_VIEW_PROJECT_CWD,
  QWEN_AGENT_VIEW_GENERATION,
  QWEN_AGENT_VIEW_COORDINATION_MODE,
  QWEN_AGENT_VIEW_TASK_PATH,
  QWEN_AGENT_VIEW_PROMPT_ID,
  QWEN_AGENT_VIEW_ATTEMPT_ID,
  QWEN_AGENT_VIEW_INPUT_SNAPSHOT,
] as const;

export type AgentViewWorkerEnvKey = (typeof AGENT_VIEW_WORKER_ENV_KEYS)[number];

export interface AgentViewWorkerSidebandEnv {
  sessionId: string;
  sidebandEndpoint: string;
  token: string;
  activeCwd: string;
  generation: number;
}

export interface AgentViewCoordinationWorkerEnv {
  sideband: AgentViewWorkerSidebandEnv & { generation: number };
  projectCwd: string;
  writeMode: AgentViewCoordinationWriteMode;
  taskPath: string;
  promptId: string;
  attemptId: string;
  inputSnapshot: AgentViewInputSnapshot;
}

type AgentViewWorkerEventWithoutSession =
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'ready' }>,
      'sessionId' | 'generation' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'heartbeat' }>,
      'sessionId' | 'generation' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'detach' }>,
      'sessionId' | 'generation' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'state' }>,
      'sessionId' | 'generation' | 'sequence'
    >
  | Omit<
      Extract<AgentViewWorkerEvent, { type: 'result' }>,
      'sessionId' | 'generation' | 'sequence'
    >;

export interface AgentViewWorkerStateReport {
  promptId?: string;
  sessionState: AgentViewSessionState;
  cwd?: string;
  summary?: string;
  waitingFor?: string;
  inputKind?: AgentViewInputKind;
  callId?: string;
  inputType?: AgentViewPendingInput['type'];
  inputSummary?: string;
  lastResult?: string;
}

export interface AgentViewWorkerHeartbeat {
  dispose(): void;
}

const lastStateReportKeys = new Map<string, string>();
const nextEventSequences = new Map<string, number>();
const acknowledgedControlSequences = new Map<string, number>();
const eventSendQueues = new Map<string, Promise<unknown>>();

export function createAgentViewWorkerSidebandEnv(
  config: Omit<AgentViewWorkerSidebandEnv, 'generation'> & {
    generation?: number;
  },
): Record<string, string> {
  return {
    [QWEN_AGENT_VIEW_WORKER]: '1',
    [QWEN_AGENT_VIEW_SESSION_ID]: config.sessionId,
    [QWEN_AGENT_VIEW_SIDEBAND]: config.sidebandEndpoint,
    [QWEN_AGENT_VIEW_TOKEN]: config.token,
    [QWEN_AGENT_VIEW_ACTIVE_CWD]: config.activeCwd,
    [QWEN_AGENT_VIEW_GENERATION]: String(config.generation ?? 1),
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
  const generation = Number(env[QWEN_AGENT_VIEW_GENERATION]);

  if (
    !sessionId ||
    !sidebandEndpoint ||
    !token ||
    !activeCwd ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return undefined;
  }

  return {
    sessionId,
    sidebandEndpoint,
    token,
    activeCwd,
    generation,
  };
}

export function readAgentViewCoordinationWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentViewCoordinationWorkerEnv | undefined {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  const writeMode = env[QWEN_AGENT_VIEW_COORDINATION_MODE];
  const projectCwd = env[QWEN_AGENT_VIEW_PROJECT_CWD];
  const taskPath = env[QWEN_AGENT_VIEW_TASK_PATH];
  const promptId = env[QWEN_AGENT_VIEW_PROMPT_ID];
  const attemptId = env[QWEN_AGENT_VIEW_ATTEMPT_ID];
  const inputSnapshot = env[QWEN_AGENT_VIEW_INPUT_SNAPSHOT];
  if (
    !sideband ||
    !projectCwd ||
    !path.isAbsolute(projectCwd) ||
    (writeMode !== 'read-only' && writeMode !== 'isolated-writer') ||
    !taskPath ||
    !path.isAbsolute(taskPath) ||
    !promptId ||
    !attemptId ||
    !/^sha256:[0-9a-f]{64}$/.test(inputSnapshot ?? '')
  ) {
    return undefined;
  }
  return {
    sideband,
    projectCwd,
    writeMode,
    taskPath,
    promptId,
    attemptId,
    inputSnapshot: inputSnapshot as AgentViewInputSnapshot,
  };
}

export async function sendAgentViewWorkerEvent(
  event: AgentViewWorkerEventWithoutSession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return undefined;
  const sequenceKey = sidebandKey(sideband);
  const sequence = (nextEventSequences.get(sequenceKey) ?? 0) + 1;
  nextEventSequences.set(sequenceKey, sequence);
  const previous = eventSendQueues.get(sequenceKey) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() =>
      callAgentViewSupervisor(sideband.sidebandEndpoint, 'workerEvent', {
        ...event,
        sessionId: sideband.sessionId,
        token: sideband.token,
        generation: sideband.generation,
        sequence,
      }),
    );
  eventSendQueues.set(sequenceKey, current);
  void current
    .finally(() => {
      if (eventSendQueues.get(sequenceKey) === current) {
        eventSendQueues.delete(sequenceKey);
      }
    })
    .catch(() => {});
  return current;
}

export async function readAgentViewWorkerControlEvents(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentViewWorkerControlEvent[]> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband) return [];
  const key = sidebandKey(sideband);

  const result = await callAgentViewSupervisor(
    sideband.sidebandEndpoint,
    'workerControl',
    {
      sessionId: sideband.sessionId,
      token: sideband.token,
      generation: sideband.generation,
      ackSequence: acknowledgedControlSequences.get(key) ?? 0,
    },
    { timeoutMs: 1000 },
  );

  if (!isRecord(result) || result['generation'] !== sideband.generation) {
    return [];
  }
  const events = result['events'];
  if (!Array.isArray(events)) return [];
  return events.filter(isAgentViewWorkerControlEvent);
}

export function acknowledgeAgentViewWorkerControlEvents(
  sequence: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (!sideband || !Number.isSafeInteger(sequence) || sequence < 0) return;
  const key = sidebandKey(sideband);
  acknowledgedControlSequences.set(
    key,
    Math.max(acknowledgedControlSequences.get(key) ?? 0, sequence),
  );
}

export async function reportAgentViewWorkerResult(
  result: {
    promptId: string;
    attemptId: string;
    outcome: AgentViewCoordinationOutcome;
    summary: string;
    artifacts?: string[];
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await sendAgentViewWorkerEvent({ type: 'result', ...result }, env);
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
  nextEventSequences.clear();
  acknowledgedControlSequences.clear();
  eventSendQueues.clear();
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
    typeof value['promptId'] === 'string' &&
    typeof value['callId'] === 'string' &&
    (value['text'] === undefined || typeof value['text'] === 'string') &&
    (value['outcome'] === undefined ||
      isAgentViewWorkerAnswerOutcome(value['outcome'])) &&
    (value['payload'] === undefined || isRecord(value['payload']))
  );
}

function sidebandKey(sideband: AgentViewWorkerSidebandEnv): string {
  return `${sideband.sessionId}:${sideband.generation ?? 1}`;
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
