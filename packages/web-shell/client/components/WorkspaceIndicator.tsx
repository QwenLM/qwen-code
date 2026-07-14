/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import styles from './ChatEditor.module.css';

function WorkspaceFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v8A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A compact, non-interactive chip naming the workspace a split-view pane's
 * session belongs to. Mirrors {@link GitBranchIndicator}; both sit in the
 * composer toolbar. Shown only on a multi-workspace daemon (the pane composer
 * opts into the `workspace` toolbar action) so it's clear which workspace a
 * message goes to.
 */
export function WorkspaceIndicator({
  name,
  title,
  ariaLabel,
  compact = false,
}: {
  name: string;
  title: string;
  ariaLabel: string;
  compact?: boolean;
}) {
  return (
    <output
      className={`${styles.workspaceChip} ${
        compact ? styles.workspaceChipCompact : ''
      }`}
      title={title}
      aria-label={ariaLabel}
      data-web-shell-workspace
    >
      <span className={styles.workspaceChipIcon}>
        <WorkspaceFolderIcon />
      </span>
      <span className={styles.workspaceChipText}>{name}</span>
    </output>
  );
}
