/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { FolderIcon } from 'lucide-react';
import styles from './WorkspacePill.module.css';

interface WorkspacePillProps {
  /** The workspace cwd, shown as the tooltip. */
  cwd: string;
  /** Display label (already disambiguated by the caller when needed). */
  label: string;
}

/** Compact workspace badge shared by the Goals and Scheduled Tasks pages. */
export function WorkspacePill({ cwd, label }: WorkspacePillProps) {
  return (
    <span className={styles.workspacePill} title={cwd}>
      <span className={styles.workspaceIcon} aria-hidden="true">
        <FolderIcon />
      </span>
      <span className={styles.workspaceName}>{label}</span>
    </span>
  );
}
