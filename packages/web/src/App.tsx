import { useCallback, useState } from 'react';
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
  const [activeView, setActiveView] = useState<WebViewId>('chat');
  const openChat = useCallback(() => setActiveView('chat'), []);
  const updateSessionUrl = useCallback((sessionId: string) => {
    const url = new URL(window.location.href);
    url.pathname = `/session/${encodeURIComponent(sessionId)}`;
    window.history.replaceState(null, '', url);
  }, []);

  return (
    <WebAppShell activeView={activeView} onSelectView={setActiveView}>
      {activeView === 'chat' ? (
        <ChatPane onSessionIdChange={updateSessionUrl} />
      ) : null}
      {activeView === 'sessions' ? (
        <SessionsPanel onOpenChat={openChat} />
      ) : null}
      {activeView === 'files' ? <FilesPanel /> : null}
      {activeView === 'mcp' ? <McpPanel /> : null}
      {activeView === 'tools' ? <ToolsPanel /> : null}
      {activeView === 'skills' ? <SkillsPanel /> : null}
      {activeView === 'memory' ? <MemoryPanel /> : null}
      {activeView === 'settings' ? <SettingsPanel /> : null}
    </WebAppShell>
  );
}
