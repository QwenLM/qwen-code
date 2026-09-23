/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DaemonProductSessionContext } from '@qwen-code/web-shell/daemon-react-sdk';
import type { WebShellProps } from './App';
import {
  buildNavigationUrl,
  normalizeNavigationBasePath,
  readNavigationUrl,
  type SessionUrlTarget,
  type WebShellPage,
  type WebShellRoute,
} from './utils/navigationUrl';

export type { WebShellPage } from './utils/navigationUrl';
export interface WebShellUrlNavigationOptions {
  /** URL pathname containing the shell, e.g. /agentic-code. Defaults to root. */
  basePath?: string;
}
export interface NavigationSessionProps {
  sessionId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  sessionContext?: DaemonProductSessionContext;
}
interface NavigationState {
  route: WebShellRoute;
  target: NavigationSessionProps;
  revision: number;
}
interface NavigationController {
  route: WebShellRoute;
  revision: number;
  openPage: (page: WebShellPage) => void;
  returnToChat: () => void;
  reconcilePage: (page: WebShellPage | undefined) => void;
  beginSessionNavigation: (
    sessionId?: string,
    workspaceId?: string,
    sessionContext?: DaemonProductSessionContext,
  ) => void;
  cancelSessionNavigation: () => void;
  finishNewChat: (context?: DaemonProductSessionContext) => void;
}
const NavigationContext = createContext<NavigationController | undefined>(
  undefined,
);
export const useWebShellNavigation = () => useContext(NavigationContext);
const STATE_KEY = '__qwenWebShellNavigation';

function sessionTarget(route: SessionUrlTarget): NavigationSessionProps {
  return {
    sessionId: route.sessionId,
    workspaceId: route.workspaceId,
    sessionContext: route.context ? { kind: route.context } : undefined,
  };
}
function sessionRoute(target: NavigationSessionProps): WebShellRoute {
  const kind = target.sessionContext?.kind;
  return {
    page: 'chat',
    sessionId: target.sessionId,
    workspaceId: target.workspaceId,
    context: kind === 'standalone' || kind === 'live' ? kind : undefined,
  };
}
function returnTarget(basePath: string): NavigationSessionProps | undefined {
  const value: unknown = window.history.state?.[STATE_KEY];
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as { basePath?: unknown; source?: unknown };
  if (entry.basePath !== basePath || typeof entry.source !== 'string') {
    return undefined;
  }
  try {
    const source = new URL(entry.source, window.location.origin);
    if (source.origin !== window.location.origin) return undefined;
    const route = readNavigationUrl(source, basePath);
    return route?.page === 'chat' ? sessionTarget(route) : undefined;
  } catch {
    return undefined;
  }
}

export function WebShellNavigationBoundary({
  options,
  externalTarget,
  onSessionIdChange,
  children,
}: {
  options?: WebShellUrlNavigationOptions;
  externalTarget: NavigationSessionProps;
  onSessionIdChange?: WebShellProps['onSessionIdChange'];
  children: (
    target: NavigationSessionProps,
    onChange: NonNullable<WebShellProps['onSessionIdChange']>,
  ) => ReactNode;
}) {
  const enabled = options !== undefined;
  const basePath = normalizeNavigationBasePath(options?.basePath);
  const [state, setState] = useState<NavigationState>(() => {
    const urlRoute = enabled
      ? readNavigationUrl(new URL(window.location.href), basePath)
      : undefined;
    const explicit = Object.values(externalTarget).some(
      (value) => value !== undefined,
    );
    const target = explicit
      ? externalTarget
      : urlRoute?.page === 'chat'
        ? sessionTarget(urlRoute)
        : enabled
          ? (returnTarget(basePath) ?? {})
          : externalTarget;
    return {
      route: explicit ? sessionRoute(target) : (urlRoute ?? { page: 'chat' }),
      target,
      revision: 0,
    };
  });
  const current = useRef(state);
  current.current = state;
  const pendingSession = useRef<{ sessionId?: string } | undefined>({
    sessionId: state.target.sessionId,
  });
  const userSessionNavigation = useRef(false);
  const restoringHistory = useRef(false);
  const externalKey = JSON.stringify(externalTarget);
  const previousExternalKey = useRef(externalKey);

  const commit = useCallback(
    (
      route: WebShellRoute,
      target: NavigationSessionProps,
      mode: 'push' | 'replace' | 'replay',
    ) => {
      if (!enabled) return;
      const pathname = window.location.pathname;
      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return;
      if (mode !== 'replay') {
        const before = new URL(window.location.href);
        const url = buildNavigationUrl(before, route, basePath);
        if (route.page !== 'chat') {
          if (url.searchParams.get('view') === 'cockpit') {
            url.searchParams.delete('view');
          }
        }
        const existing = window.history.state;
        const historyState = {
          ...(existing && typeof existing === 'object' ? existing : {}),
          [STATE_KEY]: {
            basePath,
            source:
              route.page !== 'chat'
                ? buildNavigationUrl(
                    before,
                    current.current.route.page === 'chat'
                      ? current.current.route
                      : sessionRoute(returnTarget(basePath) ?? {}),
                    basePath,
                  ).href
                : undefined,
          },
        };
        if (url.href !== before.href) {
          window.history[mode === 'push' ? 'pushState' : 'replaceState'](
            historyState,
            '',
            url,
          );
        }
      }
      const next = {
        route,
        target,
        revision:
          current.current.revision +
          (mode === 'replay' || route.page !== current.current.route.page
            ? 1
            : 0),
      };
      current.current = next;
      setState(next);
    },
    [basePath, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    commit(current.current.route, current.current.target, 'replace');
  }, [commit, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (previousExternalKey.current !== externalKey) {
      previousExternalKey.current = externalKey;
      if (
        JSON.stringify(sessionRoute(externalTarget)) ===
          JSON.stringify(sessionRoute(current.current.target)) &&
        (externalTarget.workspaceCwd === undefined ||
          externalTarget.workspaceCwd === current.current.target.workspaceCwd)
      )
        return;
      pendingSession.current = { sessionId: externalTarget.sessionId };
      commit(sessionRoute(externalTarget), externalTarget, 'replace');
    }
  }, [commit, enabled, externalKey, externalTarget]);

  useEffect(() => {
    if (!enabled) return;
    const handlePopState = () => {
      const route = readNavigationUrl(new URL(window.location.href), basePath);
      userSessionNavigation.current = false;
      restoringHistory.current = true;
      if (!route) return;
      const target =
        route.page === 'chat'
          ? sessionTarget(route)
          : (returnTarget(basePath) ?? {});
      const changed =
        JSON.stringify(sessionRoute(target)) !==
        JSON.stringify(sessionRoute(current.current.target));
      pendingSession.current = changed
        ? { sessionId: target.sessionId }
        : undefined;
      restoringHistory.current = changed;
      commit(route, target, 'replay');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [basePath, commit, enabled]);

  const handleSessionChange = useCallback<
    NonNullable<WebShellProps['onSessionIdChange']>
  >(
    (sessionId, workspaceId, workspaceCwd, sessionContext) => {
      if (enabled) {
        if (
          pendingSession.current &&
          pendingSession.current.sessionId !== sessionId
        ) {
          return;
        }
        const wasPending = pendingSession.current !== undefined;
        pendingSession.current = undefined;
        const target = { sessionId, workspaceId, workspaceCwd, sessionContext };
        if (
          current.current.route.page === 'chat' ||
          userSessionNavigation.current
        ) {
          const nextRoute = sessionRoute(target);
          const before = current.current.route;
          const sameSession =
            before.page === 'chat' && before.sessionId === sessionId;
          commit(
            nextRoute,
            target,
            restoringHistory.current
              ? 'replay'
              : wasPending || (sameSession && !userSessionNavigation.current)
                ? 'replace'
                : 'push',
          );
        } else {
          current.current = { ...current.current, target };
          setState(current.current);
        }
      }
      userSessionNavigation.current = false;
      restoringHistory.current = false;
      if (sessionContext)
        onSessionIdChange?.(
          sessionId,
          workspaceId,
          workspaceCwd,
          sessionContext,
        );
      else onSessionIdChange?.(sessionId, workspaceId, workspaceCwd);
    },
    [commit, enabled, onSessionIdChange],
  );
  const controller = useMemo<NavigationController | undefined>(
    () =>
      enabled
        ? {
            route: state.route,
            revision: state.revision,
            openPage: (page) => {
              restoringHistory.current = false;
              userSessionNavigation.current = false;
              if (current.current.route.page === page) return;
              commit({ page }, current.current.target, 'push');
            },
            returnToChat: () => {
              restoringHistory.current = false;
              userSessionNavigation.current = false;
              const target = returnTarget(basePath) ?? {};
              pendingSession.current =
                JSON.stringify(sessionRoute(target)) !==
                JSON.stringify(sessionRoute(current.current.target))
                  ? { sessionId: target.sessionId }
                  : undefined;
              commit(sessionRoute(target), target, 'push');
            },
            reconcilePage: (page) => {
              if (userSessionNavigation.current) return;
              if (
                current.current.route.page === 'chat' ||
                (page ?? 'chat') === current.current.route.page
              )
                return;
              commit(
                page ? { page } : sessionRoute(current.current.target),
                current.current.target,
                'replace',
              );
            },
            cancelSessionNavigation: () => {
              userSessionNavigation.current = false;
              pendingSession.current = undefined;
            },
            finishNewChat: (sessionContext) => {
              if (!userSessionNavigation.current) return;
              userSessionNavigation.current = false;
              pendingSession.current = undefined;
              const target = {
                sessionId: undefined,
                workspaceId: undefined,
                workspaceCwd: undefined,
                sessionContext,
              };
              commit(sessionRoute(target), target, 'push');
            },
            beginSessionNavigation: (
              sessionId,
              workspaceId,
              sessionContext,
            ) => {
              restoringHistory.current = false;
              userSessionNavigation.current = true;
              pendingSession.current = { sessionId };
              commit(
                sessionRoute({ sessionId, workspaceId, sessionContext }),
                current.current.target,
                'push',
              );
            },
          }
        : undefined,
    [basePath, commit, enabled, state.revision, state.route],
  );
  return (
    <NavigationContext.Provider value={controller}>
      {children(enabled ? state.target : externalTarget, handleSessionChange)}
    </NavigationContext.Provider>
  );
}
