/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontalIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { useI18n } from '../i18n';
import styles from './ChatPane.module.css';

/** Minimum width reserved for the truncating pane title. */
const TITLE_MIN_WIDTH_PX = 64;

export interface PaneHeaderActionsProps {
  /** Host-provided actions for this pane; omit or null when none. */
  children?: ReactNode;
  /** Built-in trailing controls (e.g. close) that stay outside the overflow. */
  trailing?: ReactNode;
}

/**
 * Renders pane-header host actions inline when they fit, otherwise collapses
 * them into a `…` menu. Measures against the header width so split-pane
 * resizing / add-remove does not crush the title.
 */
export function PaneHeaderActions({
  children,
  trailing,
}: PaneHeaderActionsProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const hasHostActions = children != null && children !== false;

  useLayoutEffect(() => {
    if (!hasHostActions) {
      setCollapsed(false);
      return;
    }

    const header = rootRef.current?.parentElement;
    const measure = measureRef.current;
    if (!header || !measure) return;

    const update = () => {
      const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
      const headerGap = 8; // matches `.header { gap }`
      const actionsGap = trailingWidth > 0 ? 4 : 0; // matches `.headerActions`
      const style = getComputedStyle(header);
      const padding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      // Compare natural host-action width against space left after the title
      // minimum and trailing built-ins. The overflow trigger is not part of
      // this budget so collapsing cannot oscillate at the threshold.
      const available =
        header.clientWidth -
        padding -
        TITLE_MIN_WIDTH_PX -
        trailingWidth -
        headerGap -
        actionsGap;
      setCollapsed(measure.scrollWidth > available);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(measure);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => observer.disconnect();
  }, [hasHostActions, children]);

  return (
    <div
      ref={rootRef}
      className={styles.headerActions}
      data-testid="pane-header-actions"
    >
      {hasHostActions && (
        <div
          ref={measureRef}
          className={styles.headerActionsMeasure}
          aria-hidden
          data-testid="pane-header-actions-measure"
        >
          {children}
        </div>
      )}

      {hasHostActions &&
        (collapsed ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={styles.headerActionButton}
                aria-label={t('splitView.morePaneActions')}
                title={t('splitView.morePaneActions')}
                data-testid="pane-header-overflow"
              >
                <MoreHorizontalIcon size={16} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-auto min-w-40"
              data-testid="pane-header-overflow-menu"
            >
              <div className={styles.headerOverflowPanel}>{children}</div>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div
            className={styles.headerActionsInline}
            data-testid="pane-header-actions-inline"
          >
            {children}
          </div>
        ))}

      {trailing != null && (
        <div ref={trailingRef} className={styles.headerTrailing}>
          {trailing}
        </div>
      )}
    </div>
  );
}
