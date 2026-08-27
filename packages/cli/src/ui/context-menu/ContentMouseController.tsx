/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { useStdout } from 'ink';
import {
  createDebugLogger,
  openBrowserSecurely,
} from '@qwen-code/qwen-code-core';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  getScreenBuffer,
  type ScreenBuffer,
} from '../selection/screen-buffer.js';
import { getSelectedText } from '../selection/selection-text.js';
import {
  terminalToGrid,
  snapWideChar,
  pointInViewport,
  type ViewportRect,
} from '../selection/selection-coords.js';
import type { Point } from '../selection/selection-state.js';
import { hyperlinkAtCell } from '../utils/hyperlink-at.js';
import {
  useContextMenu,
  contextMenuSize,
  clampMenuPosition,
  type ContextMenuItem,
} from './ContextMenuContext.js';
import type { SelectionQuery } from '../selection/use-text-selection.js';

export interface ContentMouseControllerProps {
  /** Only handled while active (VP mode, no dialog open). */
  isActive: boolean;
  /** Reads the history viewport rect at event time (may be null early). */
  getViewportRect: () => ViewportRect | null;
  hitTestScrollbar: (location: { col: number; row: number }) => boolean;
  /** Live selection query for the "Copy Selection" item (optional). */
  selectionQueryRef?: MutableRefObject<SelectionQuery | null>;
}

const debugLogger = createDebugLogger('CONTENT_MOUSE');

/**
 * Headless controller restoring the two mouse capabilities SGR tracking takes
 * from the terminal in VP mode:
 *
 * - **Ctrl+click opens OSC 8 links.** The URL is read from the composited
 *   frame cell under the pointer (ink preserves the OSC 8 escape in per-cell
 *   styles), so no markdown re-parsing or column math is involved. Ctrl is the
 *   single app-detectable gesture matching VTE/Windows Terminal conventions;
 *   Shift/Option stay reserved for the documented terminal-selection bypass,
 *   and plain clicks keep their exact current behavior.
 * - **Right-click opens a context menu** (Open Link / Copy Link Address over a
 *   link, Copy Selection over an active selection), rendered by
 *   {@link ContextMenuOverlay}.
 *
 * While the menu is open this controller also owns its mouse interaction
 * (hover highlight, click-to-execute, dismiss on outside press / scroll) and
 * upgrades tracking to `'any'` so bare pointer motion reaches it.
 */
export function ContentMouseController(
  props: ContentMouseControllerProps,
): null {
  const { stdout } = useStdout();
  const { columns, rows } = useTerminalSize();
  const menu = useContextMenu();
  const bufferRef = useRef<ScreenBuffer | undefined>(undefined);
  const ctrlPressRef = useRef<Point | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const getBuffer = useCallback((): ScreenBuffer | undefined => {
    if (!bufferRef.current) {
      bufferRef.current = getScreenBuffer(stdout);
    }
    return bufferRef.current;
  }, [stdout]);

  /** 1-based terminal cell → wide-char-snapped composited-frame point. */
  const mapPoint = useCallback(
    (event: MouseEvent): Point | null => {
      const buffer = getBuffer();
      if (!buffer) return null;
      const frameHeight = buffer.dimensions.height;
      const terminalHeight =
        (stdout as unknown as { rows?: number }).rows ?? frameHeight;
      const point = terminalToGrid(
        event.col,
        event.row,
        terminalHeight,
        frameHeight,
      );
      return snapWideChar(buffer.frame, point);
    },
    [getBuffer, stdout],
  );

  // Degrade an unopenable link to a clipboard copy with a user-visible hint
  // (mirrors openBrowserSecurely's own manual-open warning) — intentionally
  // console.warn, not the debug logger.
  const fallbackCopy = useCallback((url: string) => {
    void copyToClipboard(url)
      .then(() => {
        // eslint-disable-next-line no-console
        console.warn(
          `Link copied to clipboard (not openable directly): ${url}`,
        );
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`Unable to copy link to clipboard: ${url}`);
        debugLogger.warn('Clipboard copy failed:', error);
      });
  }, []);

  const openLink = useCallback(
    (url: string) => {
      if (/^https?:\/\//i.test(url)) {
        // openBrowserSecurely still rejects http(s) URLs that fail strict
        // validation (e.g. `https://` with no host — wrappable by the
        // markdown renderer); catch so a crafted link cannot surface an
        // unhandled rejection.
        void openBrowserSecurely(url).catch(() => fallbackCopy(url));
        return;
      }
      // OSC 8 also allows mailto:/ftp:/ssh: targets, which
      // openBrowserSecurely rejects by policy.
      fallbackCopy(url);
    },
    [fallbackCopy],
  );

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      const openMenuState = menu.menu;

      // ── Menu open: own all mouse interaction ──────────────────────────
      if (openMenuState) {
        const { position, items } = openMenuState;
        const size = contextMenuSize(items);
        const inMenu = (p: Point): boolean =>
          p.x >= position.x &&
          p.x < position.x + size.width &&
          p.y >= position.y &&
          p.y < position.y + size.height;
        const itemIndexOf = (p: Point): number => p.y - position.y - 1;

        if (event.name === 'move') {
          const p = mapPoint(event);
          if (p && inMenu(p)) {
            const index = itemIndexOf(p);
            if (index >= 0 && index < items.length) {
              menu.setSelectedIndex(index);
            }
          }
          return;
        }
        if (event.name === 'left-press') {
          const p = mapPoint(event);
          if (p && inMenu(p)) {
            const index = itemIndexOf(p);
            if (index >= 0 && index < items.length) {
              menu.executeIndex(index);
              return;
            }
          }
          menu.closeMenu();
          return;
        }
        if (event.name.startsWith('scroll-')) {
          menu.closeMenu();
          return;
        }
        if (event.name === 'right-press') {
          // Close, then fall through and re-open at the new cell.
          menu.closeMenu();
        } else if (event.name.endsWith('-press')) {
          // Any other press outside the menu (e.g. middle-press) dismisses
          // it. Releases are ignored so the right-release that opened the
          // menu cannot close it again.
          menu.closeMenu();
          return;
        } else {
          return;
        }
      }

      // A pending Ctrl+press anchors to a grid cell, but scrolling swaps the
      // content that cell carries (and streaming reflow moves it too), so any
      // wheel tick invalidates the anchor. A move outside the viewport or over
      // the scrollbar is still a drag, so both cancels run before those early
      // returns.
      if (event.name.startsWith('scroll-')) {
        ctrlPressRef.current = null;
        return;
      }
      if (event.name === 'move' && event.button !== 'none') {
        // A pointer move with a button held cancels the pending Ctrl+click
        // (it is a Ctrl+drag). Bare motion is ignored: while the menu is
        // open this controller upgrades to 'any' tracking, so bare moves
        // stream in without any button involved.
        ctrlPressRef.current = null;
        return;
      }

      const rect = propsRef.current.getViewportRect();
      if (!rect) return;
      if (
        propsRef.current.hitTestScrollbar({ col: event.col, row: event.row })
      ) {
        return;
      }
      const point = mapPoint(event);
      if (!point || !pointInViewport(point, rect)) return;

      // ── Right-click: build and open the context menu ─────────────────
      if (event.name === 'right-press') {
        const frame = getBuffer()?.frame ?? null;
        const items: ContextMenuItem[] = [];
        const url = hyperlinkAtCell(frame, point.x, point.y);
        if (url) {
          items.push({
            id: 'open-link',
            label: 'Open Link',
            onSelect: () => openLink(url),
          });
          items.push({
            id: 'copy-link',
            label: 'Copy Link Address',
            onSelect: () => {
              void copyToClipboard(url).catch((error: unknown) => {
                debugLogger.warn('Failed to copy link address:', error);
              });
            },
          });
        }
        const range = propsRef.current.selectionQueryRef?.current?.getRange();
        if (range) {
          // Snapshot the selected text now rather than at execute time: the
          // frame can keep streaming while the menu is open, and re-deriving
          // a stale range against new cells would copy the wrong text.
          const selectionText = getSelectedText(frame, range);
          if (selectionText) {
            items.push({
              id: 'copy-selection',
              label: 'Copy Selection',
              onSelect: () => {
                void copyToClipboard(selectionText).catch((error: unknown) => {
                  debugLogger.warn('Failed to copy selected text:', error);
                });
              },
            });
          }
        }
        if (items.length === 0) return;
        // Clamp to the composited frame, not the raw terminal: the overlay
        // can only paint inside the frame, and when the frame overflows the
        // terminal the visible grid rows start below zero-row.
        const frameHeight = getBuffer()?.dimensions.height ?? rows;
        const visibleTop = Math.max(0, frameHeight - rows);
        const position = clampMenuPosition(
          { x: point.x, y: Math.max(point.y, visibleTop) },
          contextMenuSize(items),
          columns,
          frameHeight,
        );
        menu.openMenu(items, position);
        return;
      }

      // ── Ctrl+click: open the OSC 8 link under the pointer ────────────
      if (event.name === 'left-press' && event.ctrl) {
        ctrlPressRef.current = point;
        return;
      }
      if (event.name === 'left-release' && event.ctrl) {
        const press = ctrlPressRef.current;
        ctrlPressRef.current = null;
        if (!press || press.x !== point.x || press.y !== point.y) return;
        const url = hyperlinkAtCell(
          getBuffer()?.frame ?? null,
          point.x,
          point.y,
        );
        if (url) {
          openLink(url);
        }
        return;
      }
    },
    [menu, mapPoint, getBuffer, openLink, columns, rows],
  );

  // Hover needs bare-motion events (?1003h), which only the open menu wants;
  // stay on the cheaper button level otherwise.
  useMouseEvents(handleMouse, {
    isActive: props.isActive,
    tracking: menu.menu !== null ? 'any' : 'button',
  });

  // Close a stranded menu when the controller deactivates (a dialog opening
  // mid-interaction) or unmounts (a view switch removing MainContent while
  // the menu is open). Without this the menu stays rendered — provider-level
  // state that outlives its owner — while every mouse consumer stays quieted
  // for an overlay nobody can dismiss except Esc.
  const { closeMenu } = menu;
  const isActive = props.isActive;
  useEffect(() => {
    if (!isActive) {
      closeMenu();
    }
    return () => {
      closeMenu();
    };
  }, [isActive, closeMenu]);

  // The position clamp runs once, at open time. A resize while open can push
  // the menu outside the composited frame where it renders invisibly — yet
  // menu !== null keeps every VP mouse consumer quiet, and the still-mounted
  // overlay's keypress handler would execute the invisible item on Enter.
  // Close on any dimension change instead.
  const prevSizeRef = useRef({ columns, rows });
  useEffect(() => {
    const prev = prevSizeRef.current;
    prevSizeRef.current = { columns, rows };
    if (prev.columns !== columns || prev.rows !== rows) {
      closeMenu();
    }
  }, [columns, rows, closeMenu]);

  return null;
}
