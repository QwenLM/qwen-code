/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * agent-forest — pure helpers for rendering nested sub-agents as a tree.
 *
 * Sub-agents may spawn sub-agents (bounded by `maxSubagentDepth`), and every
 * agent in the tree registers in the same flat `BackgroundTaskRegistry`. These
 * helpers turn that flat roster into a parent-grouped display order plus
 * per-row tree metadata, without assuming the full tree is visible: rows
 * appear and evict independently (terminal rows leave the LiveAgentPanel
 * after a few seconds, registries cap retained terminal entries), so every
 * function here treats a missing parent as a normal case, not an error.
 *
 * The reorder is a post-pass over an already-sorted list on purpose. The
 * surfaces sort differently (the dialog sorts active-then-terminal, the
 * panel renders oldest-first) and a tree can span those buckets — a running
 * parent with a just-completed child, or vice versa. Grouping children under
 * whichever position their parent already earned preserves each surface's
 * sort semantics for roots while keeping trees contiguous.
 */

/**
 * Minimal structural view of a task entry — satisfied by both `AgentTask`
 * (registry entries) and the CLI's `DialogEntry` union, so the helpers can
 * be shared without importing either type (and without a type cycle between
 * this module and the view-model hook).
 */
export interface AgentForestNode {
  kind: string;
  agentId?: string;
  parentAgentId?: string | null;
  isBackgrounded?: boolean;
}

/** Per-agent tree metadata for row rendering. */
export interface AgentTreeInfo {
  /**
   * Structural depth among the *visible* entries (0 = rendered at root
   * level). An agent whose ancestors were evicted renders closer to the
   * root than its launch depth — the tree indents only what the user can
   * actually see, so connectors never dangle.
   */
  visibleDepth: number;
  /**
   * True when the entry claims a parent (`parentAgentId` set) that is not
   * in the visible set — the row is promoted to root level and annotated
   * ("from <parent>") instead of indented under nothing.
   */
  orphaned: boolean;
}

function isAgentNode<T extends AgentForestNode>(
  e: T,
): e is T & { agentId: string } {
  return e.kind === 'agent' && typeof e.agentId === 'string';
}

/**
 * Regroups agent entries so each agent renders directly beneath its parent
 * (depth-first), while every non-agent entry keeps its exact position: the
 * k-th agent slot in the input is filled by the k-th agent of the grouped
 * order. Agents whose parent is absent (top-level, evicted parent, or a
 * parent-cycle) keep their original relative order as roots; siblings keep
 * their original relative order under their parent.
 */
export function reorderChildrenUnderParents<T extends AgentForestNode>(
  entries: readonly T[],
): T[] {
  const agents = entries.filter(isAgentNode);

  const byId = new Map<string, T>();
  for (const agent of agents) byId.set(agent.agentId, agent);

  const childrenOf = new Map<string, Array<T & { agentId: string }>>();
  const roots: Array<T & { agentId: string }> = [];
  for (const agent of agents) {
    const pid = agent.parentAgentId;
    if (pid != null && pid !== agent.agentId && byId.has(pid)) {
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
  const visit = (node: T & { agentId: string }) => {
    if (visited.has(node.agentId)) return;
    visited.add(node.agentId);
    ordered.push(node);
    for (const child of childrenOf.get(node.agentId) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Parent-cycles never reach a root; append the members in input order
  // rather than dropping rows.
  for (const agent of agents) {
    if (!visited.has(agent.agentId)) {
      visited.add(agent.agentId);
      ordered.push(agent);
    }
  }

  let next = 0;
  return entries.map((e) => (isAgentNode(e) ? ordered[next++] : e));
}

/**
 * The LiveAgentPanel's row order: the snapshot arrives newest-first (the
 * dialog convention), the panel renders oldest-first, then groups each
 * nested agent under its parent. Shared with the composer's panel-focus
 * keyboard handler (InputPrompt), which resolves `livePanelSelectedIndex`
 * against this list — the two MUST use the same transform or Enter opens
 * the wrong agent's detail.
 */
export function panelDisplayOrder<T extends AgentForestNode>(
  visibleNewestFirst: readonly T[],
): T[] {
  return reorderChildrenUnderParents([...visibleNewestFirst].reverse());
}

/** How an ancestor walk ended — see {@link ancestorChain}. */
export type AncestorTermination = 'root' | 'missing' | 'cycle';

/**
 * Walks `node`'s parent chain through `lookup`, collecting the ancestors
 * that are actually present (immediate parent first). The walk stops —
 * without error, per the module contract — at a top-level ancestor
 * (`'root'`), at an evicted/unknown parent id (`'missing'`), or on a
 * repeated id (`'cycle'`). Single home of the eviction/cycle policy shared
 * by tree depth, the `[blocking]` verdict, and the detail-view breadcrumb.
 */
export function ancestorChain<T extends AgentForestNode>(
  node: AgentForestNode,
  lookup: (id: string) => T | undefined,
): { chain: T[]; terminatedBy: AncestorTermination } {
  const chain: T[] = [];
  const seen = new Set<string>(node.agentId != null ? [node.agentId] : []);
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
  for (const e of entries) if (isAgentNode(e)) byId.set(e.agentId, e);

  const info = new Map<string, AgentTreeInfo>();
  for (const e of byId.values()) {
    const { chain, terminatedBy } = ancestorChain(e, (id) => byId.get(id));
    info.set(e.agentId!, {
      // Cycle members are appended flat at root level by
      // reorderChildrenUnderParents — mirror that here, otherwise the row
      // would indent under no rendered parent.
      visibleDepth: terminatedBy === 'cycle' ? 0 : chain.length,
      // Orphaned = claims a parent but its IMMEDIATE parent is gone. A
      // deeper break (grandparent evicted) still renders indented under
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
 * blocks that parent, not the user, so it is not tagged; the dialog's
 * `[blocking]` warning exists solely to flag "cancelling this ends your
 * turn". When the chain cannot be proven (evicted ancestor, cycle), the
 * entry is not tagged — a missing warning is a milder failure than a wrong
 * one.
 */
export function computeUserBlockingIds(
  entries: readonly AgentForestNode[],
): Set<string> {
  const byId = new Map<string, AgentForestNode>();
  for (const e of entries) if (isAgentNode(e)) byId.set(e.agentId, e);

  const blocking = new Set<string>();
  for (const e of byId.values()) {
    if (e.isBackgrounded !== false) continue;
    const { chain, terminatedBy } = ancestorChain(e, (id) => byId.get(id));
    if (
      terminatedBy === 'root' &&
      chain.every((ancestor) => ancestor.isBackgrounded === false)
    ) {
      blocking.add(e.agentId!);
    }
  }
  return blocking;
}

// ─── Row presentation shared by LiveAgentPanel and BackgroundTasksDialog ───

// Indent per nesting level, clamped so deep trees don't starve the
// description column on narrow terminals; the detail dialog's level badge
// carries the exact depth beyond the clamp.
export const TREE_INDENT_PER_LEVEL = '    ';
export const TREE_INDENT_MAX_LEVELS = 3;

/**
 * The tree gutter rendered before a row's status glyph: indent by visible
 * depth plus a `↳` marker on any row spawned by another agent. The marker
 * is kept even for orphans (parent already evicted, depth back at 0) so
 * "this was a nested agent" stays legible.
 */
export function treeRowPrefix(
  entry: AgentForestNode,
  tree: AgentTreeInfo | undefined,
): string {
  const indent = TREE_INDENT_PER_LEVEL.repeat(
    Math.min(tree?.visibleDepth ?? 0, TREE_INDENT_MAX_LEVELS),
  );
  const marker = entry.parentAgentId != null ? '↳ ' : '';
  return `${indent}${marker}`;
}

/**
 * Status → glyph vocabulary shared by the panel rows and the detail view's
 * Sub-agents roster: `○` for active slots (running keeps the list visually
 * uniform), distinct marks for terminal states, `⏸` for paused.
 */
export function statusGlyph(status: string): string {
  switch (status) {
    case 'running':
      return '○';
    case 'paused':
      return '⏸';
    case 'completed':
      return '✔';
    case 'failed':
    case 'cancelled':
      return '✖';
    default:
      return '○';
  }
}
