/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { t } from '../../i18n/index.js';
import { C } from './theme.js';

export interface CopiedNotice {
  /** Monotonic id so a new copy restarts the timer. */
  id: number;
  text: string;
}

export interface CopyNoticeToastProps {
  notice: CopiedNotice | null;
  /** Root-bottom offset; stacked above the jump hint. */
  bottom: number;
  onExpire: (id: number) => void;
}

/** Transient confirmation shown after a selection auto-copy. */
export function CopyNoticeToast({
  notice,
  bottom,
  onExpire,
}: CopyNoticeToastProps) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => onExpire(notice.id), 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, onExpire]);

  if (!notice) return null;

  const count = Array.from(notice.text).length;
  return (
    <box
      position="absolute"
      right={2}
      bottom={bottom}
      zIndex={710}
      backgroundColor={C.bg ?? C.hover}
    >
      <text
        fg={C.green}
      >{` ${t('Copied {{count}} chars', { count: String(count) })} `}</text>
    </box>
  );
}
