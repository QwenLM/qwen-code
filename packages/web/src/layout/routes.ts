import type { WebViewId } from './views';

export type WebRoute =
  | { view: 'chat'; sessionId?: string }
  | { view: Exclude<WebViewId, 'chat'>; path?: string };

const VIEW_PATHS: Record<Exclude<WebViewId, 'chat'>, string> = {
  sessions: '/sessions',
  files: '/files',
  mcp: '/mcp',
  tools: '/tools',
  skills: '/skills',
  memory: '/memory',
  settings: '/settings',
};

const PATH_VIEWS = new Map(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as WebViewId]),
);

export function parseWebRoute(url: URL): WebRoute {
  const pathname = stripTrailingSlash(url.pathname);
  if (pathname.startsWith('/session/')) {
    try {
      const sessionId = decodeURIComponent(pathname.slice('/session/'.length));
      return sessionId ? { view: 'chat', sessionId } : { view: 'chat' };
    } catch {
      return { view: 'chat' };
    }
  }
  const view = PATH_VIEWS.get(pathname);
  if (!view || view === 'chat') return { view: 'chat' };
  if (view === 'files') {
    return { view, path: url.searchParams.get('path') ?? undefined };
  }
  return { view };
}

export function buildWebRouteUrl(route: WebRoute): string {
  if (route.view === 'chat') {
    return route.sessionId
      ? `/session/${encodeURIComponent(route.sessionId)}`
      : '/';
  }
  const pathname = VIEW_PATHS[route.view];
  if (route.view !== 'files' || !route.path || route.path === '.') {
    return pathname;
  }
  return `${pathname}?path=${encodeURIComponent(route.path)}`;
}

export function routeForView(view: WebViewId, sessionId?: string): WebRoute {
  if (view === 'chat') return { view, sessionId };
  return { view };
}

function stripTrailingSlash(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}
