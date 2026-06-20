import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebShellComposerApi } from '@qwen-code/web-shell';
import type { WebDaemonConfig } from './config/daemon';
import { ArtifactsPanel } from './features/artifacts/ArtifactsPanel';
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

interface AppProps {
  config: WebDaemonConfig;
}

interface PendingComposerAction {
  text: string;
  submit?: boolean;
}

export function App({ config }: AppProps) {
  const composerRef = useRef<WebShellComposerApi | null>(null);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const [route, setRoute] = useState<WebRoute>(() =>
    parseWebRoute(new URL(window.location.href)),
  );
  const [pendingComposerAction, setPendingComposerAction] =
    useState<PendingComposerAction>();
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
      setPendingComposerAction({ text });
      openChat();
    },
    [openChat],
  );

  const runTextInChat = useCallback(
    (text: string) => {
      setPendingComposerAction({ text, submit: true });
      openChat();
    },
    [openChat],
  );

  const openFile = useCallback(
    (path: string) => {
      navigate({ view: 'files', path });
    },
    [navigate],
  );

  useEffect(() => {
    const onPopState = () =>
      setRoute(parseWebRoute(new URL(window.location.href)));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (activeView !== 'chat' || !pendingComposerAction) return;
    const timer = window.setTimeout(() => {
      if (pendingComposerAction.submit) {
        composerRef.current?.submit({ text: pendingComposerAction.text });
      } else {
        composerRef.current?.insertText(pendingComposerAction.text, {
          mode: 'append',
        });
      }
      setPendingComposerAction(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeView, pendingComposerAction]);

  return (
    <WebAppShell
      activeView={activeView}
      requestedWorkspaceCwd={config.workspaceCwd}
      onAddToChat={addTextToChat}
      onOpenFile={openFile}
      onSelectView={selectView}
    >
      {activeView === 'chat' ? (
        <ChatPane
          composerRef={composerRef}
          requestedWorkspaceCwd={config.workspaceCwd}
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
      {activeView === 'artifacts' ? (
        <ArtifactsPanel
          initialPath={route.view === 'artifacts' ? route.path : undefined}
          onAddToChat={addTextToChat}
          onOpenFile={openFile}
          onPathChange={(path) =>
            navigate({ view: 'artifacts', path }, { replace: true })
          }
        />
      ) : null}
      {activeView === 'mcp' ? <McpPanel /> : null}
      {activeView === 'tools' ? <ToolsPanel /> : null}
      {activeView === 'skills' ? (
        <SkillsPanel onAddToChat={addTextToChat} onRunSkill={runTextInChat} />
      ) : null}
      {activeView === 'memory' ? <MemoryPanel /> : null}
      {activeView === 'settings' ? <SettingsPanel /> : null}
    </WebAppShell>
  );
}
