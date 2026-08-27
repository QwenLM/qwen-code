/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionPrInfo } from '@qwen-code/sdk/daemon';
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from 'lucide-react';
import styles from './SessionPrStateIcon.module.css';

const STATE_ICONS = {
  open: { Icon: GitPullRequestIcon, className: styles.sessionPrStateOpen },
  merged: {
    Icon: GitMergeIcon,
    className: styles.sessionPrStateMerged,
    labelKey: 'sidebar.sessionPrStateMerged',
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    className: styles.sessionPrStateClosed,
    labelKey: 'sidebar.sessionPrStateClosed',
  },
} as const satisfies Record<
  NonNullable<DaemonSessionPrInfo['state']>,
  { Icon: typeof GitPullRequestIcon; className: string; labelKey?: string }
>;

/**
 * GitHub-style PR state icon shared by the session-row badge and the session
 * details tooltip: open=green pull-request, merged=purple merge, closed=red
 * closed-pull-request. A state-less binding renders the neutral pull-request
 * glyph with no state color.
 */
export function SessionPrStateIcon({
  state,
}: {
  state?: DaemonSessionPrInfo['state'];
}) {
  const entry = state ? STATE_ICONS[state] : undefined;
  const Icon = entry?.Icon ?? GitPullRequestIcon;
  return (
    <Icon
      aria-hidden="true"
      {...(entry ? { className: entry.className } : {})}
    />
  );
}

/**
 * Localized state name for assistive tech (badge aria-label, tooltip sr-only
 * text). Only merged/closed carry a label; open and state-less bindings read
 * as the bare PR reference. Keyed beside STATE_ICONS so a new state forces
 * both the icon and the label mapping to be updated together.
 */
export function sessionPrStateLabel(
  t: (key: string) => string,
  state?: DaemonSessionPrInfo['state'],
): string | undefined {
  if (state !== 'merged' && state !== 'closed') return undefined;
  return t(STATE_ICONS[state].labelKey);
}
