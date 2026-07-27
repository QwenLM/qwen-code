/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MoreHorizontalIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
 *
 * Host actions are mounted in exactly one place (inline or overflow) so
 * stateful action components are not duplicated for width measurement.
 */
export function PaneHeaderActions({
  children,
  trailing,
}: PaneHeaderActionsProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
  const preferredWidthRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const hasHostActions = children != null && children !== false;

  useLayoutEffect(() => {
    if (!hasHostActions) {
      preferredWidthRef.current = 0;
      setCollapsed(false);
      return;
    }

    const header = rootRef.current?.parentElement;
    if (!header) return;

    const update = () => {
      // Refresh natural width only while inline; when collapsed keep the last
      // measured value so we can decide when to expand again without a second
      // React mount of the host actions.
      if (inlineRef.current) {
        preferredWidthRef.current = inlineRef.current.scrollWidth;
      }
      const needed = preferredWidthRef.current;
      // Skip until the inline row has a real width — jsdom and the first
      // paint often report 0, which would otherwise force a false collapse
      // and unmount host actions into a closed menu.
      if (needed === 0) {
        setCollapsed(false);
        return;
      }
      const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
      const headerGap = 8; // matches `.header { gap }`
      const actionsGap = trailingWidth > 0 ? 4 : 0; // matches `.headerActions`
      const style = getComputedStyle(header);
      const padding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      const workspaceTag = header.querySelector<HTMLElement>(
        '[data-web-shell-pane-workspace]',
      );
      const workspaceTagWidth = workspaceTag?.offsetWidth ?? 0;
      const workspaceTagGap = workspaceTagWidth > 0 ? headerGap : 0;
      const available =
        header.clientWidth -
        padding -
        workspaceTagWidth -
        workspaceTagGap -
        TITLE_MIN_WIDTH_PX -
        trailingWidth -
        headerGap -
        actionsGap;
      setCollapsed(needed > available);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    if (inlineRef.current) observer.observe(inlineRef.current);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => observer.disconnect();
    // Re-run when collapse flips so we can attach/detach the inline observer
    // after the single host-action mount moves between trees.
  }, [hasHostActions, collapsed]);

  return (
    <div
      ref={rootRef}
      className={styles.headerActions}
      data-testid="pane-header-actions"
    >
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
              <div className={styles.headerOverflowPanel}>
                {Children.toArray(children).map((child, index) =>
                  isValidElement(child) ? (
                    <DropdownMenuItem key={child.key ?? index} asChild>
                      {child}
                    </DropdownMenuItem>
                  ) : null,
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div
            ref={inlineRef}
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
