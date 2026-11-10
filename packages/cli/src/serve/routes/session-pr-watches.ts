/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readCronTasks } from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import { repoKeyFromWebUrl } from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { listAutofixPrWatches } from './autofix-pr-watches.js';

/**
 * Active PR watches of one workspace, keyed sessionId → set of
 * `host/owner/repo#number` keys. Derived at scan time from the artifacts the
 * watch flows already write — no persisted watch state of its own:
 *
 * - `/autofix-pr` watches: the state files `listAutofixPrWatches` reads
 *   (owning session, not stopped or ended). Covers in-place watches and
 *   takeovers, whose state file is the authority.
 * - `/verify-pr <n> --watch`: the durable recurring scheduled task bound to
 *   the session, whose gate runs `verify-pr-watch-gate.mjs <n> --repo
 *   <owner>/<repo>`. The gate claim file records no session id, so the task
 *   is the only session-attributed artifact.
 *
 * Fail-open: when a source cannot be read the answer is `undefined`
 * (unknown), never a partial map — the caller leaves `watching` absent so
 * the channel keeps delivering as it did before the gate existed. That
 * includes the listing's NON-throwing failure shapes: `available: false`
 * (the clone's worktrees could not be enumerated) and a non-empty
 * `unreadable` (individual state files failed to read).
 */
export type ActivePrWatches = Map<string, Set<string>>;

/**
 * The watch-set key of a PR: `repoKeyFromWebUrl(url)#number`. The bindings
 * route derives its lookup key with the SAME function on the binding URL,
 * so host spellings (port, leading www, case) normalize identically on both
 * sides — a watch key built by hand from a raw host would never match a
 * binding URL on a non-default-port enterprise host.
 */
export function prWatchKey(url: string, pr: number): string | undefined {
  const repoKey = repoKeyFromWebUrl(url);
  return repoKey === undefined ? undefined : `${repoKey}#${pr}`;
}

/**
 * The PR a `/verify-pr --watch` gate names, or undefined when the gate is
 * not a standing watch. Mirrors the gate script's own `parseArgs`
 * (scripts/verify-pr-watch-gate.mjs): `--repo`/`--cli`/`--state-root`
 * consume the following token, the first non-flag positional is the PR
 * number, and `--check`/`--claim`/`--release` are one-shot probe
 * invocations (setup/teardown), never a standing watch. The gate is
 * model-authored — flag order varies and the script path may be quoted —
 * so the parse is token-based with edge quotes stripped. A gate missing
 * the number or the repo contributes nothing (fail-open for that task).
 */
export function parseVerifyPrWatchGate(
  gate: string | undefined,
): { repo: string; pr: number } | undefined {
  if (!gate) return undefined;
  const tokens = gate
    .split(/\s+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ''));
  const scriptIndex = tokens.findIndex((token) =>
    token.endsWith('verify-pr-watch-gate.mjs'),
  );
  if (scriptIndex === -1) return undefined;
  let pr: number | undefined;
  let repo: string | undefined;
  for (let i = scriptIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '') continue;
    if (token === '--check' || token === '--claim' || token === '--release') {
      return undefined;
    }
    if (token === '--repo' || token === '--cli' || token === '--state-root') {
      const value = tokens[++i];
      if (token === '--repo') repo = value;
      continue;
    }
    if (!token.startsWith('-') && pr === undefined) {
      // The script takes the FIRST non-flag positional unconditionally and
      // throws unless it is a positive integer — a gate it cannot run is no
      // watch, so a non-numeric first positional must not fall through to a
      // later number.
      const value = Number(token);
      if (!Number.isInteger(value) || value <= 0) return undefined;
      pr = value;
    }
  }
  if (pr === undefined) return undefined;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  // The gate script takes no --host; its probe reads github.com.
  return { repo, pr };
}

export async function collectActivePrWatches(
  workspaceCwd: string,
): Promise<ActivePrWatches | undefined> {
  const watches: ActivePrWatches = new Map();
  const add = (sessionId: string, key: string): void => {
    let set = watches.get(sessionId);
    if (!set) {
      set = new Set();
      watches.set(sessionId, set);
    }
    set.add(key);
  };
  try {
    const listing = await listAutofixPrWatches(workspaceCwd);
    if (
      !listing.available ||
      (listing.unreadable !== undefined && listing.unreadable.length > 0)
    ) {
      return undefined;
    }
    for (const watch of listing.watches) {
      if (watch.session && watch.stopped === null && watch.ended === null) {
        const key = prWatchKey(watch.url, watch.pr);
        if (key !== undefined) add(watch.session, key);
      }
    }
  } catch {
    return undefined;
  }
  try {
    const tasks = await readCronTasks(workspaceCwd);
    for (const task of tasks) {
      if (task.enabled === false || !task.recurring || !task.sessionId) {
        continue;
      }
      const parsed = parseVerifyPrWatchGate(task.gate);
      if (parsed) {
        const key = prWatchKey(
          `https://github.com/${parsed.repo}/pull/${parsed.pr}`,
          parsed.pr,
        );
        if (key !== undefined) add(task.sessionId, key);
      }
    }
  } catch {
    return undefined;
  }
  return watches;
}
