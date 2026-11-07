/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { useI18n } from '../../i18n';
import styles from './WebShellSidebar.module.css';

export interface SessionRenameEditorProps {
  label: string;
  /** Restores an in-progress draft after the row moves or remounts. */
  initialName?: string;
  /** Records the draft outside the editor so a remount cannot lose it. */
  onDraftChange?: (displayName: string) => void;
  onCommit: (displayName: string) => void;
  onCancel: () => void;
}

/**
 * Keeps the draft local to the input. Lifting it into WebShellSidebar made
 * every keystroke rebuild the whole (fully expanded) session list, because
 * the row renderer depends on the sidebar's editing state.
 */
export function SessionRenameEditor({
  label,
  initialName,
  onDraftChange,
  onCommit,
  onCancel,
}: SessionRenameEditorProps) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName ?? label);
  return (
    <form
      className={styles.renameForm}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(name);
      }}
    >
      <input
        autoFocus
        aria-label={`${t('sidebar.rename')}: ${label}`}
        className={styles.renameInput}
        maxLength={256}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          onDraftChange?.(event.target.value);
        }}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </form>
  );
}
