/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for fetching a URL.
 *
 * The default is to ask, offering to remember the host (`WebFetch(host)`) —
 * the same rule the confirmation dialog labels "Always allow <host>". A URL
 * matches a rule by its hostname, and by the hostname with its path; a bare
 * `*` rule remembers the whole tool and matches every URL.
 */

import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { suggestAllow, type ToolPermissionReason } from '../checker-reasons.js';
import {
  checkContentRules,
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import {
  stringField,
  webFetchRuleCandidates,
} from '../content-checkers.js';

/**
 * `isPreapprovedHost` stays with the tool rather than moving here: the list of
 * well-known documentation domains is WebFetch's own policy, and the tool passes
 * the verdict in through this checker's factory.
 */
export function createWebFetchToolChecker(
  toolName: string,
  isPreapprovedHost: (hostname: string, pathname: string) => boolean,
): HostToolChecker {
  return {
    check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      const url = stringField(input, 'url');
      if (!url) {
        return {
          kind: 'deny',
          extra: {
            decisionPoint: 'web_fetch.no_url.deny',
            denialReason: {
              message: 'No URL was provided, so it cannot be checked.',
              attribution: { type: 'other', reason: 'fetch without a url' },
              denialKind: 'permission-rule',
              decisionPoint: 'web_fetch.no_url.deny',
            },
          },
        };
      }

      const candidates = webFetchRuleCandidates(url);
      const byContentRule = checkContentRules(
        toolName,
        ctx,
        (content) => candidates.includes(content),
        {
          deny: 'web_fetch.rule.deny',
          ask: 'web_fetch.rule.ask',
          allow: 'web_fetch.rule.allow',
        },
      );
      if (byContentRule) {
        return byContentRule;
      }

      // Preapproved documentation hosts run after rules, so a user deny or ask
      // rule still wins over the built-in list.
      try {
        const parsed = new URL(url);
        if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
          return {
            kind: 'allow',
            extra: { decisionPoint: 'web_fetch.preapproved_host.allow' },
          };
        }
      } catch {
        // Unparseable URL: fall through to the prompt, where the user sees it.
      }

      return {
        kind: 'ask',
        reason: {
          message: `Fetch ${url}?`,
          attribution: { type: 'other', reason: 'no rule covers this host' },
          decisionPoint: 'web_fetch.no_rule.ask',
        },
        // Nobody objected — the prompt exists only because nobody vouched. A
        // tool-level allow (`WebFetch`, from --allowed-tools / settings / the
        // legacy `WebFetch(*)` this prompt used to persist) therefore fills it.
        extra: { fillableByAllow: true },
        // Persisting this suggestion must cover the same URL next time, so it
        // names the host the dialog says it will remember — not the whole tool.
        suggestions: [
          suggestAllow({ toolName, ruleContent: candidates[0] ?? '*' }),
        ],
      };
    },
  };
}
