/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

const STORAGE_PREFIX = 'qwen.web-shell.sidebar.session-tree-expanded:';

export interface SessionTreeOptions {
  expandedParentIds?: ReadonlySet<string>;
  /**
   * Parent ids rendered expanded regardless of the stored toggle. A search
   * uses this so a matched child is never hidden behind a collapsed parent.
   */
  forceExpandedParentIds?: ReadonlySet<string>;
  /**
   * Keep rows whose parent is not in the list. A search needs them, because
   * hiding an unanchored match would make it unreachable; a group section
   * needs them because a child can land in a different group than its parent.
   * The default flat list leaves them out so derived sessions do not reappear
   * as flat siblings.
   */
  includeUnanchoredChildren?: boolean;
  /**
   * Parent ids rendered by another surface (the Pinned section). Their children
   * keep their flat rows here instead of disappearing behind a parent row that
   * this list does not render.
   */
  flattenChildrenOf?: ReadonlySet<string>;
}

export interface SessionTreeRow {
  session: DaemonSessionSummary;
  depth: 0 | 1;
  childCount: number;
  expanded: boolean;
}

/** Tree state a session row needs to render its chevron and indentation. */
export interface SessionTreeRenderOptions {
  depth: 0 | 1;
  childCount: number;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Orders a page of sessions so derived sessions render under their spawner.
 * The daemon caps nesting at one level, so the result never has a depth above
 * one. A child is emitted right after its parent and only when the parent is
 * expanded; roots keep the page's activity order.
 */
export function buildSessionTree(
  sessions: readonly DaemonSessionSummary[],
  options: SessionTreeOptions = {},
): SessionTreeRow[] {
  const expandedParentIds = options.expandedParentIds;
  const forceExpandedParentIds = options.forceExpandedParentIds;
  const rootIds = new Set<string>();
  for (const session of sessions) {
    if (!session.parentSessionId) rootIds.add(session.sessionId);
  }
  const childrenByParent = new Map<string, DaemonSessionSummary[]>();
  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (!parentId || !rootIds.has(parentId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session);
    childrenByParent.set(parentId, children);
  }

  const rows: SessionTreeRow[] = [];
  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (!parentId) {
      const children = childrenByParent.get(session.sessionId) ?? [];
      const expanded =
        children.length > 0 &&
        (expandedParentIds?.has(session.sessionId) === true ||
          forceExpandedParentIds?.has(session.sessionId) === true);
      rows.push({
        session,
        depth: 0,
        childCount: children.length,
        expanded,
      });
      if (!expanded) continue;
      for (const child of children) {
        rows.push({ session: child, depth: 1, childCount: 0, expanded: false });
      }
      continue;
    }
    // A child whose parent is in the page was already emitted under it.
    if (rootIds.has(parentId)) continue;
    if (
      !options.includeUnanchoredChildren &&
      options.flattenChildrenOf?.has(parentId) !== true
    ) {
      continue;
    }
    rows.push({ session, depth: 0, childCount: 0, expanded: false });
  }
  return rows;
}

export function readSessionTreeExpanded(storageId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${storageId}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeSessionTreeExpanded(
  storageId: string,
  parentIds: ReadonlySet<string>,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${storageId}`,
      JSON.stringify([...parentIds]),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}
