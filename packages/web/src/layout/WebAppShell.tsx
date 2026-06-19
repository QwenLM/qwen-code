import type { ReactNode } from 'react';
import { useConnection, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { TaskRail } from '../features/task-rail/TaskRail';
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
            <StatusPill
              label="Daemon"
              value={connection.status}
              details={toStatusDetails([
                ['URL', workspace.baseUrl],
                [
                  'Workspace',
                  connection.workspaceCwd ?? workspace.workspaceCwd,
                ],
                ['Session', connection.sessionId],
                ['Model', connection.currentModel],
                ['Error', connection.error],
              ])}
            />
            <StatusPill
              label="Workspace"
              value={workspace.status}
              details={toStatusDetails([
                ['URL', workspace.baseUrl],
                ['Workspace', workspace.workspaceCwd],
                ['Error', workspace.error?.message],
              ])}
            />
          </div>
        </header>
        <div
          className={showTaskRail ? 'web-workspace chat-mode' : 'web-workspace'}
        >
          <section className="web-content">{children}</section>
          {showTaskRail ? <TaskRail /> : null}
        </div>
      </main>
    </div>
  );
}

function StatusPill({
  label,
  value,
  details,
}: {
  label: string;
  value: string;
  details: Array<[string, string]>;
}) {
  return (
    <details className="web-status-menu">
      <summary
        className={`web-status-pill ${value}`}
        title={`${label}: ${value}`}
      >
        <span>{label}</span>
        <strong>{value}</strong>
      </summary>
      <div className="web-status-popover">
        <h3>{label}</h3>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{value}</dd>
          </div>
          {details.map(([name, detail]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
        <p>
          建议使用 <code>npm run dev:web</code> 启动当前 workspace 的 Web 服务。
        </p>
      </div>
    </details>
  );
}

function toStatusDetails(rows: Array<[string, string | undefined]>) {
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}
