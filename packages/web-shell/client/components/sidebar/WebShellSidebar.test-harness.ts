import { act } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

interface SessionPageState {
  sessions: DaemonSessionSummary[];
  data?: DaemonSessionSummary[];
}

export function resolveWebShellSessions<
  State extends SessionPageState,
  Query extends Record<string, unknown>,
>(
  state: State,
  enabled: boolean,
  catalogQuery: Query,
): State & {
  sessions: DaemonSessionSummary[];
  data: DaemonSessionSummary[] | undefined;
  catalogQuery: Query;
} {
  if (!enabled) {
    return { ...state, sessions: [], data: undefined, catalogQuery };
  }

  // An absent key is a legacy settled fixture; an explicit undefined value
  // models the real catalog hook before its first page has loaded.
  const data = Object.hasOwn(state, 'data') ? state.data : state.sessions;
  return {
    ...state,
    sessions: data === undefined ? [] : state.sessions,
    data,
    catalogQuery,
  };
}

export function installSidebarDomShims(): void {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.PointerEvent) {
    globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

export function makeSidebarSession(
  sessionId: string,
  overrides: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
    isPinned: false,
    groupId: null,
    color: null,
    ...overrides,
  } as DaemonSessionSummary;
}

export async function flushSidebar(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function clickSidebarElement(
  element: HTMLElement,
  includePointerEvents = false,
): void {
  if (includePointerEvents) {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
