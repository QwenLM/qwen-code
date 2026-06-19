import type { ReactNode } from 'react';
import { WebShell } from '@qwen-code/web-shell';
import { useConnection, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { ConnectionDiagnostics } from '../diagnostics/ConnectionDiagnostics';

interface ChatPaneProps {
  onSessionIdChange: (sessionId: string) => void;
}

export function ChatPane({ onSessionIdChange }: ChatPaneProps) {
  const connection = useConnection();
  const workspace = useWorkspace();

  return (
    <WebShell
      className="web-chat-shell"
      theme="light"
      onSessionIdChange={onSessionIdChange}
      renderWelcomeHeader={({ currentModel, cwd }) => (
        <WebChatWelcome
          currentModel={currentModel}
          cwd={cwd}
          diagnostics={
            <ConnectionDiagnostics
              daemonStatus={connection.status}
              workspaceStatus={workspace.status}
              daemonUrl={workspace.baseUrl}
              workspaceCwd={
                connection.workspaceCwd ?? workspace.workspaceCwd ?? cwd
              }
              sessionId={connection.sessionId}
              currentModel={connection.currentModel ?? currentModel}
              daemonError={connection.error}
              workspaceError={workspace.error?.message}
            />
          }
        />
      )}
    />
  );
}

function WebChatWelcome({
  currentModel,
  cwd,
  diagnostics,
}: {
  currentModel: string;
  cwd: string;
  diagnostics: ReactNode;
}) {
  return (
    <div className="web-chat-welcome">
      <div className="web-chat-welcome-mark">Q</div>
      <h2>不止聊天，搞定一切</h2>
      <p>本地运行，自主规划，安全执行你的 AI 工作助手。</p>
      <div className="web-chat-welcome-meta">
        {currentModel ? <span>{currentModel}</span> : null}
        {cwd ? <span>{cwd}</span> : null}
      </div>
      {diagnostics}
    </div>
  );
}
