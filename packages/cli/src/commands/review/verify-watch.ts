/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review verify-watch`: register a PR for clean-review observation.
//
// E1 (`verify-event`) needs the reviewer to hand off once. A watch needs nothing
// from them at all: the daemon re-reads the PR's current approval state and
// hands off every head that comes back clean, whoever approved it — another
// agent, the CI bot, or a person.
//
// The watch list lives beside the events, in the host-trusted review-state
// directory, and is keyed by coordinates rather than by head: a watch spans
// heads, and the per-head dedupe downstream is what keeps one verification per
// head.

import type { CommandModule } from 'yargs';
import { resolve } from 'node:path';
import {
  addWatch,
  observeWatches,
  readWatches,
  removeWatch,
  watchKey,
  type ObservationOutcome,
  type ReviewVerifyWatch,
} from './lib/review-verify-observe.js';
import { resolvePrCoordinates } from './verify-event.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

export interface VerifyWatchArgs {
  pr?: number;
  repo?: string;
  host?: string;
  remove?: boolean;
  list?: boolean;
  once?: boolean;
  sessionId?: string;
  workspaceRoot?: string;
}

export type VerifyWatchResult =
  | { action: 'list'; watches: ReviewVerifyWatch[] }
  | { action: 'once'; outcomes: ObservationOutcome[] }
  | { action: 'add'; watch: ReviewVerifyWatch }
  | { action: 'remove'; key: string; removed: boolean };

export async function runVerifyWatch(
  args: VerifyWatchArgs,
): Promise<VerifyWatchResult> {
  const root = resolve(args.workspaceRoot?.trim() || process.cwd());
  if (args.list) return { action: 'list', watches: readWatches(root) };
  if (args.once)
    return { action: 'once', outcomes: await observeWatches(root) };
  if (args.pr === undefined) {
    throw new TypeError('verify-watch needs a PR number, or --list / --once');
  }
  if (args.repo === undefined) {
    throw new TypeError('verify-watch needs --repo owner/repo');
  }
  const sessionId =
    args.sessionId?.trim() ||
    process.env['QWEN_CODE_SESSION_ID']?.trim() ||
    undefined;
  if (!sessionId) {
    // A watch belongs to a session: the automation runs on its behalf, every
    // verification it starts is that session's sub-session, and deleting the
    // session ends the watch. There is no ownerless watch to register.
    throw new TypeError(
      'verify-watch needs a session: the watch belongs to it and its verification rounds become its sub-sessions. Run this inside a qwen-code session, or pass --session-id.',
    );
  }
  const coordinates = resolvePrCoordinates({
    pr: args.pr,
    repo: args.repo,
    host: args.host,
  });
  const key = watchKey({ ...coordinates, sessionId });
  if (args.remove) {
    return { action: 'remove', key, removed: removeWatch(root, key) };
  }
  const watch: ReviewVerifyWatch = {
    ...coordinates,
    sessionId,
    addedAt: new Date().toISOString(),
  };
  addWatch(root, watch);
  return { action: 'add', watch };
}

export const verifyWatchCommand: CommandModule = {
  command: 'verify-watch [pr]',
  describe:
    'Watch a PR for a clean approval and hand each such head to a /verify-pr --publish round, whoever the reviewer was. With --list or --once it inspects or runs the observation instead of registering.',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        describe: 'The pull request to watch',
      })
      .option('repo', {
        type: 'string',
        describe: 'owner/repo the PR lives in',
      })
      .option('host', {
        type: 'string',
        describe:
          'The host the PR lives on. Required off GitHub; observation reads GitHub today, so other platforms are registered and declined with a reason.',
      })
      .option('remove', {
        type: 'boolean',
        default: false,
        describe: 'Stop watching this PR',
      })
      .option('list', {
        type: 'boolean',
        default: false,
        describe: 'Print the watch list and exit',
      })
      .option('once', {
        type: 'boolean',
        default: false,
        describe:
          'Run one observation pass now and print its outcomes — the same pass the daemon runs on its interval',
      })
      .option('session-id', {
        type: 'string',
        describe:
          "The session this watch belongs to. Defaults to QWEN_CODE_SESSION_ID; required, because the verification rounds become that session's sub-sessions and the watch ends when the session is deleted.",
      })
      .option('workspace-root', {
        type: 'string',
        describe:
          'The workspace the daemon serves (default: the working directory)',
      }),
  handler: async (argv) => {
    try {
      const result = await runVerifyWatch({
        pr: argv['pr'] as number | undefined,
        repo: argv['repo'] as string | undefined,
        host: argv['host'] as string | undefined,
        remove: argv['remove'] as boolean | undefined,
        list: argv['list'] as boolean | undefined,
        once: argv['once'] as boolean | undefined,
        sessionId: argv['session-id'] as string | undefined,
        workspaceRoot: argv['workspace-root'] as string | undefined,
      });
      writeStdoutLine(JSON.stringify(result));
      if (result.action === 'add') {
        writeStderrLineSafe(
          `verify-watch: watching ${result.watch.ownerRepo}#${result.watch.number} on ${result.watch.host}; the daemon hands off each head that comes back clean.`,
        );
      } else if (result.action === 'once') {
        for (const outcome of result.outcomes) {
          writeStderrLineSafe(
            `verify-watch: ${outcome.key} ${outcome.action} (${outcome.reason})`,
          );
        }
      }
    } catch (err) {
      writeStderrLineSafe(`verify-watch: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
