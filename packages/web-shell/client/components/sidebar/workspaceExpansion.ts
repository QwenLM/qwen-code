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
