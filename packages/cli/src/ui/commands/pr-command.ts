/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isValidSessionPrUrl,
  readSessionPrsDetailed,
  upsertSessionPrs,
  type SessionPrState,
} from '@qwen-code/qwen-code-core/services/session-pr-service.js';
import {
  fetchPullRequestByReference,
  pullRequestViewUrl,
} from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { t } from '../../i18n/index.js';
import { CommandKind, type SlashCommand } from './types.js';

// Mirrors the backfill's number bound: PR 0 does not exist and leading
// zeros keep number→url round-trips unambiguous.
const BARE_PR_NUMBER_PATTERN = /^[1-9]\d{0,8}$/;

// Archive resolution shared by the listing and binding paths. A location
// that cannot be resolved — a rejected head read, or an active/archived
// conflict — is reported as 'unresolved': list mode must not turn it into an
// authoritative "No PRs bound" (the archive transition may have moved the
// sidecar), while the bind path keeps the active default, where writing to a
// resurrected active sidecar mirrors the shell post-hook and is recoverable.
// An absent head (undefined) is a session with no transcript yet and defaults
// to active.
async function resolveArchiveState(
  sessionService: {
    getSessionLocation(id: string): Promise<string | undefined>;
  },
  sessionId: string,
): Promise<'active' | 'archived' | 'unresolved'> {
  try {
    const location = await sessionService.getSessionLocation(sessionId);
    if (location === 'archived') return 'archived';
    if (location === 'conflict') return 'unresolved';
    return 'active';
  } catch {
    return 'unresolved';
  }
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
      const usage = t('Usage: /pr <number | url>');
      // A failed or corrupt read is not an authoritative "no bindings":
      // collapsing it into the empty-list message would tell the user
      // their bindings were never recorded.
      const unreadable = {
        type: 'message',
        messageType: 'error',
        content: `${t('Could not read the PR bindings for this session.')}\n${usage}`,
      } as const;
      // An unresolved archive location is not an authoritative "no bindings".
      if (archiveState === 'unresolved') return unreadable;
      try {
        const result = await readSessionPrsDetailed(
          sessionService.getPrSessionPathForArchiveState(
            sessionId,
            archiveState,
          ),
        );
        if (result.status === 'invalid') return unreadable;
        const content =
          result.status === 'ok' && result.prs.length > 0
            ? `${t('Bound PRs: {{list}}', {
                list: result.prs
                  .map(
                    (pr) => `#${pr.number}${pr.state ? ` (${pr.state})` : ''}`,
                  )
                  .join(', '),
              })}\n${usage}`
            : `${t('No PRs bound to this session.')}\n${usage}`;
        return { type: 'message', messageType: 'info', content };
      } catch {
        return unreadable;
      }
    }

    let number: number;
    let inputUrl: string | undefined;
    const invalidReference = {
      type: 'message',
      messageType: 'error',
      content: t('Invalid PR reference. Usage: /pr <number | url>'),
    } as const;
    if (BARE_PR_NUMBER_PATTERN.test(input)) {
      number = Number(input);
    } else {
      const parsed = GitWorktreeService.parsePRReference(input);
      if (parsed === null) return invalidReference;
      number = parsed;
      if (/^https?:\/\//i.test(input)) {
        // Fail closed when the spelling cannot be canonicalized: the looser
        // parsePRReference match accepts /PULL/ and percent-encoded owners
        // that pullRequestViewUrl rejects, and forwarding the raw input would
        // hand gh — and, on a gh failure, the sidecar, the reply text and the
        // catalog notification — a URL that may carry credentials. Never fall
        // back to the raw input.
        const canonical = pullRequestViewUrl(input);
        if (canonical === undefined) return invalidReference;
        inputUrl = canonical;
      }
    }

    const resolved = await fetchPullRequestByReference(
      config.getTargetDir(),
      // inputUrl is already the rebuilt canonical URL, so no /files, query,
      // or credential-bearing spelling reaches the child argv or its logs.
      inputUrl ?? String(number),
    );
    let binding: { number: number; url: string; state?: SessionPrState };
    if (resolved.status === 'pr') {
      binding = {
        number: resolved.number,
        url: resolved.url,
        state: resolved.state,
      };
    } else if (inputUrl && isValidSessionPrUrl(inputUrl)) {
      // inputUrl is already the canonical /pull/<N> spelling, so a later
      // re-bind of the same PR matches the same sidecar key. The number must
      // come from that same canonical URL, not the raw parse: a dot-segment
      // spelling (/pull/5/../6) normalizes to /pull/6, and the raw matcher's
      // 5 would otherwise name a different PR than the stored url. The
      // /pull/<N> shape pullRequestViewUrl guarantees makes this parse total.
      binding = {
        number: GitWorktreeService.parsePRReference(inputUrl)!,
        url: inputUrl,
      };
    } else {
      // Environmental failures (gh missing, timeout) get their own message:
      // advising a PR-specific remedy for them sends the user hunting for
      // an access problem that does not exist.
      return {
        type: 'message',
        messageType: 'error',
        content:
          resolved.reason === 'failed'
            ? t(
                'Could not resolve PR #{{number}} via gh. Pass the full PR URL instead.',
                { number: String(number) },
              )
            : t(
                'GitHub CLI (gh) is unavailable or timed out. Pass the full PR URL to bind without it.',
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
        // The bind path keeps the active default when the location could not
        // be resolved (mirrors the shell post-hook; recoverable).
        archiveState === 'unresolved' ? 'active' : archiveState,
      );
      const applied = await upsertSessionPrs(prPath, [
        { ...binding, source: 'create' },
      ]);
      // Announce any applied write — a newly added binding OR an already-bound
      // re-bind, which may have repaired a stale state in place. Without the
      // already-bound arm a live client keeps rendering the stale badge.
      if (
        applied.added.includes(binding.number) ||
        applied.alreadyBound.includes(binding.number)
      ) {
        try {
          sessionService.emitSessionPrBound(sessionId, {
            number: binding.number,
            url: binding.url,
          });
        } catch {
          // Best-effort notification: the binding is already persisted; a
          // catalog-mark failure must not read as a bind failure (mirrors
          // the shell binder). The next catalog refresh picks it up.
        }
      }
      if (applied.added.includes(binding.number)) {
        // The URL is part of the message: a bare number resolves in the
        // session's target-directory repository, so printing only the
        // number would hide a wrong-repository bind (there is no unbind).
        return {
          type: 'message',
          messageType: 'info',
          content: t('Bound PR #{{number}} to this session: {{url}}', {
            number: String(binding.number),
            url: binding.url,
          }),
        };
      }
      if (applied.alreadyBound.includes(binding.number)) {
        return {
          type: 'message',
          messageType: 'info',
          content: t(
            'PR #{{number}} is already bound to this session: {{url}}',
            {
              number: String(binding.number),
              url: binding.url,
            },
          ),
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
