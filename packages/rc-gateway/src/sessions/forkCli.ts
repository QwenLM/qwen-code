/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure argv/ payload logic for `qwen-rc fork` (`add-session-forking` task
 * 3.4 — the terminal-client shortcut; this repo has no interactive session
 * REPL, so the CLI command IS the terminal client, and task 3.2's `:fork`
 * slash maps onto it). The cli.ts branch is glue: it resolves the daemon
 * target, POSTs, and prints.
 *
 * Deliberately narrower than the spec's ideal: `--mode` accepts `include`
 * and `empty` only. `summary` is DEFERRED in the daemon (it answers 400
 * `unsupported_fork_mode`), so the CLI rejects it up front with an
 * actionable message instead of round-tripping a guaranteed 400.
 */

import { isValidSessionId } from './chatsPath.js';

export type ForkMode = 'include' | 'empty';

export interface ForkArgs {
  sessionId: string;
  /** Slice cap: copies parent lines 1..fromEventId. Undefined = full copy. */
  fromEventId?: number;
  mode: ForkMode;
  name?: string;
}

export type ForkArgsResult =
  | { ok: true; value: ForkArgs }
  | { ok: false; error: string };

const MODES: readonly ForkMode[] = ['include', 'empty'];
/** Daemon-side cap on the optional fork name (routes/fork.ts). */
const MAX_NAME_LEN = 200;

const USAGE =
  'usage: qwen-rc fork <sessionId> [--from-event <n>] [--mode include|empty] [--name <s>] ' +
  '[--daemon <name>|--url <u>] [--token <t>] [--insecure]';

export function parseForkArgs(argv: string[]): ForkArgsResult {
  const positional: string[] = [];
  let fromEventId: number | undefined;
  let mode: ForkMode = 'include';
  let name: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-event' || a === '--from') {
      const v = argv[++i];
      if (v === undefined || v === '') {
        return { ok: false, error: `${a} requires a non-empty value` };
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          error: `${a} must be a non-negative integer, got: ${v}`,
        };
      }
      fromEventId = n;
    } else if (a === '--mode') {
      const v = argv[++i];
      if (v === undefined)
        return { ok: false, error: '--mode requires a value' };
      if (v === 'summary') {
        return {
          ok: false,
          error:
            'summary mode is deferred (the daemon answers 400 unsupported_fork_mode) — use include or empty',
        };
      }
      if (!(MODES as readonly string[]).includes(v)) {
        return {
          ok: false,
          error: `--mode must be one of: ${MODES.join(', ')} (got: ${v})`,
        };
      }
      mode = v as ForkMode;
    } else if (a === '--name') {
      const v = argv[++i];
      if (v === undefined)
        return { ok: false, error: '--name requires a value' };
      if (v.trim().length === 0) {
        return { ok: false, error: '--name must not be blank' };
      }
      if (v.length > MAX_NAME_LEN) {
        return { ok: false, error: `--name must be ≤ ${MAX_NAME_LEN} chars` };
      }
      name = v;
    } else if (a.startsWith('--')) {
      return { ok: false, error: `unknown flag: ${a} — ${USAGE}` };
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    return { ok: false, error: USAGE };
  }
  const sessionId = positional[0];
  if (!isValidSessionId(sessionId)) {
    return { ok: false, error: `invalid session id: ${sessionId}` };
  }
  return {
    ok: true,
    value: {
      sessionId,
      ...(fromEventId !== undefined ? { fromEventId } : {}),
      mode,
      ...(name !== undefined ? { name } : {}),
    },
  };
}

/** Build the `POST /session/:id/fork` JSON body (routes/fork.ts contract). */
export function buildForkPayload(args: ForkArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = { transcript: args.mode };
  if (args.fromEventId !== undefined) payload['fromEventId'] = args.fromEventId;
  if (args.name !== undefined) payload['name'] = args.name;
  return payload;
}

/**
 * Task 3.4: stdout carries ONLY the new sessionId (machine-readable); hints
 * belong on stderr. A non-string sessionId (unexpected body) is printed as
 * JSON so the operator still sees the daemon's answer.
 */
export function formatForkOutput(body: unknown): string {
  if (body && typeof body === 'object') {
    const sid = (body as Record<string, unknown>)['sessionId'];
    if (typeof sid === 'string') return sid;
  }
  return JSON.stringify(body);
}
