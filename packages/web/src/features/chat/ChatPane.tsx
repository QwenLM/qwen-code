import { WebShell } from '@qwen-code/web-shell';

export function ChatPane() {
  return (
    <WebShell
      className="web-chat-shell"
      theme="light"
      renderWelcomeHeader={({ currentModel, cwd }) => (
        <WebChatWelcome currentModel={currentModel} cwd={cwd} />
      )}
    />
  );
}

function WebChatWelcome({
  currentModel,
  cwd,
}: {
  currentModel: string;
  cwd: string;
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
    </div>
  );
}
