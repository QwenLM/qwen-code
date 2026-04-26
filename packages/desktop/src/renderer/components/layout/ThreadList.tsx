/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopSessionSummary } from '../../api/client.js';
import { formatSessionDisplayTitle } from './formatters.js';
import { OpenThreadIcon } from './SidebarIcons.js';

export function ThreadList({
  activeSessionId,
  isDraftSession,
  sessions,
  onSelect,
}: {
  activeSessionId: string | null;
  isDraftSession: boolean;
  sessions: DesktopSessionSummary[];
  onSelect: (sessionId: string) => void;
}) {
  if (!isDraftSession && sessions.length === 0) {
    return <div className="empty-row">No sessions</div>;
  }

  return (
    <div
      className="session-list"
      aria-label="Threads"
      data-testid="thread-list"
    >
      {isDraftSession ? (
        <div
          className="session-row session-row-active session-row-draft"
          role="status"
        >
          <span className="session-row-title">New thread</span>
          <span className="session-row-trailing">
            <span className="session-ring" aria-hidden="true" />
            <span className="session-row-meta">draft</span>
          </span>
        </div>
      ) : null}
      {sessions.map((session) => {
        const meta = formatSessionMeta(session);
        const title = formatSessionDisplayTitle(session.title);
        const accessibleLabel = meta ? `${title}, ${meta}` : title;

        return (
          <button
            aria-label={accessibleLabel}
            className={
              session.sessionId === activeSessionId
                ? 'session-row session-row-active'
                : 'session-row'
            }
            data-testid="thread-row"
            key={session.sessionId}
            onClick={() => onSelect(session.sessionId)}
            title={title}
            type="button"
          >
            <span className="session-row-title">{title}</span>
            <span className="session-row-trailing">
              {session.sessionId === activeSessionId ? (
                <span className="session-ring" aria-hidden="true" />
              ) : (
                <OpenThreadIcon className="session-open-icon" />
              )}
              {meta ? <span className="session-row-meta">{meta}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function formatSessionMeta(session: DesktopSessionSummary): string | null {
  const age = formatSessionAge(session.updatedAt);
  if (age) {
    return age;
  }

  return session.models?.currentModelId
    ? shortenModelId(session.models.currentModelId)
    : null;
}

function formatSessionAge(updatedAt: string | undefined): string | null {
  if (!updatedAt) {
    return null;
  }

  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return isChineseLocale() ? '刚刚' : 'now';
  }

  if (elapsedMs < hourMs) {
    return formatAgeUnit(Math.floor(elapsedMs / minuteMs), 'm', '分');
  }

  if (elapsedMs < dayMs) {
    return formatAgeUnit(Math.floor(elapsedMs / hourMs), 'h', '小时');
  }

  return formatAgeUnit(Math.floor(elapsedMs / dayMs), 'd', '天');
}

function formatAgeUnit(
  value: number,
  englishUnit: string,
  chineseUnit: string,
) {
  return isChineseLocale()
    ? `${value} ${chineseUnit}`
    : `${value}${englishUnit}`;
}

function isChineseLocale(): boolean {
  return /^zh(?:-|$)/iu.test(globalThis.navigator?.language ?? '');
}

function shortenModelId(modelId: string): string {
  const normalized = modelId.split('/').pop() ?? modelId;
  return normalized.length > 12 ? `${normalized.slice(0, 11)}...` : normalized;
}
