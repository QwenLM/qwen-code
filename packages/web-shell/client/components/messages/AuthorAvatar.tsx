/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CSSProperties } from 'react';
import styles from './AuthorAvatar.module.css';

/**
 * The initial of a named assistant voice, tinted with its color when it has
 * one. The same mark stands for an agent in its replies, the Team panel and
 * the Agents page, so a reader learns it once.
 */
export function AuthorAvatar({
  name,
  color,
  size = 'sm',
  className,
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden="true"
      className={[styles.avatar, styles[size], className]
        .filter(Boolean)
        .join(' ')}
      data-tinted={color ? 'true' : undefined}
      style={color ? ({ '--author-color': color } as CSSProperties) : undefined}
    >
      {initial}
    </span>
  );
}
