export function managedRequestId(): string {
  return `managed_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

const clientIds = new Map<string, string>();

export function getManagedClientId(baseUrl: string): string {
  const key = `qwen-managed-client:${baseUrl.replace(/\/+$/, '')}`;
  let clientId = clientIds.get(key);
  try {
    clientId = localStorage.getItem(key) || clientId;
  } catch {
    // Storage can be disabled by the embedding host.
  }
  if (!clientId) clientId = managedRequestId();
  clientIds.set(key, clientId);
  try {
    localStorage.setItem(key, clientId);
  } catch {
    // Keep the correlation stable for this page lifetime.
  }
  return clientId;
}

export function managedSelectionFromUrl(): {
  open: boolean;
  sessionId?: string;
} {
  if (typeof window === 'undefined') return { open: false };
  const params = new URLSearchParams(window.location.search);
  return {
    open: params.get('managed') === '1',
    sessionId: params.get('managedSession') || undefined,
  };
}

export function saveManagedSelection(open: boolean, sessionId?: string): void {
  const url = new URL(window.location.href);
  if (open) {
    url.searchParams.set('managed', '1');
    if (sessionId) url.searchParams.set('managedSession', sessionId);
    else url.searchParams.delete('managedSession');
  } else {
    url.searchParams.delete('managed');
    url.searchParams.delete('managedSession');
  }
  window.history.replaceState(window.history.state, '', url);
}
