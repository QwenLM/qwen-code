const STORAGE_PREFIX = 'qwen.web-shell.sidebar.workspace-expanded:';

export function hasWorkspaceExpansionPreference(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) !== null;
  } catch {
    return false;
  }
}

export function readWorkspaceExpanded(id: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) !== 'false';
  } catch {
    return true;
  }
}

export function writeWorkspaceExpanded(id: string, expanded: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, String(expanded));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

// The primary expansion id is keyed by the primary workspace cwd, which is
// only provisional until the registered workspace list lands. Move a
// preference written under the provisional id so the choice survives.
export function migrateWorkspaceExpansionPreference(
  previousId: string,
  nextId: string,
): void {
  if (typeof window === 'undefined' || previousId === nextId) return;
  try {
    const previousKey = `${STORAGE_PREFIX}${previousId}`;
    const nextKey = `${STORAGE_PREFIX}${nextId}`;
    const stored = window.localStorage.getItem(previousKey);
    if (stored === null) return;
    if (window.localStorage.getItem(nextKey) !== null) {
      // The registered preference already won; drop the superseded
      // provisional entry so it stops reading as a live preference.
      window.localStorage.removeItem(previousKey);
      return;
    }
    window.localStorage.setItem(nextKey, stored);
    window.localStorage.removeItem(previousKey);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}
