import {
  useActiveTodoList,
  useConnection,
  usePendingPermissions,
  usePromptStatus,
  useSessionNotices,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptState,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonSessionNotice,
  DaemonTodoItem,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/webui/daemon-react-sdk';
import { useWebArtifacts } from '../artifacts/useWebArtifacts';

const MAX_RECENT_ITEMS = 5;
const MAX_NOTICE_ITEMS = 2;

interface TaskRailProps {
  onAddToChat?: (text: string) => void;
  onOpenFile?: (path: string) => void;
}

export function TaskRail({ onAddToChat, onOpenFile }: TaskRailProps) {
  const connection = useConnection();
  const workspace = useWorkspace();
  const promptStatus = usePromptStatus();
  const streamingState = useStreamingState();
  const blocks = useTranscriptBlocks();
  const transcriptState = useTranscriptState();
  const pendingPermissions = usePendingPermissions();
  const activeTodoList = useActiveTodoList();
  const { notices } = useSessionNotices();
  const { artifacts } = useWebArtifacts();

  const currentTool = getCurrentTool(transcriptState, blocks);
  const recentTools = getRecentToolBlocks(blocks);
  const recentArtifacts = artifacts.slice(0, MAX_RECENT_ITEMS);
  const importantNotices = notices
    .filter(
      (notice) => notice.severity === 'warning' || notice.severity === 'error',
    )
    .slice(-MAX_NOTICE_ITEMS)
    .reverse();
  const todoProgress = getTodoProgress(activeTodoList?.items ?? []);
  const tokenPercent = getTokenPercent(
    connection.tokenCount,
    connection.contextWindow,
  );

  return (
    <aside className="web-task-rail" aria-label="任务流程">
      <div className="web-task-rail-header">
        <h2>任务流程</h2>
        <span>{streamingLabel(streamingState)}</span>
      </div>

      <section className="web-task-section">
        <h3>Session</h3>
        <div className="web-task-list">
          <TaskRow label="Daemon" value={connection.status} />
          <TaskRow label="Workspace" value={workspace.status} />
          <TaskRow label="Session" value={shortId(connection.sessionId)} mono />
          <TaskRow label="Model" value={connection.currentModel ?? '未选择'} />
          <TaskRow label="Mode" value={connection.currentMode ?? 'default'} />
          <TaskRow
            label="CWD"
            value={connection.workspaceCwd ?? workspace.workspaceCwd ?? '未知'}
            mono
          />
          {connection.catchingUp ? (
            <p className="web-task-warning">同步历史中</p>
          ) : null}
          {tokenPercent ? (
            <div className="web-task-progress">
              <div>
                <span>Context</span>
                <strong>{tokenPercent.label}</strong>
              </div>
              <span>
                <i style={{ width: `${tokenPercent.percent}%` }} />
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="web-task-section">
        <h3>当前活动</h3>
        {currentTool ? (
          <div className="web-task-chip">
            <span>{currentTool.toolName ?? currentTool.title}</span>
            <strong>{currentTool.status}</strong>
          </div>
        ) : (
          <div className="web-task-chip">
            <span>{activityLabel(promptStatus, streamingState)}</span>
          </div>
        )}
      </section>

      <section className="web-task-section">
        <h3>Todos</h3>
        {activeTodoList && activeTodoList.items.length > 0 ? (
          <>
            <div className="web-task-progress">
              <div>
                <span>{activeTodoList.title || 'Todo list'}</span>
                <strong>
                  {todoProgress.completed}/{todoProgress.total}
                </strong>
              </div>
              <span>
                <i style={{ width: `${todoProgress.percent}%` }} />
              </span>
            </div>
            <ul className="web-task-list">
              {getVisibleTodos(activeTodoList.items).map((item) => (
                <li key={item.id} className="web-task-row">
                  <span>{todoStatusLabel(item.status)}</span>
                  <strong>{item.content}</strong>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="web-task-muted">暂无活动 todo。</p>
        )}
      </section>

      <section className="web-task-section">
        <h3>需要处理</h3>
        {pendingPermissions.length > 0 ? (
          <div className="web-task-warning">
            <strong>{pendingPermissions.length} 个权限请求</strong>
            <span>{pendingPermissions[0]?.title ?? '等待确认'}</span>
            <small>请在聊天区处理。</small>
          </div>
        ) : (
          <p className="web-task-muted">暂无待处理事项。</p>
        )}
      </section>

      <section className="web-task-section">
        <h3>最近工具</h3>
        {recentTools.length > 0 ? (
          <ul className="web-task-list">
            {recentTools.map((tool) => (
              <li key={tool.id} className="web-task-row">
                <span>{tool.status}</span>
                <strong>{tool.toolName ?? tool.title}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="web-task-muted">暂无工具调用。</p>
        )}
      </section>

      <section className="web-task-section">
        <h3>Artifacts / 最近文件</h3>
        <p className="web-task-muted">
          从最近工具输出中推断，不代表完整 artifact 索引。
        </p>
        {recentArtifacts.length > 0 ? (
          <ul className="web-task-list">
            {recentArtifacts.map((artifact) => (
              <li
                key={artifact.id}
                className="web-task-row web-task-mono web-task-artifact-row"
              >
                <span className="web-task-artifact-meta">
                  {artifact.operation}
                </span>
                <strong>{artifact.path}</strong>
                <span className="web-task-actions">
                  {onOpenFile ? (
                    <button
                      type="button"
                      onClick={() => onOpenFile(artifact.path)}
                    >
                      Open
                    </button>
                  ) : null}
                  {onAddToChat ? (
                    <button
                      type="button"
                      onClick={() => onAddToChat(`@${artifact.path} `)}
                    >
                      Add
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="web-task-muted">还没有检测到文件输出。</p>
        )}
      </section>

      {importantNotices.length > 0 ? (
        <section className="web-task-section">
          <h3>诊断</h3>
          <ul className="web-task-list">
            {importantNotices.map((notice) => (
              <NoticeItem key={notice.id} notice={notice} />
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function TaskRow({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className={mono ? 'web-task-row web-task-mono' : 'web-task-row'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NoticeItem({ notice }: { notice: DaemonSessionNotice }) {
  const className =
    notice.severity === 'error'
      ? 'web-task-row web-task-danger'
      : 'web-task-row web-task-warning';
  return (
    <li className={className}>
      <span>{notice.severity}</span>
      <strong>{notice.message}</strong>
    </li>
  );
}

function getCurrentTool(
  state: ReturnType<typeof useTranscriptState>,
  blocks: readonly DaemonTranscriptBlock[],
) {
  if (!state.currentToolCallId) return undefined;
  const blockId = state.toolBlockByCallId[state.currentToolCallId];
  if (!blockId) return undefined;
  const index = state.blockIndexById[blockId];
  const block = blocks[index];
  return isToolBlock(block) ? block : undefined;
}

function getRecentToolBlocks(blocks: readonly DaemonTranscriptBlock[]) {
  return blocks.filter(isToolBlock).slice(-MAX_RECENT_ITEMS).reverse();
}

function isToolBlock(
  block: DaemonTranscriptBlock | undefined,
): block is DaemonToolTranscriptBlock {
  return block?.kind === 'tool';
}

function getTodoProgress(items: DaemonTodoItem[]) {
  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, percent, total };
}

function getVisibleTodos(items: DaemonTodoItem[]) {
  const inProgress = items.find((item) => item.status === 'in_progress');
  const pending = items.filter((item) => item.status === 'pending').slice(0, 3);
  return inProgress ? [inProgress, ...pending] : pending;
}

function getTokenPercent(tokenCount?: number, contextWindow?: number) {
  if (!tokenCount || !contextWindow) return undefined;
  const percent = Math.min(100, Math.round((tokenCount / contextWindow) * 100));
  return {
    percent,
    label: `${formatCompactNumber(tokenCount)} / ${formatCompactNumber(
      contextWindow,
    )}`,
  };
}

function activityLabel(promptStatus: string, streamingState: string) {
  if (promptStatus === 'waiting') return '等待模型响应';
  if (promptStatus === 'streaming') return streamingLabel(streamingState);
  return streamingLabel(streamingState);
}

function streamingLabel(value: string) {
  switch (value) {
    case 'waiting':
      return '等待中';
    case 'thinking':
      return '思考中';
    case 'responding':
      return '响应中';
    default:
      return '空闲';
  }
}

function todoStatusLabel(value: DaemonTodoItem['status']) {
  switch (value) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'doing';
    default:
      return 'todo';
  }
}

function shortId(value?: string) {
  return value ? value.slice(0, 8) : '未创建';
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(
    value,
  );
}
