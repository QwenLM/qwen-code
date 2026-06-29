import type {
  DaemonTodoItem,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  WebTaskCheckResult,
  WebTaskTimelineItem,
  WebTaskTimelinePhase,
  WebTaskTimelineStatus,
  WebTaskTimelineSummary,
} from './taskTimelineTypes';

const MAX_TIMELINE_ITEMS = 100;
const MAX_ARTIFACT_PATHS = 4;
const TITLE_LIMIT = 96;
const DETAIL_LIMIT = 160;

type TodoStatus = DaemonTodoItem['status'];

interface CollectTaskTimelineOptions {
  workspaceCwd?: string;
}

export function collectTaskTimelineFromTranscript(
  blocks: readonly DaemonTranscriptBlock[],
  options: CollectTaskTimelineOptions = {},
): WebTaskTimelineItem[] {
  const items: WebTaskTimelineItem[] = [];
  const todoStatusById = new Map<string, TodoStatus>();

  for (const block of blocks) {
    const timestamp = getBlockTimestamp(block);
    switch (block.kind) {
      case 'user':
        items.push({
          id: `task-timeline:${block.id}:prompt`,
          kind: 'prompt',
          status: 'info',
          phase: 'prompt',
          title: truncateText(block.text, TITLE_LIMIT) || 'User prompt',
          timestamp,
          blockId: block.id,
        });
        break;
      case 'tool': {
        const artifactPaths = collectArtifactPaths(block, options.workspaceCwd);
        const checkResult = inferCheckResult(block, timestamp);
        items.push({
          id: `task-timeline:${block.id}:tool`,
          kind: 'tool',
          status: mapToolStatus(block.status),
          phase: inferToolPhase(block, artifactPaths, checkResult),
          title: block.toolName ?? block.title,
          ...(block.details
            ? { detail: truncateText(block.details, DETAIL_LIMIT) }
            : {}),
          timestamp,
          blockId: block.id,
          toolCallId: block.toolCallId,
          ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
          ...(checkResult ? { checkResult } : {}),
        });
        collectTodoEvents(block, timestamp, todoStatusById, items);
        break;
      }
      case 'permission':
        items.push({
          id: `task-timeline:${block.id}:permission`,
          kind: 'permission',
          status: block.resolved ? 'completed' : 'blocked',
          phase: block.resolved ? 'finished' : 'blocked',
          title: block.title,
          ...(block.resolved ? { detail: `Resolved: ${block.resolved}` } : {}),
          timestamp,
          blockId: block.id,
        });
        break;
      case 'error':
        items.push({
          id: `task-timeline:${block.id}:error`,
          kind: 'status',
          status: 'failed',
          phase: 'blocked',
          title: truncateText(block.text, TITLE_LIMIT) || 'Error',
          ...(block.code ? { detail: block.code } : {}),
          timestamp,
          blockId: block.id,
        });
        break;
      case 'prompt_cancelled':
        items.push({
          id: `task-timeline:${block.id}:cancelled`,
          kind: 'status',
          status: 'cancelled',
          phase: 'finished',
          title: 'Prompt cancelled',
          ...(block.reason ? { detail: block.reason } : {}),
          timestamp,
          blockId: block.id,
        });
        break;
      case 'status':
      case 'debug':
        items.push({
          id: `task-timeline:${block.id}:${block.kind}`,
          kind: 'status',
          status: 'info',
          phase: 'other',
          title: truncateText(block.text, TITLE_LIMIT) || block.kind,
          ...(block.code ? { detail: block.code } : {}),
          timestamp,
          blockId: block.id,
        });
        break;
      default:
        break;
    }
  }

  return items.slice(-MAX_TIMELINE_ITEMS);
}

export function summarizeTaskTimeline(
  items: readonly WebTaskTimelineItem[],
): WebTaskTimelineSummary {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  for (const item of items) {
    if (item.status === 'running') running += 1;
    if (item.status === 'completed') completed += 1;
    if (item.status === 'failed') failed += 1;
    if (item.status === 'blocked') blocked += 1;
  }

  const active = [...items]
    .reverse()
    .find((item) => ['running', 'pending', 'blocked'].includes(item.status));

  return {
    total: items.length,
    running,
    completed,
    failed,
    blocked,
    ...(active ? { activeTitle: active.title } : {}),
  };
}

function collectTodoEvents(
  block: DaemonToolTranscriptBlock,
  timestamp: number,
  todoStatusById: Map<string, TodoStatus>,
  items: WebTaskTimelineItem[],
) {
  const todos = extractTodosFromToolBlock(block);
  if (!todos) return;

  for (const todo of todos) {
    const previous = todoStatusById.get(todo.id);
    if (previous === todo.status) continue;
    todoStatusById.set(todo.id, todo.status);
    items.push({
      id: `task-timeline:${block.id}:todo:${todo.id}:${todo.status}`,
      kind: 'todo',
      status: mapTodoStatus(todo.status),
      phase: todo.status === 'completed' ? 'finished' : 'planning',
      title: todo.content,
      detail: todoStatusLabel(todo.status),
      timestamp,
      blockId: block.id,
      toolCallId: block.toolCallId,
      todoId: todo.id,
    });
  }
}

function extractTodosFromToolBlock(
  block: DaemonToolTranscriptBlock,
): Array<Pick<DaemonTodoItem, 'id' | 'content' | 'status'>> | undefined {
  const rawInput = getRecord(block.rawInput);
  const inputTodos = getTodoArray(rawInput);
  if (inputTodos) return parseTodoItems(inputTodos);

  const rawOutput = getRecord(block.rawOutput);
  const outputTodos = getTodoArray(rawOutput);
  if (outputTodos) return parseTodoItems(outputTodos);

  if (!isTodoToolBlock(block)) return undefined;
  const entries = Array.isArray(rawOutput?.['entries'])
    ? rawOutput['entries']
    : undefined;
  return entries ? parseTodoItems(entries) : undefined;
}

function parseTodoItems(
  entries: readonly unknown[],
): Array<Pick<DaemonTodoItem, 'id' | 'content' | 'status'>> | undefined {
  const todos = entries.flatMap((entry, index) => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    return [
      {
        id: getString(item, 'id') ?? `plan-${index}`,
        content,
        status: getTodoStatus(getString(item, 'status')),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

function isTodoToolBlock(block: DaemonToolTranscriptBlock) {
  const toolName = (block.toolName ?? '').toLowerCase();
  const toolKind = (block.toolKind ?? '').toLowerCase();
  return (
    toolName === 'todowrite' ||
    toolKind === 'updated_plan' ||
    toolKind === 'todo' ||
    toolKind === 'other'
  );
}

function inferToolPhase(
  block: DaemonToolTranscriptBlock,
  artifactPaths: readonly string[],
  checkResult: WebTaskCheckResult | undefined,
): WebTaskTimelinePhase {
  const status = mapToolStatus(block.status);
  if (checkResult) return 'checking';
  if (isTodoToolBlock(block)) return 'planning';
  if (artifactPaths.length > 0) return 'editing';
  if (status === 'failed' || status === 'cancelled' || status === 'blocked') {
    return 'blocked';
  }
  if (status === 'completed') return 'finished';
  return 'other';
}

function inferCheckResult(
  block: DaemonToolTranscriptBlock,
  timestamp: number,
): WebTaskCheckResult | undefined {
  const command = getCommand(block);
  const searchable = [block.toolName, block.title, block.details, command]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const kind = inferCheckKind(searchable);
  if (!kind) return undefined;
  return {
    kind,
    status: mapCheckStatus(block.status),
    timestamp,
    ...(command ? { command } : {}),
    blockId: block.id,
    toolCallId: block.toolCallId,
  };
}

function inferCheckKind(value: string): WebTaskCheckResult['kind'] | undefined {
  if (/\b(typecheck|tsc)\b/.test(value)) return 'typecheck';
  if (/\b(lint|eslint|biome)\b/.test(value)) return 'lint';
  if (/\b(test|vitest|jest|playwright)\b/.test(value)) return 'test';
  if (/\b(build|vite build|webpack|tsup|esbuild)\b/.test(value)) {
    return 'build';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+run\s+\w+/.test(value)) return 'command';
  return undefined;
}

function mapCheckStatus(value: string): WebTaskCheckResult['status'] {
  const status = mapToolStatus(value);
  if (status === 'completed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'running' || status === 'pending') return 'running';
  return 'unknown';
}

function getCommand(block: DaemonToolTranscriptBlock) {
  const rawInput = getRecord(block.rawInput);
  return (
    getString(rawInput, 'command') ??
    getString(rawInput, 'cmd') ??
    getString(rawInput, 'script')
  );
}

function collectArtifactPaths(
  block: DaemonToolTranscriptBlock,
  workspaceCwd?: string,
) {
  const paths = new Set<string>();
  collectPaths(block.locations, paths, workspaceCwd, 0, true);
  collectPaths(block.preview, paths, workspaceCwd, 0, true);
  collectPaths(block.rawInput, paths, workspaceCwd, 0, false);
  collectPaths(block.rawOutput, paths, workspaceCwd, 0, false);
  return Array.from(paths).slice(0, MAX_ARTIFACT_PATHS);
}

function collectPaths(
  value: unknown,
  paths: Set<string>,
  workspaceCwd: string | undefined,
  depth: number,
  acceptString: boolean,
) {
  if (paths.size >= MAX_ARTIFACT_PATHS || depth > 3 || value == null) return;
  if (typeof value === 'string') {
    const path = acceptString ? normalizePath(value, workspaceCwd) : undefined;
    if (path) paths.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, paths, workspaceCwd, depth + 1, acceptString);
    }
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const pathKey = /path|file|files|filename|location|output/i.test(key);
    if (typeof entry === 'string' && pathKey) {
      const path = normalizePath(entry, workspaceCwd);
      if (path) {
        paths.add(path);
        continue;
      }
    }
    collectPaths(
      entry,
      paths,
      workspaceCwd,
      depth + 1,
      pathKey || acceptString,
    );
  }
}

function normalizePath(value: string, workspaceCwd?: string) {
  let path = value
    .trim()
    .replace(/^@/, '')
    .replace(/^["']|["']$/g, '');
  if (!path || path.length > 180) return undefined;
  if (/^https?:\/\//.test(path)) return undefined;
  if (/[\n\r\t]/.test(path)) return undefined;
  if (workspaceCwd && path.startsWith(`${workspaceCwd}/`)) {
    path = path.slice(workspaceCwd.length + 1);
  }
  if (path.startsWith('/')) return undefined;
  if (path.startsWith('./')) path = path.slice(2);
  if (path === '.' || path.includes('..')) return undefined;
  if (!path.includes('/') && !/\.[a-z0-9]{1,8}$/i.test(path)) return undefined;
  return path;
}

function mapToolStatus(value: string): WebTaskTimelineStatus {
  const status = value.toLowerCase();
  if (
    status === 'completed' ||
    status === 'success' ||
    status === 'succeeded'
  ) {
    return 'completed';
  }
  if (status === 'pending') return 'pending';
  if (status === 'running' || status === 'in_progress') return 'running';
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('cancel')) return 'cancelled';
  if (status.includes('block')) return 'blocked';
  return 'info';
}

function mapTodoStatus(value: TodoStatus): WebTaskTimelineStatus {
  if (value === 'in_progress') return 'running';
  return value;
}

function todoStatusLabel(value: TodoStatus) {
  switch (value) {
    case 'completed':
      return 'Todo completed';
    case 'in_progress':
      return 'Todo in progress';
    default:
      return 'Todo pending';
  }
}

function getTodoStatus(value: string | undefined): TodoStatus {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoArray(
  record: Record<string, unknown> | undefined,
): readonly unknown[] | undefined {
  const todos = record?.['todos'];
  return Array.isArray(todos) ? todos : undefined;
}

function getBlockTimestamp(block: DaemonTranscriptBlock) {
  return (
    getNumber(block.serverTimestamp) ??
    block.updatedAt ??
    block.clientReceivedAt ??
    block.createdAt
  );
}

function getNumber(value: unknown) {
  return typeof value === 'number' ? value : undefined;
}

function truncateText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
