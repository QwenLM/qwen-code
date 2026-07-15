/**
 * Shared localStorage helpers for Web Shell session-organization collapse
 * state. Primary sidebar and per-workspace sections both write into one app
 * key so preferences survive reload without competing overwrites.
 *
 * Id conventions:
 * - Primary catalog: `group:<id>`, `recent`, `color:<name>`
 * - Workspace-scoped: `ws:<workspaceId>|group:<id>`, `ws:<workspaceId>|ungrouped`
 */

export const COLLAPSED_SESSION_SECTIONS_STORAGE_KEY =
  'qwen-code-web-shell-collapsed-session-groups';

const WORKSPACE_SECTION_PREFIX = 'ws:';

export function isPrimaryCollapsedSectionId(id: string): boolean {
  return !id.startsWith(WORKSPACE_SECTION_PREFIX);
}

export function workspaceGroupSectionId(
  workspaceId: string,
  groupId: string,
): string {
  return `${WORKSPACE_SECTION_PREFIX}${workspaceId}|group:${groupId}`;
}

export function workspaceUngroupedSectionId(workspaceId: string): string {
  return `${WORKSPACE_SECTION_PREFIX}${workspaceId}|ungrouped`;
}

export function isWorkspaceCollapsedSectionId(
  workspaceId: string,
  id: string,
): boolean {
  return id.startsWith(`${WORKSPACE_SECTION_PREFIX}${workspaceId}|`);
}

export function readCollapsedSessionSectionIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
    );
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      ),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedSessionSectionIds(
  ids: ReadonlySet<string>,
): void {
  try {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(Array.from(ids).sort()),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

/**
 * Replace one owner's subset of collapsed ids while preserving other owners
 * (primary vs per-workspace), so parallel writers do not clobber each other.
 */
export function replaceOwnedCollapsedSessionSectionIds(
  ownedIds: ReadonlySet<string>,
  isOwned: (id: string) => boolean,
): void {
  const stored = readCollapsedSessionSectionIds();
  const next = new Set(Array.from(stored).filter((id) => !isOwned(id)));
  for (const id of ownedIds) next.add(id);
  writeCollapsedSessionSectionIds(next);
}

export function readWorkspaceCollapsedGroupIds(
  workspaceId: string,
): Set<string> {
  const stored = readCollapsedSessionSectionIds();
  const local = new Set<string>();
  const groupPrefix = `${WORKSPACE_SECTION_PREFIX}${workspaceId}|group:`;
  const ungroupedId = workspaceUngroupedSectionId(workspaceId);
  for (const id of stored) {
    if (id === ungroupedId) {
      local.add('ungrouped');
    } else if (id.startsWith(groupPrefix)) {
      local.add(id.slice(groupPrefix.length));
    }
  }
  return local;
}

export function writeWorkspaceCollapsedGroupIds(
  workspaceId: string,
  localIds: ReadonlySet<string>,
): void {
  const owned = new Set<string>();
  for (const id of localIds) {
    owned.add(
      id === 'ungrouped'
        ? workspaceUngroupedSectionId(workspaceId)
        : workspaceGroupSectionId(workspaceId, id),
    );
  }
  replaceOwnedCollapsedSessionSectionIds(owned, (id) =>
    isWorkspaceCollapsedSectionId(workspaceId, id),
  );
}
