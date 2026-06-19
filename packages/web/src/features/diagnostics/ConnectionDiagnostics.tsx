interface ConnectionDiagnosticsProps {
  daemonStatus: string;
  workspaceStatus: string;
  daemonUrl: string;
  requestedWorkspaceCwd?: string;
  boundWorkspaceCwd?: string;
  sessionId?: string;
  currentModel?: string;
  daemonError?: string;
  workspaceError?: string;
}

export function ConnectionDiagnostics({
  daemonStatus,
  workspaceStatus,
  daemonUrl,
  requestedWorkspaceCwd,
  boundWorkspaceCwd,
  sessionId,
  currentModel,
  daemonError,
  workspaceError,
}: ConnectionDiagnosticsProps) {
  const workspaceMismatch = Boolean(
    requestedWorkspaceCwd &&
      boundWorkspaceCwd &&
      requestedWorkspaceCwd !== boundWorkspaceCwd,
  );
  const hasIssue =
    daemonStatus !== 'connected' ||
    workspaceStatus === 'error' ||
    workspaceMismatch ||
    Boolean(daemonError) ||
    Boolean(workspaceError);

  if (!hasIssue) return null;

  const error = workspaceError ?? daemonError;

  return (
    <div className="web-connection-diagnostics" role="status">
      <div>
        <strong>{getTitle(daemonStatus, workspaceStatus, workspaceMismatch)}</strong>
        <p>
          {getDescription(
            daemonStatus,
            workspaceStatus,
            workspaceMismatch,
            error,
          )}
        </p>
      </div>
      <dl>
        <div>
          <dt>Daemon URL</dt>
          <dd>{daemonUrl}</dd>
        </div>
        {requestedWorkspaceCwd ? (
          <div>
            <dt>Requested workspace</dt>
            <dd>{requestedWorkspaceCwd}</dd>
          </div>
        ) : null}
        {boundWorkspaceCwd ? (
          <div>
            <dt>Bound workspace</dt>
            <dd>{boundWorkspaceCwd}</dd>
          </div>
        ) : null}
        {sessionId ? (
          <div>
            <dt>Session</dt>
            <dd>{sessionId}</dd>
          </div>
        ) : null}
        {currentModel ? (
          <div>
            <dt>Model</dt>
            <dd>{currentModel}</dd>
          </div>
        ) : null}
        {error ? (
          <div>
            <dt>最近错误</dt>
            <dd>{error}</dd>
          </div>
        ) : null}
      </dl>
      <div className="web-connection-command">
        <span>建议从仓库根目录启动：</span>
        <code>npm run dev:web</code>
      </div>
    </div>
  );
}

function getTitle(
  daemonStatus: string,
  workspaceStatus: string,
  workspaceMismatch: boolean,
) {
  if (workspaceMismatch) return 'Workspace 不匹配';
  if (workspaceStatus === 'error') return 'Workspace 连接失败';
  if (daemonStatus === 'error') return 'Daemon 连接失败';
  if (daemonStatus === 'disconnected') return 'Daemon 已断开，正在等待恢复';
  return '正在连接 Daemon';
}

function getDescription(
  daemonStatus: string,
  workspaceStatus: string,
  workspaceMismatch: boolean,
  error: string | undefined,
) {
  if (workspaceMismatch || error?.includes('Workspace mismatch')) {
    return '当前页面连接到了其他工作区的 daemon，请改用当前仓库专属的 Web 开发启动命令。';
  }
  if (error?.includes('AcpSessionBridge initialize timed out')) {
    return '会话桥初始化超时，请重启当前 workspace daemon 后刷新页面。';
  }
  if (workspaceStatus === 'error') {
    return '无法读取 workspace 能力，请确认 daemon 已启动且端口可访问。';
  }
  if (daemonStatus === 'disconnected') {
    return '会话连接暂时中断，页面会继续尝试恢复。';
  }
  return '正在创建或恢复会话。如果长时间停留在此状态，请使用下面的命令重新启动服务。';
}
