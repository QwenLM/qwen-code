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

import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import {
  sessionIdContext,
  getSessionProjectDir,
  getSessionModel,
} from './sessionIdContext.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

/**
 * An entry a POSIX shell cannot exec directly. The gate demands POSITIVE
 * evidence of executability rather than enumerating known-bad shapes: an
 * enumeration answered "usable" for everything outside it, and two such
 * shapes reached the stamp in the wild — a tsx dev launch whose argv[1] is a
 * 0644 `index.ts`, and `node <pkg-dir>` whose argv[1] is the DIRECTORY, both
 * of which a shell exec answers with exit 126 while `${QWEN_CODE_CLI:-qwen}`
 * would have fallen back on empty.
 *
 * Usable means: a REGULAR file (a directory passes an X_OK probe — search
 * permission — so executability alone cannot gate it out), with execute
 * permission, that is either a `#!`-headed script (any extension) or a
 * non-script file (a native binary needs no shebang). A known script
 * extension without a shebang is unusable even when executable — the kernel
 * would hand it to a shell as shell script. The desktop tooling's vendored
 * bundle (no shebang) and a shebang-bearing 0644 script both stay filtered,
 * exactly as before. Cached per path: this runs on every shell spawn, and
 * the answer for a given entry does not change in-process.
 *
 * Exported because a producer of the stamp has to apply the same test the
 * consumer here does: `qwen review run` stamps the entry it re-enters, and a
 * stamp this function would blank is worse than no stamp — it names a path the
 * skill's `"${QWEN_CODE_CLI:-qwen}"` cannot exec, instead of falling back.
 */
const SCRIPT_ENTRY_RE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/i;
const unusableCache = new Map<string, boolean>();
export function isUnusableScriptEntry(path: string): boolean {
  const cached = unusableCache.get(path);
  if (cached !== undefined) return cached;
  let unusable: boolean;
  try {
    if (!statSync(path).isFile()) {
      unusable = true;
    } else {
      accessSync(path, constants.X_OK);
      const fd = openSync(path, 'r');
      try {
        const head = Buffer.alloc(2);
        const read = readSync(fd, head, 0, 2, 0);
        const shebang = read === 2 && head.toString('utf8') === '#!';
        unusable = shebang ? false : SCRIPT_ENTRY_RE.test(path);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // Missing, unreadable or non-executable is unusable either way; fall back
    // to `qwen`.
    unusable = true;
  }
  unusableCache.set(path, unusable);
  return unusable;
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
  // and a shell handed that would run the bundle as a shell script. The gate
  // asks for positive evidence — a regular file with the execute bit, plus a
  // `#!` header for script extensions; a native binary needs no shebang and
  // still passes.
  //
  // Filtering means writing an EMPTY STRING, not omitting the key — the same
  // rule the agent/prompt IDs below already follow, and for the same reason:
  // every spawn site composes the child env as `{...process.env, ...this}`, so
  // a key omitted here arrives anyway, inherited through the spread. The first
  // cut omitted, and on exactly the hosts the filter was written for the value
  // leaked through and every `"${QWEN_CODE_CLI:-qwen}"` died on exit 126.
  // Empty is safe for the consumer: the `:-` expansion falls back to `qwen` on
  // unset AND on empty.
  const cliEntry = process.env['QWEN_CODE_CLI'];
  if (cliEntry) {
    env['QWEN_CODE_CLI'] = isUnusableScriptEntry(cliEntry) ? '' : cliEntry;
  }

  // The model id that is ACTIVE in this session, for subprocesses that report
  // which model ran (the /review skill stamps its compose report with one).
  // Settings files are not a substitute: they miss /model switches, and under
  // QWEN_HOME isolation they describe a different home entirely. Config
  // publishes it per session and republishes on every model change
  // (publishModelEnv in config.ts). Keyed on this session exactly as the
  // project dir above is — a process-global slot would hold whichever session
  // booted first, and in daemon mode every later one would hand its
  // subprocesses another session's model. Falls back to the global slot for the
  // single-session CLI. Omitted (not blanked) when absent, for the session ID's
  // reason — no value in this process means the spawn-site spread has nothing
  // stale to leak.
  const model =
    (sessionId ? getSessionModel(sessionId) : undefined) ??
    process.env['QWEN_CODE_MODEL'];
  if (model) {
    env['QWEN_CODE_MODEL'] = model;
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
