/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionService } from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import {
  buildSessionRef,
  SESSION_MENTION_PREFIX,
} from './session-mention-ref.js';
import { t } from '../../i18n/index.js';

const MAX_SESSION_SUGGESTIONS = 20;

/**
 * Lists prior sessions for the current project as `@` completion suggestions.
 * Scope is enforced by SessionService (current project only). A listing
 * failure yields an empty list so the Sessions tab simply shows nothing
 * rather than breaking file/MCP/extension completion.
 */
export async function getSessionSuggestions(
  cwd: string,
  pattern: string,
): Promise<Suggestion[]> {
  let items;
  try {
    const res = await new SessionService(cwd).listSessions({
      size: MAX_SESSION_SUGGESTIONS,
    });
    items = res.items;
  } catch {
    return [];
  }

  const stripped = pattern.startsWith(SESSION_MENTION_PREFIX)
    ? pattern.slice(SESSION_MENTION_PREFIX.length)
    : pattern;
  const needle = stripped.trim().toLowerCase();
  return items
    .map((s) => {
      const label = s.customTitle?.trim() || s.prompt || s.sessionId;
      const description = s.customTitle ? s.prompt : undefined;
      return {
        label,
        value: buildSessionRef(s.sessionId),
        description,
        sourceBadge: t('Session'),
        category: 'session' as const,
      } satisfies Suggestion;
    })
    .filter((sug) =>
      needle.length === 0
        ? true
        : `${sug.label} ${sug.description ?? ''}`
            .toLowerCase()
            .includes(needle),
    );
}
