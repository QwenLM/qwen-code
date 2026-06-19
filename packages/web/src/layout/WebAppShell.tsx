import type { ReactNode } from 'react';
import { useConnection, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { Sidebar } from './Sidebar';
import type { WebViewId } from './views';
import { WEB_VIEWS } from './views';

interface WebAppShellProps {
  activeView: WebViewId;
  onSelectView: (view: WebViewId) => void;
  children: ReactNode;
}

export function WebAppShell({
  activeView,
  onSelectView,
  children,
}: WebAppShellProps) {
  const connection = useConnection();
  const workspace = useWorkspace();
  const active = WEB_VIEWS.find((view) => view.id === activeView);
  const showTaskRail = activeView === 'chat';

  return (
    <div className="web-app">
      <Sidebar activeView={activeView} onSelectView={onSelectView} />
      <main className="web-main">
        <header className="web-topbar">
          <div className="web-topbar-copy">
            <h1>{active?.label ?? 'Qwen Code Web'}</h1>
            <p>{active?.description}</p>
          </div>
          <div className="web-status-cluster">
            <StatusPill label="Daemon" value={connection.status} />
            <StatusPill label="Workspace" value={workspace.status} />
          </div>
        </header>
        <div className={showTaskRail ? 'web-workspace chat-mode' : 'web-workspace'}>
          <section className="web-content">{children}</section>
          {showTaskRail ? (
            <TaskRail
              daemonStatus={connection.status}
              workspaceStatus={workspace.status}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <span className={`web-status-pill ${value}`} title={`${label}: ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function TaskRail({
  daemonStatus,
  workspaceStatus,
}: {
  daemonStatus: string;
  workspaceStatus: string;
}) {
  return (
    <aside className="web-task-rail" aria-label="任务流程">
      <div className="web-task-rail-header">
        <h2>任务流程</h2>
        <span>实时</span>
      </div>
      <section className="web-task-section">
        <h3>协办</h3>
        <div className="web-task-chip">
          <span>Daemon {daemonStatus}</span>
        </div>
      </section>
      <section className="web-task-section">
        <h3>产物</h3>
        <p>当前会话生成的文件、预览和导出会在这里沉淀。</p>
      </section>
      <section className="web-task-section">
        <h3>技能 / MCP</h3>
        <p>Workspace {workspaceStatus}，可在左侧工具与技能页查看详情。</p>
      </section>
      <section className="web-task-section">
        <h3>需要处理</h3>
        <p>暂无待处理事项。</p>
      </section>
    </aside>
  );
}
