/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isValidSessionPrUrl,
  readSessionPrs,
  upsertSessionPrs,
  type SessionPrState,
} from '@qwen-code/qwen-code-core/services/session-pr-service.js';
import { fetchPullRequestByReference } from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';

// Mirrors the backfill's number bound: PR 0 does not exist and leading
// zeros keep number→url round-trips unambiguous.
const BARE_PR_NUMBER_PATTERN = /^[1-9]\d{0,8}$/;

// Best-effort archive resolution shared by the listing and binding paths:
// a location-query failure keeps the default active location (mirrors the
// shell binder).
async function resolveArchiveState(
  sessionService: {
    getSessionLocation(id: string): Promise<string | undefined>;
  },
  sessionId: string,
): Promise<'active' | 'archived'> {
  try {
    if ((await sessionService.getSessionLocation(sessionId)) === 'archived') {
      return 'archived';
    }
  } catch {
    // Best-effort — keep the default active location.
  }
  return 'active';
}

/**
 * Manual PR binding for the cases the automatic paths deliberately miss
 * (an internal-`cd` create, a taken-over PR, a background run). Explicit
 * user intent is the authority — the same level as the REST metadata
 * PATCH — so gh resolves the canonical url/state but never gates the
 * binding: a full URL survives a gh failure without state, and the
 * daemon's refresh sweep resolves it later.
 */
export const prCommand: SlashCommand = {
  name: 'pr',
  get description() {
    return t('Bind a GitHub pull request to this session');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint: '<number | url>',
  action: async (context, args) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }
    const sessionService = config.getSessionService();
    const sessionId = config.getSessionId();
    const input = args.trim();

    if (!input) {
      const archiveState = await resolveArchiveState(sessionService, sessionId);
      let prs: Awaited<ReturnType<typeof readSessionPrs>> = null;
      try {
        prs = await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(
            sessionId,
            archiveState,
          ),
        );
      } catch {
        prs = null;
      }
      const usage = t('Usage: /pr <number | url>');
      const content =
        prs && prs.length > 0
          ? `${t('Bound PRs: {{list}}', {
              list: prs
                .map((pr) => `#${pr.number}${pr.state ? ` (${pr.state})` : ''}`)
                .join(', '),
            })}\n${usage}`
          : `${t('No PRs bound to this session.')}\n${usage}`;
      return { type: 'message', messageType: 'info', content };
    }

    let number: number;
    let inputUrl: string | undefined;
    if (BARE_PR_NUMBER_PATTERN.test(input)) {
      number = Number(input);
    } else {
      const parsed = GitWorktreeService.parsePRReference(input);
      if (parsed === null) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Invalid PR reference. Usage: /pr <number | url>'),
        };
      }
      number = parsed;
      if (/^https?:\/\//i.test(input)) inputUrl = input;
    }

    const resolved = await fetchPullRequestByReference(
      config.getTargetDir(),
      inputUrl ?? String(number),
    );
    let binding: { number: number; url: string; state?: SessionPrState };
    if (resolved) {
      binding = resolved;
    } else if (inputUrl && isValidSessionPrUrl(inputUrl)) {
      binding = { number, url: inputUrl };
    } else {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Could not resolve PR #{{number}} via gh. Pass the full PR URL instead.',
          { number: String(number) },
        ),
      };
    }

    try {
      // Re-resolve the archive location immediately before the locked
      // mutation, mirroring the shell binder: an archive transition must
      // not strand the binding on a resurrected active sidecar.
      const archiveState = await resolveArchiveState(sessionService, sessionId);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      const applied = await upsertSessionPrs(prPath, [
        { ...binding, source: 'create' },
      ]);
      if (applied.added.includes(binding.number)) {
        sessionService.emitSessionPrBound(sessionId, {
          number: binding.number,
          url: binding.url,
        });
        return {
          type: 'message',
          messageType: 'info',
          content: t('Bound PR #{{number}} to this session.', {
            number: String(binding.number),
          }),
        };
      }
      if (applied.alreadyBound.includes(binding.number)) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('PR #{{number}} is already bound to this session.', {
            number: String(binding.number),
          }),
        };
      }
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to bind PR #{{number}}.', {
          number: String(binding.number),
        }),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to bind PR #{{number}}: {{message}}', {
          number: String(binding.number),
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
