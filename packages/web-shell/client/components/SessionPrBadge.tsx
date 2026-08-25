/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionPrInfo } from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
import { useExternalLinkOpener } from '../hooks/useExternalLinkOpener';
import { isExternalOpenUrl } from '../utils/externalOpen';
import styles from './SessionPrBadge.module.css';

interface SessionPrBadgeProps {
  /** Bound PRs in binding order (last = latest). */
  prs: DaemonSessionPrInfo[];
  /**
   * Override when the badge sits inside a listbox `role="option"` row that
   * owns roving-tabindex keyboard navigation (e.g. picker dialogs).
   */
  tabIndex?: number;
}

/**
 * The `#N (+M)` pull-request badge shared by the sidebar session row, the
 * session overview card, and the picker dialogs. Renders the latest bound
 * PR with an overflow count and opens it through the desktop-aware
 * external-link opener. Non-http(s) bindings are filtered out as a
 * defense-in-depth measure on top of the daemon-side validators.
 */
export function SessionPrBadge({ prs, tabIndex }: SessionPrBadgeProps) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const openable = prs.filter((pr) => isExternalOpenUrl(pr.url));
  if (openable.length === 0) return null;
  const latest = openable[openable.length - 1];
  const multiple = openable.length > 1;
  const label = multiple
    ? t('sidebar.sessionPrMultiple', {
        number: latest.number,
        count: openable.length,
      })
    : t('sidebar.sessionPr', { number: latest.number });
  return (
    <a
      className={styles.sessionPrBadge}
      href={latest.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={multiple ? label : latest.url}
      {...(tabIndex !== undefined ? { tabIndex } : {})}
      onClick={(event) => {
        event.stopPropagation();
        openExternalLink(event, latest.url);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Only swallow Enter — the badge must not block roving-listbox
        // navigation keys (ArrowUp/Down/Home/End/Space) in picker dialogs.
        // Enter would otherwise activate the native anchor on top of the
        // dialog's confirm handling.
        if (event.key === 'Enter') event.stopPropagation();
      }}
    >
      #{latest.number}
      {multiple ? ` +${openable.length - 1}` : ''}
    </a>
  );
}
