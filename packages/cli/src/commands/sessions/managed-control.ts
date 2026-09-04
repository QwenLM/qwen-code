/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seeing and answering a background session.
 *
 * `qwen sessions ps` can say a background session is waiting for input.
 * That is only useful if the question can be read and answered, and if a
 * session can be stopped — otherwise the listing reports a state the user
 * has no way to act on, and `kill <pid>` is the only exit.
 *
 * Each of these is a thin call to a supervisor operation that already
 * exists; the work here is deciding what to print and refusing to invent
 * an answer when the supervisor is not running.
 *
 * The supervisor is never *started* by these commands. Starting one to
 * ask it about sessions it cannot have would turn "nothing is running"
 * into a spawned process and a confusing empty answer.
 */

import {
  sanitizeTerminalText,
  truncateToWidth,
} from '../../ui/utils/textUtils.js';
import { deriveAgentViewPresentation } from '../../agent-view/presentation.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewRosterEntry,
  AgentViewSessionStateFile,
} from '../../agent-view/protocol.js';

/** The supervisor calls these commands make. */
export interface ManagedControlHandle {
  peek(sessionId: string): Promise<unknown>;
  answer(sessionId: string, text: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
}

/**
 * Injected so the commands are testable without a supervisor, and so the
 * "no supervisor" path is a value rather than a thrown connection error.
 */
export type ConnectSupervisor = () => Promise<ManagedControlHandle | undefined>;

/** What a command wants printed, and with what exit code. */
export interface ManagedControlResult {
  lines: string[];
  exitCode: number;
}

const NO_SUPERVISOR: ManagedControlResult = {
  lines: [
    'No background sessions are running (no supervisor to ask).',
    'Start one with: qwen --bg "<prompt>"',
  ],
  exitCode: 1,
};

/**
 * Text from a managed session, made safe for a terminal.
 *
 * Every string here was written by another process — a model's own
 * words, or a path it chose — so it carries the same risk as a registry
 * record: escape sequences that repaint the screen, and bidi overrides
 * that reorder what is read. `sessions ps` sanitizes for the same reason.
 *
 * `sanitizeTerminalText` deliberately preserves TAB and LF for multi-line
 * render sites, but everything this file prints is one labelled line: a
 * kept LF would let session text start a forged continuation at column 0
 * — a fake `Answer it with:` hint, for instance. The one-line renderer
 * `ps.ts` drops those two on top of the shared helper for exactly this
 * reason, so this does the same.
 */
function clean(value: string | undefined, limit = 500): string {
  if (!value) return '';
  return truncateToWidth(
    sanitizeTerminalText(value).replace(/[\t\n]/g, ''),
    limit,
  );
}

interface PeekResponse {
  sessionId: string;
  state: AgentViewSessionStateFile;
  activity?: AgentViewActivityFile;
  rosterEntry?: AgentViewRosterEntry;
  launch?: AgentViewLaunchFile;
  live?: boolean;
}

function isPeekResponse(value: unknown): value is PeekResponse {
  if (typeof value !== 'object' || value === null) return false;
  const state = (value as { state?: unknown }).state;
  return typeof state === 'object' && state !== null && 'sessionId' in state;
}

/** Short handle a user can type back, matching the id `--bg` printed. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Report what a background session is doing, and what it is waiting for.
 *
 * The title and the state line come from `deriveAgentViewPresentation`,
 * fed the same roster entry, launch record and activity the roster and
 * `sessions ps` use, so three surfaces cannot describe one session
 * three ways.
 */
export async function peekManagedSession(
  sessionId: string,
  connect: ConnectSupervisor,
): Promise<ManagedControlResult> {
  const handle = await connect();
  if (!handle) return NO_SUPERVISOR;

  let response: unknown;
  try {
    response = await handle.peek(sessionId);
  } catch (error) {
    return failure(error);
  }
  if (!isPeekResponse(response)) {
    return {
      lines: ['The supervisor returned no state for that session.'],
      exitCode: 1,
    };
  }

  const presentation = deriveAgentViewPresentation({
    state: response.state,
    rosterEntry: response.rosterEntry,
    launch: response.launch,
    activity: response.activity,
  });
  const lines = [
    `${clean(presentation.title, 200)}  [${shortSessionId(response.state.sessionId)}]`,
    `State:     ${presentation.taskState}${response.live === false ? ' (no live process)' : ''}`,
    `Directory: ${clean(response.state.activeCwd, 200)}`,
  ];

  const waitingFor = clean(response.activity?.waitingFor, 300);
  if (waitingFor) {
    lines.push(`Waiting:   ${waitingFor}`);
  }
  const summary = clean(response.activity?.summary, 300);
  if (summary) {
    lines.push(`Doing:     ${summary}`);
  }
  const lastResult = clean(response.activity?.lastResult, 300);
  if (lastResult) {
    lines.push(`Last:      ${lastResult}`);
  }

  // Only offered when it would do something: answering a session that is
  // not waiting queues a prompt, which is `send`, not this command.
  if (presentation.taskState === 'waiting') {
    lines.push(
      '',
      `Answer it with: qwen sessions answer ${shortSessionId(response.state.sessionId)} "<your answer>"`,
    );
  }
  return { lines, exitCode: 0 };
}

/** Answer a background session that stopped to ask something. */
export async function answerManagedSession(
  sessionId: string,
  text: string,
  connect: ConnectSupervisor,
): Promise<ManagedControlResult> {
  if (!text.trim()) {
    return {
      lines: ['An answer cannot be empty.'],
      exitCode: 1,
    };
  }
  const handle = await connect();
  if (!handle) return NO_SUPERVISOR;
  try {
    await handle.answer(sessionId, text);
  } catch (error) {
    return failure(error);
  }
  return { lines: ['Answer delivered.'], exitCode: 0 };
}

/** Stop a background session, leaving its transcript in place. */
export async function stopManagedSession(
  sessionId: string,
  connect: ConnectSupervisor,
): Promise<ManagedControlResult> {
  const handle = await connect();
  if (!handle) return NO_SUPERVISOR;
  try {
    await handle.stop(sessionId);
  } catch (error) {
    return failure(error);
  }
  return { lines: ['Stopped.'], exitCode: 0 };
}

/**
 * A supervisor error as a sentence.
 *
 * The supervisor already words the cases a user meets — an unknown id, an
 * ambiguous prefix, a session that is not managed — so its message is
 * repeated rather than reinterpreted. Only the stack is dropped.
 */
function failure(error: unknown): ManagedControlResult {
  const reason = error instanceof Error ? error.message : String(error);
  return { lines: [clean(reason, 400)], exitCode: 1 };
}
