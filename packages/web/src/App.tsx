import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebShellComposerApi } from '@qwen-code/web-shell';
import { ChatPane } from './features/chat/ChatPane';
import { FilesPanel } from './features/files/FilesPanel';
import { McpPanel } from './features/mcp/McpPanel';
import { MemoryPanel } from './features/memory/MemoryPanel';
import { SessionsPanel } from './features/sessions/SessionsPanel';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { SkillsPanel } from './features/skills/SkillsPanel';
import { ToolsPanel } from './features/tools/ToolsPanel';
import { WebAppShell } from './layout/WebAppShell';
import { buildWebRouteUrl, parseWebRoute, routeForView } from './layout/routes';
import type { WebRoute } from './layout/routes';
import type { WebViewId } from './layout/views';

export function App() {
  const composerRef = useRef<WebShellComposerApi | null>(null);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const [route, setRoute] = useState<WebRoute>(() =>
    parseWebRoute(new URL(window.location.href)),
  );
  const [pendingComposerText, setPendingComposerText] = useState<string>();
  const activeView = route.view;

  const navigate = useCallback(
    (nextRoute: WebRoute, options: { replace?: boolean } = {}) => {
      setRoute(nextRoute);
      const nextUrl = buildWebRouteUrl(nextRoute);
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (nextUrl === currentUrl) return;
      const method = options.replace ? 'replaceState' : 'pushState';
      window.history[method](null, '', nextUrl);
    },
    [],
  );

  const openChat = useCallback(() => {
    navigate({ view: 'chat', sessionId: lastSessionIdRef.current });
  }, [navigate]);

  const selectView = useCallback(
    (view: WebViewId) => {
      navigate(routeForView(view, lastSessionIdRef.current));
    },
    [navigate],
  );

  const updateSessionUrl = useCallback(
    (sessionId: string) => {
      lastSessionIdRef.current = sessionId;
      navigate({ view: 'chat', sessionId }, { replace: true });
    },
    [navigate],
  );

  const addTextToChat = useCallback(
    (text: string) => {
      setPendingComposerText(text);
      openChat();
    },
    [openChat],
  );

  useEffect(() => {
    const onPopState = () =>
      setRoute(parseWebRoute(new URL(window.location.href)));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (activeView !== 'chat' || !pendingComposerText) return;
    const timer = window.setTimeout(() => {
      composerRef.current?.insertText(pendingComposerText, { mode: 'append' });
      setPendingComposerText(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeView, pendingComposerText]);

  return (
    <WebAppShell activeView={activeView} onSelectView={selectView}>
      {activeView === 'chat' ? (
        <ChatPane
          composerRef={composerRef}
          onSessionIdChange={updateSessionUrl}
        />
      ) : null}
      {activeView === 'sessions' ? (
        <SessionsPanel onOpenChat={openChat} />
      ) : null}
      {activeView === 'files' ? (
        <FilesPanel
          initialPath={route.view === 'files' ? route.path : undefined}
          onAddToChat={(path) => addTextToChat(`@${path} `)}
          onPathChange={(path) =>
            navigate({ view: 'files', path }, { replace: true })
          }
        />
      ) : null}
      {activeView === 'mcp' ? <McpPanel /> : null}
      {activeView === 'tools' ? <ToolsPanel /> : null}
      {activeView === 'skills' ? (
        <SkillsPanel onAddToChat={addTextToChat} />
      ) : null}
      {activeView === 'memory' ? <MemoryPanel /> : null}
      {activeView === 'settings' ? <SettingsPanel /> : null}
    </WebAppShell>
  );
}
