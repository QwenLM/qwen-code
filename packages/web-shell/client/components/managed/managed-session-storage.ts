import { randomUUID } from '../../utils/random-uuid.js';
export function managedRequestId(): string {
  return `managed_${randomUUID()}`;
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
 * Keep this rule in one place: `WorkspaceSessionProvider` sits above `App` and
 * wraps both branches, so it must classify the view like App does. The two
 * call sites deliberately pass different local-target operands: the provider
 * passes the props-derived `hasManagedLocalTarget`, while App passes its
 * `StandaloneContext` flag (the standalone embedding gates App in only for
 * local targets, and the managed-only shell defaults to the managed home).
 * Every in-tree entry point supplies `urlNavigation`, so the route arm wins
 * and the operands agree; a route-less host that mounts App directly with a
 * session id but no standalone context can still split the classification,
 * which is a known limitation of that embedding shape, not a parity claim.
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

/**
 * An explicit local session target — a session id, a workspace reference, or a
 * session context — keeps the daemon view even when no route exists to say so
 * (a host that omits `urlNavigation`).
 */
export function hasManagedLocalTarget(props: {
  sessionId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  sessionContext?: unknown;
}): boolean {
  return Boolean(
    props.sessionId ||
      props.workspaceId ||
      props.workspaceCwd ||
      props.sessionContext,
  );
}

export function saveManagedSelection(open: boolean, sessionId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('managed', open ? '1' : '0');
  if (sessionId) url.searchParams.set('managedSession', sessionId);
  else url.searchParams.delete('managedSession');
  window.history.replaceState(window.history.state, '', url);
}
