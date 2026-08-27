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
  merged: { Icon: GitMergeIcon, className: styles.sessionPrStateMerged },
  closed: {
    Icon: GitPullRequestClosedIcon,
    className: styles.sessionPrStateClosed,
  },
} as const;

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
