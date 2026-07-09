import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message } from '../../adapters/types';
import type {
  TurnOutputFileChange,
  TurnOutputScheduledTask,
} from './TurnOutputs';

function getToolCallIds(tool: ACPToolCall): string[] {
  const ids = new Set<string>();
  if (tool.callId) ids.add(tool.callId);
  if (tool.parentToolCallId) ids.add(tool.parentToolCallId);
  for (const subTool of tool.subTools ?? []) {
    for (const id of getToolCallIds(subTool)) ids.add(id);
  }
  return Array.from(ids);
}

export function getArtifactsByTurn(
  messages: readonly Message[],
  artifacts: readonly DaemonSessionArtifact[],
): ReadonlyMap<string, readonly DaemonSessionArtifact[]> {
  const toolCallTurn = new Map<string, string>();
  let currentTurnId: string | null = null;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'user_shell') {
      currentTurnId = message.id;
      continue;
    }
    if (message.role !== 'tool_group' || !currentTurnId) continue;
    for (const tool of message.tools) {
      for (const id of getToolCallIds(tool)) {
        toolCallTurn.set(id, currentTurnId);
      }
    }
  }

  const byTurn = new Map<string, DaemonSessionArtifact[]>();
  for (const artifact of artifacts) {
    const turnIds = getRecordArtifactTurnIds(messages, artifact);
    if (turnIds.size === 0 && artifact.toolCallId) {
      const turnId = toolCallTurn.get(artifact.toolCallId);
      if (turnId) turnIds.add(turnId);
    }
    for (const turnId of turnIds) {
      const list = byTurn.get(turnId);
      if (list) {
        if (!list.some((item) => item.id === artifact.id)) list.push(artifact);
      } else {
        byTurn.set(turnId, [artifact]);
      }
    }
  }
  return byTurn;
}

function getRecordArtifactTurnIds(
  messages: readonly Message[],
  artifact: DaemonSessionArtifact,
) {
  const turnIds = new Set<string>();
  let currentTurnId: string | null = null;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'user_shell') {
      currentTurnId = message.id;
      continue;
    }
    if (message.role !== 'tool_group' || !currentTurnId) continue;
    for (const tool of message.tools) {
      if (recordArtifactToolMatches(tool, artifact)) {
        turnIds.add(currentTurnId);
      }
    }
  }
  return turnIds;
}

function recordArtifactToolMatches(
  tool: ACPToolCall,
  artifact: DaemonSessionArtifact,
): boolean {
  if (tool.toolName.toLowerCase() === 'record_artifact') {
    const workspacePath = getStringField(tool.args, 'workspacePath');
    if (
      workspacePath &&
      artifact.workspacePath &&
      isSameWorkspacePath(
        normalizeWorkspacePath(workspacePath) ?? workspacePath,
        normalizeWorkspacePath(artifact.workspacePath) ??
          artifact.workspacePath,
      )
    ) {
      return true;
    }
    const managedId = getStringField(tool.args, 'managedId');
    if (managedId && managedId === artifact.managedId) return true;
    const url = getStringField(tool.args, 'url');
    if (url && url === artifact.url) return true;
  }
  return (tool.subTools ?? []).some((subTool) =>
    recordArtifactToolMatches(subTool, artifact),
  );
}

export function getFileChangesByTurn(
  messages: readonly Message[],
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
): ReadonlyMap<string, readonly TurnOutputFileChange[]> {
  const byTurn = new Map<string, TurnOutputFileChange[]>();
  let currentTurnId: string | null = null;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'user_shell') {
      currentTurnId = message.id;
      continue;
    }
    if (message.role !== 'tool_group' || !currentTurnId) continue;
    const artifactPaths = new Set(
      (artifactsByTurn.get(currentTurnId) ?? [])
        .map((artifact) => normalizeWorkspacePath(artifact.workspacePath))
        .filter((path): path is string => Boolean(path)),
    );
    for (const tool of message.tools) {
      collectFileChanges(tool, currentTurnId, artifactPaths, byTurn);
    }
  }
  return byTurn;
}

export function getScheduledTasksByTurn(
  messages: readonly Message[],
): ReadonlyMap<string, readonly TurnOutputScheduledTask[]> {
  const byTurn = new Map<string, TurnOutputScheduledTask[]>();
  let currentTurnId: string | null = null;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'user_shell') {
      currentTurnId = message.id;
      continue;
    }
    if (message.role !== 'tool_group' || !currentTurnId) continue;
    for (const tool of message.tools) {
      collectScheduledTasks(tool, currentTurnId, byTurn);
    }
  }
  return byTurn;
}

function collectScheduledTasks(
  tool: ACPToolCall,
  turnId: string,
  byTurn: Map<string, TurnOutputScheduledTask[]>,
) {
  const task = getScheduledTask(tool);
  if (task) {
    const list = byTurn.get(turnId);
    if (list) {
      list.push(task);
    } else {
      byTurn.set(turnId, [task]);
    }
  }
  for (const subTool of tool.subTools ?? []) {
    collectScheduledTasks(subTool, turnId, byTurn);
  }
}

function getScheduledTask(tool: ACPToolCall): TurnOutputScheduledTask | null {
  if (tool.status !== 'completed') return null;
  if (tool.toolName.toLowerCase() !== 'cron_create') return null;
  const raw = getRawOutputRecord(tool);
  if (raw?.error) return null;
  const cron = getStringField(tool.args, 'cron');
  const prompt = getStringField(tool.args, 'prompt');
  if (!cron || !prompt) return null;
  const outputText = collectText(tool.rawOutput);
  const display =
    getStringField(raw, 'returnDisplay') || getFirstLine(outputText);
  return {
    id: getCronTaskId(outputText) ?? tool.callId,
    toolCallId: tool.callId,
    title: getScheduledTaskTitle(prompt),
    cron,
    prompt,
    recurring: getBooleanField(tool.args, 'recurring') ?? true,
    durable: getBooleanField(tool.args, 'durable') ?? false,
    ...(display ? { display } : {}),
  };
}

function collectFileChanges(
  tool: ACPToolCall,
  turnId: string,
  artifactPaths: ReadonlySet<string>,
  byTurn: Map<string, TurnOutputFileChange[]>,
) {
  const change = getFileChange(tool, artifactPaths);
  if (change) {
    const list = byTurn.get(turnId);
    if (list) {
      upsertFileChange(list, change);
    } else {
      byTurn.set(turnId, [change]);
    }
  }
  for (const subTool of tool.subTools ?? []) {
    collectFileChanges(subTool, turnId, artifactPaths, byTurn);
  }
}

function getFileChange(
  tool: ACPToolCall,
  artifactPaths: ReadonlySet<string>,
): TurnOutputFileChange | null {
  if (tool.status !== 'completed') return null;
  const toolName = tool.toolName.toLowerCase();
  if (toolName !== 'write_file' && toolName !== 'edit') return null;
  const filePath = getToolFilePath(tool);
  if (!filePath) return null;
  const normalizedPath = normalizeWorkspacePath(filePath);
  const status = inferFileChangeStatus(tool);
  const lineStats = getFileChangeLineStats(tool);
  const diffs = getFileChangeDiffs(tool);
  return {
    path: filePath,
    status,
    toolCallId: tool.callId,
    isArtifact:
      normalizedPath !== undefined &&
      Array.from(artifactPaths).some((artifactPath) =>
        isSameWorkspacePath(normalizedPath, artifactPath),
      ),
    additions: lineStats.additions,
    deletions: lineStats.deletions,
    diffs,
  };
}

function getToolFilePath(tool: ACPToolCall): string | undefined {
  const fromArgs = getStringField(tool.args, 'file_path', 'filePath', 'path');
  if (fromArgs) return fromArgs;
  for (const content of tool.content ?? []) {
    if (content.path) return content.path;
  }
  return tool.locations?.[0]?.file;
}

function getStringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function inferFileChangeStatus(
  tool: ACPToolCall,
): TurnOutputFileChange['status'] {
  const output = collectText(tool.rawOutput).toLowerCase();
  if (
    output.includes('created new file') ||
    output.includes('successfully created') ||
    output.includes('created and wrote')
  ) {
    return 'created';
  }
  return 'modified';
}

function getFileChangeLineStats(tool: ACPToolCall): {
  additions: number;
  deletions: number;
} {
  const raw = getRawOutputRecord(tool);
  const diffStat =
    raw?.diffStat && typeof raw.diffStat === 'object'
      ? (raw.diffStat as Record<string, unknown>)
      : undefined;
  if (diffStat) {
    return {
      additions: getNumberField(diffStat, 'model_added_lines'),
      deletions: getNumberField(diffStat, 'model_removed_lines'),
    };
  }

  let additions = 0;
  let deletions = 0;
  for (const content of tool.content ?? []) {
    if (content.type !== 'diff') continue;
    additions += countLines(content.newText);
    deletions += countLines(content.oldText);
  }
  if (additions > 0 || deletions > 0) return { additions, deletions };
  if (tool.toolName.toLowerCase() === 'write_file') {
    return {
      additions: countLines(getStringField(tool.args, 'content')),
      deletions: 0,
    };
  }
  return { additions: 0, deletions: 0 };
}

function getFileChangeDiffs(tool: ACPToolCall): TurnOutputFileChange['diffs'] {
  const raw = getRawOutputRecord(tool);
  const originalContent = getStringField(raw, 'originalContent');
  const newContent = getStringField(raw, 'newContent');
  if (originalContent !== undefined || newContent !== undefined) {
    return [
      {
        oldText: originalContent ?? '',
        newText: newContent ?? '',
        fileDiff: getStringField(raw, 'fileDiff'),
        fullContent: true,
      },
    ];
  }

  const diffs = [];
  for (const content of tool.content ?? []) {
    if (content.type !== 'diff') continue;
    diffs.push({
      oldText: content.oldText ?? '',
      newText: content.newText ?? '',
    });
  }
  if (diffs.length > 0) return diffs;
  if (tool.toolName.toLowerCase() === 'write_file') {
    const newText = getStringField(tool.args, 'content');
    return newText ? [{ oldText: '', newText, fullContent: true }] : [];
  }
  return [];
}

function getRawOutputRecord(
  tool: ACPToolCall,
): Record<string, unknown> | undefined {
  return tool.rawOutput && typeof tool.rawOutput === 'object'
    ? (tool.rawOutput as Record<string, unknown>)
    : undefined;
}

function getNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getBooleanField(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getFirstLine(text: string) {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function getCronTaskId(text: string) {
  return text.match(
    /\bScheduled\s+(?:recurring job|one-shot task|)(?:\s+)?([a-z0-9_-]+)\b/i,
  )?.[1];
}

function getScheduledTaskTitle(prompt: string) {
  const firstLine = getFirstLine(prompt) ?? prompt.trim();
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}...` : firstLine;
}

function countLines(text: string | undefined) {
  if (!text) return 0;
  return text.replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value as Record<string, unknown>)
    .map(collectText)
    .join('\n');
}

function upsertFileChange(
  list: TurnOutputFileChange[],
  change: TurnOutputFileChange,
) {
  const index = list.findIndex(
    (existing) =>
      normalizeWorkspacePath(existing.path) ===
      normalizeWorkspacePath(change.path),
  );
  if (index < 0) {
    list.push(change);
    return;
  }
  const existing = list[index]!;
  list[index] = {
    ...existing,
    status:
      existing.status === 'created' || change.status === 'created'
        ? 'created'
        : 'modified',
    isArtifact: existing.isArtifact || change.isArtifact,
    additions: existing.additions + change.additions,
    deletions: existing.deletions + change.deletions,
    diffs: [...existing.diffs, ...change.diffs],
  };
}

function normalizeWorkspacePath(filePath: string | undefined) {
  return filePath?.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isSameWorkspacePath(left: string, right: string) {
  if (left === right) return true;
  if (left.startsWith('/') && !right.startsWith('/')) {
    return left.endsWith(`/${right}`);
  }
  if (right.startsWith('/') && !left.startsWith('/')) {
    return right.endsWith(`/${left}`);
  }
  return false;
}
