/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { UsersIcon } from 'lucide-react';
import styles from './AuthorAvatar.module.css';

/**
 * "This belongs to squad X": a small muted pill, the squad's counterpart to
 * AuthorAvatar. Used on a leader's and a member's author line, the leader's
 * no-action line and the live engagement bar, so a reader learns it once.
 *
 * Renders in exported transcripts: no collaboration strings here.
 */
export function SquadTag({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      className={[styles.squadTag, className].filter(Boolean).join(' ')}
      data-squad-tag={name}
      title={name}
    >
      <UsersIcon aria-hidden="true" className={styles.squadTagIcon} />
      <span className={styles.squadTagName}>{name}</span>
    </span>
  );
}
