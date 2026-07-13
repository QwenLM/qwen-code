/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import styles from './ChatEditor.module.css';

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6 7.5v9M8.5 12h3.25A6.25 6.25 0 0 0 18 5.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function GitBranchIndicator({
  branch,
  ariaLabel,
}: {
  branch: string;
  ariaLabel: string;
}) {
  return (
    <output
      className={styles.gitBranchChip}
      title={branch}
      aria-label={ariaLabel}
      data-web-shell-git-branch
    >
      <span className={styles.gitBranchIcon}>
        <GitBranchIcon />
      </span>
      <span className={styles.gitBranchText}>{branch}</span>
    </output>
  );
}
