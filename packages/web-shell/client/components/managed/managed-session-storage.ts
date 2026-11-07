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

export function managedSelectionFromUrl(defaultOpen = false): {
  open: boolean;
  sessionId?: string;
} {
  if (typeof window === 'undefined') return { open: false };
  const params = new URLSearchParams(window.location.search);
  return {
    open:
      params.get('managed') === '1' || (defaultOpen && !params.has('managed')),
    sessionId: params.get('managedSession') || undefined,
  };
}

/**
 * The managed view is selected by the URL contract App applies at mount:
 * `managed=1` always, or no `managed` param on a page that defaults to the
 * managed home (anything but a chat page with an explicit session target).
 * `managed=0` and every explicit local session target keep the daemon view.
 *
 * Keep this rule in one place: `WorkspaceSessionProvider` sits above `App`
 * and wraps both branches, so it must classify the view exactly like App does.
 */
export function managedSelectionFromRoute(
  route: { page: string; sessionId?: string } | undefined,
  hasLocalTarget = false,
): { open: boolean; sessionId?: string } {
  // A host that drives the view only through props (`urlNavigation` omitted)
  // has no route. Fall back to its own target: an explicit local target keeps
  // the daemon view, and only a targetless host defaults to the managed home.
  return managedSelectionFromUrl(
    route === undefined
      ? !hasLocalTarget
      : route.page !== 'chat' || !route.sessionId,
  );
}

export function saveManagedSelection(open: boolean, sessionId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('managed', open ? '1' : '0');
  if (sessionId) url.searchParams.set('managedSession', sessionId);
  else url.searchParams.delete('managedSession');
  window.history.replaceState(window.history.state, '', url);
}
