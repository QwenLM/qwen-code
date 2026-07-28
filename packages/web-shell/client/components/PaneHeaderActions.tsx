/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Children,
  Fragment,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
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

/** Flatten Fragments (and nested Fragments) into concrete action elements. */
function flattenActionElements(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (child.type === Fragment) {
      const fragmentChildren = (child.props as { children?: ReactNode })
        .children;
      out.push(...flattenActionElements(fragmentChildren));
      continue;
    }
    out.push(child);
  }
  return out;
}

function actionMenuLabel(
  element: ReactElement,
  defaultLabel: string,
): ReactNode {
  const props = element.props as {
    'aria-label'?: string;
    title?: string;
    children?: ReactNode;
  };
  if (props['aria-label']) return props['aria-label'];
  if (props.title) return props.title;
  if (
    props.children != null &&
    props.children !== false &&
    (typeof props.children === 'string' || typeof props.children === 'number')
  ) {
    return props.children;
  }
  return defaultLabel;
}

/**
 * Renders pane-header host actions inline when they fit, otherwise collapses
 * them into a `…` menu. Measures against the header width so split-pane
 * resizing / add-remove does not crush the title.
 *
 * Host actions stay mounted in one host slot across collapse so stateful
 * actions are not reset. The overflow menu uses menuitem proxies that click
 * those mounted hosts.
 */
export function PaneHeaderActions({
  children,
  trailing,
}: PaneHeaderActionsProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
  const preferredWidthRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const hasHostActions = children != null && children !== false;
  const actionElements = hasHostActions ? flattenActionElements(children) : [];

  useLayoutEffect(() => {
    if (!hasHostActions) {
      preferredWidthRef.current = 0;
      setCollapsed(false);
      return;
    }

    const header = rootRef.current?.parentElement;
    if (!header) return;

    const update = () => {
      if (hostRef.current) {
        preferredWidthRef.current = hostRef.current.scrollWidth;
      }
      const needed = preferredWidthRef.current;
      // Skip until the host row has a real width — jsdom and the first paint
      // often report 0, which would otherwise force a false collapse.
      if (needed === 0) {
        setCollapsed(false);
        return;
      }
      const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
      const style = getComputedStyle(header);
      const headerGap = parseFloat(style.gap) || 0;
      const actionsGap = trailingWidth > 0 ? 4 : 0; // matches `.headerActions`
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
    if (hostRef.current) observer.observe(hostRef.current);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => observer.disconnect();
  }, [hasHostActions, collapsed]);

  return (
    <div
      ref={rootRef}
      className={styles.headerActions}
      data-testid="pane-header-actions"
    >
      {hasHostActions && (
        <div
          ref={hostRef}
          className={
            collapsed
              ? styles.headerActionsHostHidden
              : styles.headerActionsInline
          }
          data-testid={
            collapsed
              ? 'pane-header-actions-host'
              : 'pane-header-actions-inline'
          }
          aria-hidden={collapsed || undefined}
        >
          {actionElements.map((element, index) => (
            <span
              key={element.key ?? `pane-header-action-${index}`}
              data-pane-header-action-index={String(index)}
              style={{ display: 'contents' }}
            >
              {element}
            </span>
          ))}
        </div>
      )}

      {hasHostActions && collapsed && (
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
              {actionElements.map((element, index) => (
                <DropdownMenuItem
                  key={element.key ?? `pane-header-menu-${index}`}
                  onSelect={() => {
                    const wrapper = hostRef.current?.querySelector(
                      `[data-pane-header-action-index="${index}"]`,
                    );
                    const target = wrapper?.firstElementChild;
                    if (target instanceof HTMLElement) target.click();
                  }}
                >
                  {actionMenuLabel(element, t('splitView.defaultActionLabel'))}
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {trailing != null && (
        <div ref={trailingRef} className={styles.headerTrailing}>
          {trailing}
        </div>
      )}
    </div>
  );
}
