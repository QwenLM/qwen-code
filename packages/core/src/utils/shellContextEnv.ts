/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns context environment variables to inject into shell subprocesses.
 *
 * Reads dynamic context (session ID, agent ID, prompt ID) from
 * AsyncLocalStorage at call time, falling back to process.env for the
 * session ID (set by Config at session start in the single-session CLI).
 * This enables downstream scripts to identify which session, agent, and
 * prompt triggered their execution — useful for tracing, audit logging,
 * and business context correlation.
 *
 * The ALS-first lookup matters in daemon mode: one process hosts many
 * sessions, but only the first Config ever claims the process-global
 * env slot (`sessionEnvClaimed` in config.ts), so process.env alone
 * would report a stale session ID for every later session.
 *
 * Must be called at spawn time within the executing async context to
 * capture the correct session/agent/prompt frame.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import { sessionIdContext, getSessionProjectDir } from './sessionIdContext.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

/**
 * A `.js`/`.mjs`/`.cjs` file whose first bytes are not `#!` — the one shape a
 * POSIX shell cannot exec directly. Cached per path: this runs on every shell
 * spawn, and the answer for a given entry does not change within a process.
 */
const shebangCache = new Map<string, boolean>();
function isShebangLessScript(path: string): boolean {
  if (!/\.(?:mjs|cjs|js)$/i.test(path)) return false;
  const cached = shebangCache.get(path);
  if (cached !== undefined) return cached;
  let shebangless: boolean;
  try {
    const fd = openSync(path, 'r');
    try {
      const head = Buffer.alloc(2);
      const read = readSync(fd, head, 0, 2, 0);
      shebangless = !(read === 2 && head.toString('utf8') === '#!');
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable is unusable either way; let it drop to the `qwen` fallback.
    shebangless = true;
  }
  shebangCache.set(path, shebangless);
  return shebangless;
}

export function getShellContextEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};

  // Prefer the per-async-context session ID (set by multi-session hosts
  // like the daemon) over the process-global env slot, which only ever
  // reflects the first session created in this process.
  const sessionId =
    sessionIdContext.getStore() ?? process.env['QWEN_CODE_SESSION_ID'];
  if (sessionId) {
    env['QWEN_CODE_SESSION_ID'] = sessionId;
  }

  // The project dir a subprocess needs to find this session's harness records
  // (subagent transcripts, chats). It is keyed on the session's *launch* cwd, so
  // a subprocess that has `cd`-ed into a worktree cannot recompute it — the
  // /review skill does exactly that, and would look for a directory that never
  // existed. Passed through, never recomputed downstream.
  // Keyed on *this* session, exactly as the session id above is — a process-global
  // slot holds whichever session booted first, and in daemon mode every later one
  // would hand its subprocesses another session's directory.
  const projectDir =
    (sessionId ? getSessionProjectDir(sessionId) : undefined) ??
    process.env['QWEN_CODE_PROJECT_DIR'];
  if (projectDir) {
    env['QWEN_CODE_PROJECT_DIR'] = projectDir;
  }

  // The CLI a subprocess should call to reach *this* build.
  //
  // A skill that shells out to `qwen …` gets whatever `qwen` PATH resolves to,
  // which is not necessarily the code that launched it: run `npm run dev:daemon`
  // on a machine with an older global install and every `qwen review …` the
  // /review skill issues lands in the old binary. Measured: a current-source
  // daemon told its shell to run `qwen review agent-prompt --role 0`, PATH
  // resolved to a v0.19.10 global whose `agent-prompt` predates `--role`, and the
  // run died on `Missing required argument: chunk` — the skill and the CLI running
  // it were different programs.
  //
  // So the entry is passed down instead of rediscovered. The bin wrapper sets it
  // (it is the executable entry, and knows its own path); a subprocess prefers it
  // and falls back to `qwen` when it is absent, which is exactly the old behaviour.
  //
  // Passed down only when a shell could actually exec it. The variable predates
  // this mechanism with a SECOND meaning: the desktop app's tooling sets it to a
  // vendored `dist/cli.js` — a module path for `node <path>`, with no shebang —
  // and a shell handed that would run the bundle as a shell script. A
  // shebang-less script cannot be the exec'd entry under the POSIX shell the
  // consumer requires anyway, so filtering it just restores the bare-`qwen`
  // fallback for those hosts. Only script files are gated: a native binary needs
  // no shebang, and this must not filter one.
  const cliEntry = process.env['QWEN_CODE_CLI'];
  if (cliEntry && !isShebangLessScript(cliEntry)) {
    env['QWEN_CODE_CLI'] = cliEntry;
  }

  // For agent/prompt IDs: explicitly set empty string when no ALS context
  // exists, so that stale values inherited from a parent qwen-code process
  // (via process.env spread) are overwritten rather than leaked.
  const agentId = getCurrentAgentId();
  env['QWEN_CODE_AGENT_ID'] = agentId ?? '';

  const promptId = promptIdContext.getStore();
  env['QWEN_CODE_PROMPT_ID'] = promptId ?? '';

  if (isShellTracePropagationEnabled()) {
    const ctx = getTraceContext();
    env['TRACEPARENT'] = ctx ? formatTraceparent(ctx) : '';
    env['TRACESTATE'] = '';
  }

  return env;
}
