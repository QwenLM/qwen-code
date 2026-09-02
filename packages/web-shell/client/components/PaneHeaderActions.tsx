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

const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], input[type="button"], input[type="submit"], summary';

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

function actionMenuLabelFromProps(
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

function actionSlot(
  host: HTMLElement | null,
  index: number,
): HTMLElement | null {
  const slot = host?.querySelector(
    `[data-pane-header-action-index="${index}"]`,
  );
  return slot instanceof HTMLElement ? slot : null;
}

function interactiveInSlot(slot: HTMLElement): HTMLElement {
  return slot.querySelector<HTMLElement>(INTERACTIVE_SELECTOR) ?? slot;
}

/**
 * Text content of an element, ignoring `aria-hidden` subtrees so a decorative
 * glyph never becomes an action's accessible name.
 */
function visibleText(element: HTMLElement): string {
  let text = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      if (child.getAttribute('aria-hidden') === 'true') return;
      for (const grandchild of Array.from(child.childNodes)) walk(grandchild);
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? '';
    }
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return text.trim();
}

/** Prefer the mounted DOM label so opaque custom components still get a name. */
function resolveActionLabel(
  host: HTMLElement | null,
  index: number,
  element: ReactElement,
  defaultLabel: string,
): ReactNode {
  const slot = actionSlot(host, index);
  if (slot) {
    const target = interactiveInSlot(slot);
    const ariaLabel = target.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const title = target.getAttribute('title');
    if (title) return title;
    const text = visibleText(target);
    if (text) return text;
  }
  return actionMenuLabelFromProps(element, defaultLabel);
}

function activateHostAction(host: HTMLElement | null, index: number): void {
  const slot = actionSlot(host, index);
  if (!slot) return;
  interactiveInSlot(slot).click();
}

/**
 * Whether a slot holds an interactive element the overflow menu can proxy a
 * click to. A non-interactive child (e.g. an `aria-hidden` separator) would
 * show as a dead menu item, so it is left out. An absent slot is treated as
 * activatable so a real action is never dropped before its host renders.
 */
function slotIsActivatable(host: HTMLElement | null, index: number): boolean {
  const slot = actionSlot(host, index);
  if (!slot) return true;
  return slot.querySelector(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Renders pane-header host actions inline when they fit, otherwise collapses
 * them into a `…` menu. Measures against the header width so split-pane
 * resizing / add-remove does not crush the title.
 *
 * Host actions stay mounted in one host slot across collapse so stateful
 * actions are not reset. Each action is wrapped in a stable slot; the overflow
 * menu proxies clicks to the interactive descendant inside that slot so opaque
 * host components do not need to forward internal props.
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
  const defaultActionLabel = t('splitView.defaultActionLabel');

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
      const actionsStyle = rootRef.current
        ? getComputedStyle(rootRef.current)
        : null;
      const actionsGap =
        trailingWidth > 0 ? parseFloat(actionsStyle?.gap ?? '') || 0 : 0;
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
  }, [hasHostActions]);

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
              className={styles.headerActionSlot}
              data-pane-header-action-index={String(index)}
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
              {actionElements.map((element, index) => {
                if (!slotIsActivatable(hostRef.current, index)) return null;
                return (
                  <DropdownMenuItem
                    key={element.key ?? `pane-header-menu-${index}`}
                    onSelect={() => {
                      activateHostAction(hostRef.current, index);
                    }}
                  >
                    {resolveActionLabel(
                      hostRef.current,
                      index,
                      element,
                      defaultActionLabel,
                    )}
                  </DropdownMenuItem>
                );
              })}
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
