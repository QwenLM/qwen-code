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
import type { WebViewId } from './layout/views';

export function App() {
  const composerRef = useRef<WebShellComposerApi | null>(null);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const [activeView, setActiveView] = useState<WebViewId>(() =>
    getInitialView(window.location.pathname),
  );
  const [pendingComposerText, setPendingComposerText] = useState<string>();

  const openChat = useCallback(() => {
    setActiveView('chat');
    const url = new URL(window.location.href);
    if (lastSessionIdRef.current) {
      url.pathname = `/session/${encodeURIComponent(lastSessionIdRef.current)}`;
    } else {
      url.pathname = '/';
    }
    url.search = '';
    window.history.replaceState(null, '', url);
  }, []);

  const selectView = useCallback(
    (view: WebViewId) => {
      if (view === 'chat') {
        openChat();
        return;
      }
      setActiveView(view);
      if (view === 'files') {
        const url = new URL(window.location.href);
        url.pathname = '/files';
        url.search = '';
        window.history.replaceState(null, '', url);
      }
    },
    [openChat],
  );

  const updateSessionUrl = useCallback((sessionId: string) => {
    lastSessionIdRef.current = sessionId;
    const url = new URL(window.location.href);
    url.pathname = `/session/${encodeURIComponent(sessionId)}`;
    url.search = '';
    window.history.replaceState(null, '', url);
  }, []);

  const addFileToChat = useCallback(
    (path: string) => {
      setPendingComposerText(`@${path} `);
      openChat();
    },
    [openChat],
  );

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
        <FilesPanel onAddToChat={addFileToChat} />
      ) : null}
      {activeView === 'mcp' ? <McpPanel /> : null}
      {activeView === 'tools' ? <ToolsPanel /> : null}
      {activeView === 'skills' ? <SkillsPanel /> : null}
      {activeView === 'memory' ? <MemoryPanel /> : null}
      {activeView === 'settings' ? <SettingsPanel /> : null}
    </WebAppShell>
  );
}

function getInitialView(pathname: string): WebViewId {
  if (pathname === '/files') return 'files';
  return 'chat';
}
