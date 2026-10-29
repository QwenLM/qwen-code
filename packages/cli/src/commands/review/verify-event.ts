/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review verify-event`: the producer-neutral entrance to the clean-review
// handoff.
//
// The built-in producer (`save-artifact`) only fires when qwen-code ran the
// review itself. A review performed by another agent, a human, or a CI job
// leaves no qwen-code artifact — so this command lets ANY producer record the
// same durable event, and the daemon's consumer treats it identically.
//
// The caller asserts two facts it is responsible for: which head was reviewed,
// and that the round found no Critical. Nothing here re-reads the platform: the
// command is offline by construction, so a producer can hand off without
// credentials, and the daemon does not need to be running yet (the event is
// durable and is picked up whenever it next is).
//
// With no `--session-id` and no QWEN_CODE_SESSION_ID in the environment, the
// consumer spawns a top-level automation session instead of a sub-session —
// an external producer has no qwen-code session to be the parent.

import type { CommandModule } from 'yargs';
import { resolve } from 'node:path';
import { HOSTNAME_RE, isOwnerRepo } from './lib/gh.js';
import { detectPlatformKind } from './lib/platform/registry.js';
import { emitReviewCleanEvent } from './lib/review-events.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

/** The head shape the event reader accepts, normalized to lowercase. */
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;

export interface VerifyEventArgs {
  pr: number;
  repo: string;
  head: string;
  host?: string;
  event?: string;
  round?: number;
  reviewedBy?: string;
  sessionId?: string;
  workspaceRoot?: string;
}

export interface VerifyEventResult {
  path: string;
  eventId: string;
  platform: string;
  host: string;
}

export function runVerifyEvent(args: VerifyEventArgs): VerifyEventResult {
  // Usage errors surface before anything is written: a malformed coordinate
  // can never be fixed by retrying, and exit 2 is the caller's "repair the
  // invocation" signal (the same contract `review meta` uses).
  if (!Number.isInteger(args.pr) || args.pr < 1) {
    throw new TypeError(
      `--pr must be a positive integer, got ${JSON.stringify(args.pr)}`,
    );
  }
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(
      `expected --repo owner/repo, got ${JSON.stringify(args.repo)}`,
    );
  }
  const head = args.head.trim().toLowerCase();
  if (!HEAD_SHA_RE.test(head)) {
    throw new TypeError(
      `--head must be a 7-64 character hex commit sha, got ${JSON.stringify(args.head)}`,
    );
  }
  const event = args.event ?? 'APPROVE';
  if (event !== 'APPROVE' && event !== 'COMMENT') {
    throw new TypeError(
      `--event must be APPROVE or COMMENT — a round that requested changes is not a clean round, got ${JSON.stringify(args.event)}`,
    );
  }
  const round = args.round ?? 1;
  if (!Number.isInteger(round) || round < 1) {
    throw new TypeError(
      `--round must be a positive integer, got ${JSON.stringify(args.round)}`,
    );
  }
  const hostFlag = args.host?.trim() || undefined;
  if (hostFlag !== undefined && !HOSTNAME_RE.test(hostFlag)) {
    throw new TypeError(
      `--host is not a hostname: ${JSON.stringify(args.host)}`,
    );
  }
  const platform = detectPlatformKind({ host: hostFlag });
  // Off GitHub there is no default host. Emitting `platform: 'aone'` beside
  // `host: 'github.com'` would hand the consumer a contradiction — the same
  // refusal `review meta` makes.
  const host = hostFlag ?? (platform === 'github' ? 'github.com' : undefined);
  if (!host) {
    throw new TypeError(
      `a ${platform} target needs --host — there is no default host off GitHub`,
    );
  }
  const workspaceRoot = resolve(args.workspaceRoot?.trim() || process.cwd());
  const sessionId =
    args.sessionId?.trim() ||
    process.env['QWEN_CODE_SESSION_ID']?.trim() ||
    undefined;
  const emitted = emitReviewCleanEvent({
    workspaceRoot,
    target: {
      platform,
      host,
      ownerRepo: args.repo,
      number: args.pr,
      headSha: head,
    },
    round,
    // This entrance IS the clean assertion; a caller that counted a Critical
    // has nothing to hand off, and the reader refuses such a record anyway.
    verdict: { event, critical: 0, suggestion: 0 },
    reviewedBy: args.reviewedBy?.trim() || 'external-cli',
    sessionId,
  });
  return { ...emitted, platform, host };
}

export const verifyEventCommand: CommandModule = {
  command: 'verify-event',
  describe:
    "Record that a PR head was reviewed clean, so the daemon starts a /verify-pr --publish round for it. Callable by any producer — qwen-code's own review, another agent, or a script; offline, and the daemon need not be running yet.",
  builder: (yargs) =>
    yargs
      .option('pr', {
        type: 'number',
        demandOption: true,
        describe: 'The pull request number that was reviewed',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'owner/repo the PR lives in',
      })
      .option('head', {
        type: 'string',
        demandOption: true,
        describe:
          'The commit sha the review actually read — one verification per head, so a later round at the same sha does not spawn a second one',
      })
      .option('host', {
        type: 'string',
        describe:
          'The host the PR lives on. Required off GitHub (there is no default); omitted on GitHub means github.com. Only github.com targets are spawned today.',
      })
      .option('event', {
        type: 'string',
        choices: ['APPROVE', 'COMMENT'],
        default: 'APPROVE',
        describe: 'The verdict the review reached',
      })
      .option('round', {
        type: 'number',
        default: 1,
        describe: 'The review round, for the record',
      })
      .option('reviewed-by', {
        type: 'string',
        describe:
          'Who performed the review (an agent name, a person, a CI job). Recorded because the handoff publishes a public comment.',
      })
      .option('session-id', {
        type: 'string',
        describe:
          'The qwen-code session that ran the review, when there was one. Defaults to QWEN_CODE_SESSION_ID; without it the daemon spawns a top-level automation session.',
      })
      .option('workspace-root', {
        type: 'string',
        describe:
          'The workspace the daemon serves (default: the working directory). The event is keyed on this root, so it must be the same checkout the daemon runs in.',
      }),
  handler: (argv) => {
    try {
      const result = runVerifyEvent({
        pr: argv['pr'] as number,
        repo: argv['repo'] as string,
        head: argv['head'] as string,
        host: argv['host'] as string | undefined,
        event: argv['event'] as string | undefined,
        round: argv['round'] as number | undefined,
        reviewedBy: argv['reviewed-by'] as string | undefined,
        sessionId: argv['session-id'] as string | undefined,
        workspaceRoot: argv['workspace-root'] as string | undefined,
      });
      writeStdoutLine(JSON.stringify(result));
      writeStderrLineSafe(
        `verify-event: recorded ${result.platform}:${result.host} ${argv['repo']}#${argv['pr']} at ${String(argv['head']).trim().toLowerCase()}; the daemon spawns /verify-pr when it next reads this workspace.`,
      );
    } catch (err) {
      writeStderrLineSafe(`verify-event: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
