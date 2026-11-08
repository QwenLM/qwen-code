const STORAGE_PREFIX = 'qwen.web-shell.sidebar.workspace-order:';

function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    order.push(entry);
  }
  return order;
}

export function readWorkspaceOrder(scope: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${scope}`);
    if (stored === null) return [];
    return normalizeOrder(JSON.parse(stored));
  } catch {
    return [];
  }
}

export function writeWorkspaceOrder(
  scope: string,
  cwds: readonly string[],
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${scope}`,
      JSON.stringify(normalizeOrder(cwds)),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

/**
 * Applies a stored cwd order. Known entries sort by their stored rank; entries
 * the order does not mention (a workspace added since it was written) keep
 * their incoming relative order after them, so a new workspace appends.
 */
export function orderWorkspaces<T extends { cwd: string }>(
  workspaces: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...workspaces];
  const rank = new Map(order.map((cwd, index) => [cwd, index]));
  const ranked: T[] = [];
  const unranked: T[] = [];
  for (const workspace of workspaces) {
    if (rank.has(workspace.cwd)) ranked.push(workspace);
    else unranked.push(workspace);
  }
  ranked.sort((left, right) => rank.get(left.cwd)! - rank.get(right.cwd)!);
  return [...ranked, ...unranked];
}

/** Swaps `cwd` with its neighbour; `undefined` when the move is out of range. */
export function moveWorkspace(
  orderedCwds: readonly string[],
  cwd: string,
  direction: -1 | 1,
): string[] | undefined {
  const index = orderedCwds.indexOf(cwd);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= orderedCwds.length) return undefined;
  const next = [...orderedCwds];
  next[index] = orderedCwds[target]!;
  next[target] = orderedCwds[index]!;
  return next;
}
