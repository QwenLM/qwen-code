/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * agentForest — pure helpers for rendering nested sub-agents as a tree
 * in the tasks panel.
 *
 * Sub-agents may spawn sub-agents (bounded by `maxSubagentDepth`), and every
 * agent in the tree appears in the same flat tasks snapshot
 * (`DaemonSessionTasksStatus`, polled from `GET /session/:id/tasks`). These
 * helpers turn that flat roster into a parent-grouped display order plus
 * per-row tree metadata, without assuming the full tree is visible: entries
 * appear and leave the snapshot independently (foreground agents unregister
 * on completion, registries cap retained terminal entries), so every function
 * here treats a missing parent as a normal case, not an error.
 *
 * The reorder is a post-pass over an already-sorted list on purpose: the
 * panel sorts active-then-terminal, and a tree can span those buckets — a
 * running parent with a just-completed child, or vice versa. Grouping
 * children under whichever position their parent already earned preserves
 * the sort semantics for roots while keeping trees contiguous.
 *
 * Focused port of the TUI's helpers
 * (`packages/cli/src/ui/components/background-view/agent-forest.ts`); no
 * package importable from both surfaces exists, so the two files share
 * semantics via their collocated tests. Keep behavior changes in sync.
 */

/**
 * Minimal structural view of a task entry — satisfied by
 * `DaemonSessionTaskStatus` union members, so the helpers stay decoupled
 * from the SDK types. For agent tasks `id` IS the agent id (the daemon
 * serializer guarantees it), which is what `parentAgentId` references.
 */
export interface AgentForestNode {
  kind: string;
  id?: string;
  parentAgentId?: string | null;
  isBackgrounded?: boolean;
}

/** Per-agent tree metadata for row rendering. */
export interface AgentTreeInfo {
  /**
   * Structural depth among the *visible* entries (0 = rendered at root
   * level). An agent whose ancestors left the snapshot renders closer to
   * the root than its launch depth — the tree indents only what the user
   * can actually see, so connectors never dangle.
   */
  visibleDepth: number;
  /**
   * True when the entry claims a parent (`parentAgentId` set) that is not
   * in the visible set — the row is promoted to root level and annotated
   * ("from <parent>") instead of indented under nothing.
   */
  orphaned: boolean;
}

// Indent clamp shared with the row renderer: deep trees stop indenting past
// this level so the label column survives narrow panels; the detail view's
// level line carries the exact depth beyond the clamp.
export const TREE_INDENT_MAX_LEVELS = 3;

function isAgentNode<T extends AgentForestNode>(e: T): e is T & { id: string } {
  return e.kind === 'agent' && typeof e.id === 'string';
}

/**
 * Regroups agent entries so each agent renders directly beneath its parent
 * (depth-first), while every non-agent entry keeps its exact position: the
 * k-th agent slot in the input is filled by the k-th agent of the grouped
 * order. Agents whose parent is absent (top-level, departed parent, or a
 * parent-cycle) keep their original relative order as roots; siblings keep
 * their original relative order under their parent.
 */
export function reorderChildrenUnderParents<T extends AgentForestNode>(
  entries: readonly T[],
): T[] {
  const agents = entries.filter(isAgentNode);

  const byId = new Map<string, T>();
  for (const agent of agents) byId.set(agent.id, agent);

  const childrenOf = new Map<string, Array<T & { id: string }>>();
  const roots: Array<T & { id: string }> = [];
  for (const agent of agents) {
    const pid = agent.parentAgentId;
    if (pid != null && pid !== agent.id && byId.has(pid)) {
      const siblings = childrenOf.get(pid);
      if (siblings) siblings.push(agent);
      else childrenOf.set(pid, [agent]);
    } else {
      roots.push(agent);
    }
  }
  if (childrenOf.size === 0) return [...entries];

  const ordered: T[] = [];
  const visited = new Set<string>();
  const visit = (node: T & { id: string }) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    for (const child of childrenOf.get(node.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Parent-cycles never reach a root; append the members in input order
  // rather than dropping rows.
  for (const agent of agents) {
    if (!visited.has(agent.id)) {
      visited.add(agent.id);
      ordered.push(agent);
    }
  }

  let next = 0;
  return entries.map((e) => (isAgentNode(e) ? ordered[next++] : e));
}

/** How an ancestor walk ended — see {@link ancestorChain}. */
export type AncestorTermination = 'root' | 'missing' | 'cycle';

/**
 * Walks `node`'s parent chain through `lookup`, collecting the ancestors
 * that are actually present (immediate parent first). The walk stops —
 * without error, per the module contract — at a top-level ancestor
 * (`'root'`), at a departed/unknown parent id (`'missing'`), or on a
 * repeated id (`'cycle'`). Single home of the eviction/cycle policy shared
 * by tree depth and the `[blocking]` verdict.
 */
export function ancestorChain<T extends AgentForestNode>(
  node: AgentForestNode,
  lookup: (id: string) => T | undefined,
): { chain: T[]; terminatedBy: AncestorTermination } {
  const chain: T[] = [];
  const seen = new Set<string>(node.id != null ? [node.id] : []);
  let pid = node.parentAgentId;
  for (;;) {
    if (pid == null) return { chain, terminatedBy: 'root' };
    if (seen.has(pid)) return { chain, terminatedBy: 'cycle' };
    const parent = lookup(pid);
    if (!parent) return { chain, terminatedBy: 'missing' };
    seen.add(pid);
    chain.push(parent);
    pid = parent.parentAgentId;
  }
}

/**
 * Computes {@link AgentTreeInfo} for every agent entry in the visible set.
 * Depth is the length of the parent chain that is actually present.
 */
export function computeAgentTreeInfo(
  entries: readonly AgentForestNode[],
): Map<string, AgentTreeInfo> {
  const byId = new Map<string, AgentForestNode>();
  for (const e of entries) if (isAgentNode(e)) byId.set(e.id, e);

  const info = new Map<string, AgentTreeInfo>();
  for (const e of byId.values()) {
    const { chain, terminatedBy } = ancestorChain(e, (id) => byId.get(id));
    info.set(e.id!, {
      // Cycle members are appended flat at root level by
      // reorderChildrenUnderParents — mirror that here, otherwise the row
      // would indent under no rendered parent.
      visibleDepth: terminatedBy === 'cycle' ? 0 : chain.length,
      // Orphaned = claims a parent but its IMMEDIATE parent is gone. A
      // deeper break (grandparent departed) still renders indented under
      // the present parent, so only a zero-length 'missing' chain counts.
      orphaned: chain.length === 0 && terminatedBy === 'missing',
    });
  }
  return info;
}

/**
 * The agent ids whose cancellation would end the USER's current turn — a
 * foreground entry whose entire ancestor chain is foreground up to the
 * top-level session. A foreground child awaited by a *background* parent
 * blocks that parent, not the user, so it is not tagged; the `[blocking]`
 * warning exists solely to flag "cancelling this ends your turn". When the
 * chain cannot be proven (departed ancestor, cycle), the entry is not
 * tagged — a missing warning is a milder failure than a wrong one.
 */
export function computeUserBlockingIds(
  entries: readonly AgentForestNode[],
): Set<string> {
  const byId = new Map<string, AgentForestNode>();
  for (const e of entries) if (isAgentNode(e)) byId.set(e.id, e);

  const blocking = new Set<string>();
  for (const e of byId.values()) {
    if (e.isBackgrounded !== false) continue;
    const { chain, terminatedBy } = ancestorChain(e, (id) => byId.get(id));
    if (
      terminatedBy === 'root' &&
      chain.every((ancestor) => ancestor.isBackgrounded === false)
    ) {
      blocking.add(e.id!);
    }
  }
  return blocking;
}
