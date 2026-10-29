/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  buildSessionTree,
  readSessionTreeExpanded,
  writeSessionTreeExpanded,
  type SessionTreeOptions,
  type SessionTreeRenderOptions,
  type SessionTreeRow,
} from './sessionTree';

export interface SessionTreeControllers {
  /** Rows for one surface (a flat list or one group section). */
  buildRows: (sessions: readonly DaemonSessionSummary[]) => SessionTreeRow[];
  /** Per-row state to hand to the session row renderer. */
  renderOptions: (row: SessionTreeRow) => SessionTreeRenderOptions;
}

/**
 * Expansion state for the sidebar's session tree, persisted per surface
 * (`storageId` is the workspace's sidebar storage id). Search results force
 * every matched parent open so a matched child is never hidden.
 */
export function useSessionTree(
  storageId: string,
  searchedSessions: readonly DaemonSessionSummary[],
  searchActive: boolean,
): SessionTreeControllers {
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(() =>
    readSessionTreeExpanded(storageId),
  );
  // The lazy initializer already read this id; only a real id change (the
  // sidebar switching its primary workspace) re-reads storage. Without the
  // guard the mount effect would replace the Set and re-render every row once
  // for nothing.
  const previousStorageIdRef = useRef(storageId);
  useEffect(() => {
    if (previousStorageIdRef.current === storageId) return;
    previousStorageIdRef.current = storageId;
    setExpandedParentIds(readSessionTreeExpanded(storageId));
  }, [storageId]);

  const toggle = useCallback(
    (parentId: string) => {
      setExpandedParentIds((current) => {
        const next = new Set(current);
        if (next.has(parentId)) next.delete(parentId);
        else next.add(parentId);
        writeSessionTreeExpanded(storageId, next);
        return next;
      });
    },
    [storageId],
  );

  const forcedExpandedParentIds = useMemo(() => {
    if (!searchActive) return undefined;
    const parents = new Set<string>();
    for (const session of searchedSessions) {
      if (session.parentSessionId) parents.add(session.parentSessionId);
    }
    return parents;
  }, [searchActive, searchedSessions]);

  const buildRows = useCallback(
    (sessions: readonly DaemonSessionSummary[]) => {
      const treeOptions: SessionTreeOptions = {
        expandedParentIds,
        ...(forcedExpandedParentIds
          ? { forceExpandedParentIds: forcedExpandedParentIds }
          : {}),
      };
      return buildSessionTree(sessions, treeOptions);
    },
    [expandedParentIds, forcedExpandedParentIds],
  );

  const renderOptions = useCallback(
    (row: SessionTreeRow): SessionTreeRenderOptions => ({
      depth: row.depth,
      childCount: row.childCount,
      expanded: row.expanded,
      onToggle: () => toggle(row.session.sessionId),
    }),
    [toggle],
  );

  return useMemo(
    () => ({ buildRows, renderOptions }),
    [buildRows, renderOptions],
  );
}
