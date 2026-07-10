import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message } from '../../adapters/types';
import type {
  TurnOutputFileChange,
  TurnOutputScheduledTask,
} from './TurnOutputs';
import { isSamePath, normalizePath } from './artifactUtils';

const MAX_LINE_STAT_COMPARISONS = 1_000_000;

function getToolCallIds(tool: ACPToolCall): string[] {
  const ids = new Set<string>();
  if (tool.callId) ids.add(tool.callId);
  if (tool.parentToolCallId) ids.add(tool.parentToolCallId);
  for (const subTool of tool.subTools ?? []) {
    for (const id of getToolCallIds(subTool)) ids.add(id);
  }
  return Array.from(ids);
}

interface RecordArtifactReference {
  turnId: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
}

export function getArtifactsByTurn(
  messages: readonly Message[],
  artifacts: readonly DaemonSessionArtifact[],
  workspaceCwd?: string,
): ReadonlyMap<string, readonly DaemonSessionArtifact[]> {
  const toolCallTurn = new Map<string, string>();
  const recordArtifactReferences: RecordArtifactReference[] = [];
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
      collectRecordArtifactReferences(
        tool,
        currentTurnId,
        recordArtifactReferences,
      );
    }
  }

  const byTurn = new Map<string, DaemonSessionArtifact[]>();
  for (const artifact of artifacts) {
    const turnIds = getRecordArtifactTurnIds(
      recordArtifactReferences,
      artifact,
      workspaceCwd,
    );
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

function collectRecordArtifactReferences(
  tool: ACPToolCall,
  turnId: string,
  references: RecordArtifactReference[],
) {
  if (tool.toolName.toLowerCase() === 'record_artifact') {
    references.push({
      turnId,
      workspacePath: getStringField(tool.args, 'workspacePath'),
      managedId: getStringField(tool.args, 'managedId'),
      url: getStringField(tool.args, 'url'),
    });
  }
  for (const subTool of tool.subTools ?? []) {
    collectRecordArtifactReferences(subTool, turnId, references);
  }
}

function getRecordArtifactTurnIds(
  references: readonly RecordArtifactReference[],
  artifact: DaemonSessionArtifact,
  workspaceCwd?: string,
) {
  const turnIds = new Set<string>();
  for (const reference of references) {
    if (
      reference.workspacePath &&
      artifact.workspacePath &&
      isSameWorkspacePath(
        reference.workspacePath,
        artifact.workspacePath,
        workspaceCwd,
      )
    ) {
      turnIds.add(reference.turnId);
      continue;
    }
    if (reference.managedId && reference.managedId === artifact.managedId) {
      turnIds.add(reference.turnId);
      continue;
    }
    if (reference.url && reference.url === artifact.url) {
      turnIds.add(reference.turnId);
    }
  }
  return turnIds;
}

export function getFileChangesByTurn(
  messages: readonly Message[],
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
  workspaceCwd?: string,
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
        .map((artifact) => normalizePath(artifact.workspacePath))
        .filter((path): path is string => Boolean(path)),
    );
    for (const tool of message.tools) {
      collectFileChanges(
        tool,
        currentTurnId,
        artifactPaths,
        byTurn,
        workspaceCwd,
      );
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
  workspaceCwd?: string,
) {
  const change = getFileChange(tool, artifactPaths, workspaceCwd);
  if (change) {
    const list = byTurn.get(turnId);
    if (list) {
      upsertFileChange(list, change);
    } else {
      byTurn.set(turnId, [change]);
    }
  }
  for (const subTool of tool.subTools ?? []) {
    collectFileChanges(subTool, turnId, artifactPaths, byTurn, workspaceCwd);
  }
}

function getFileChange(
  tool: ACPToolCall,
  artifactPaths: ReadonlySet<string>,
  workspaceCwd?: string,
): TurnOutputFileChange | null {
  if (tool.status !== 'completed') return null;
  const toolName = tool.toolName.toLowerCase();
  if (toolName !== 'write_file' && toolName !== 'edit') return null;
  const filePath = getToolFilePath(tool);
  if (!filePath) return null;
  const normalizedPath = normalizePath(filePath);
  const status = inferFileChangeStatus(tool);
  const diffs = getFileChangeDiffs(tool);
  const lineStats = getFileChangeLineStats(diffs);
  return {
    path: filePath,
    status,
    toolCallId: tool.callId,
    isArtifact: Array.from(artifactPaths).some((artifactPath) =>
      isSameWorkspacePath(normalizedPath, artifactPath, workspaceCwd),
    ),
    ...(lineStats
      ? { additions: lineStats.additions, deletions: lineStats.deletions }
      : {}),
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

function getStringContentField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function inferFileChangeStatus(
  tool: ACPToolCall,
): TurnOutputFileChange['status'] {
  if (tool.toolName.toLowerCase() === 'write_file') return 'created';
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

function getFileChangeLineStats(diffs: TurnOutputFileChange['diffs']):
  | {
      additions: number;
      deletions: number;
    }
  | undefined {
  const fullDiff = getFinalFullContentDiff(diffs);
  return fullDiff
    ? countChangedLines(fullDiff.oldText, fullDiff.newText)
    : undefined;
}

function getFileChangeDiffs(tool: ACPToolCall): TurnOutputFileChange['diffs'] {
  const raw = getRawOutputRecord(tool);
  const originalContent = getStringContentField(raw, 'originalContent');
  const newContent = getStringContentField(raw, 'newContent');
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
    const newText = getStringContentField(tool.args, 'content');
    return newText !== undefined
      ? [{ oldText: '', newText, fullContent: true }]
      : [];
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
    /\bScheduled\s+(?:recurring job|one-shot task)\s+([a-z0-9_-]+)\b/i,
  )?.[1];
}

function getScheduledTaskTitle(prompt: string) {
  const firstLine = getFirstLine(prompt) ?? prompt.trim();
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}...` : firstLine;
}

function collectText(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): string {
  if (depth > 100) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '';
    seen.add(value);
    return value.map((item) => collectText(item, seen, depth + 1)).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  return Object.values(value as Record<string, unknown>)
    .map((item) => collectText(item, seen, depth + 1))
    .join('\n');
}

function upsertFileChange(
  list: TurnOutputFileChange[],
  change: TurnOutputFileChange,
) {
  const normalizedChangePath = normalizePath(change.path);
  const index = list.findIndex(
    (existing) => normalizePath(existing.path) === normalizedChangePath,
  );
  if (index < 0) {
    list.push(change);
    return;
  }
  const existing = list[index]!;
  const {
    additions: _existingAdditions,
    deletions: _existingDeletions,
    ...existingWithoutLineStats
  } = existing;
  const diffs = mergeFileDiffs(existing.diffs, change.diffs);
  const finalFullDiff = getFinalFullContentDiff(diffs);
  const lineStats = finalFullDiff
    ? countChangedLines(finalFullDiff.oldText, finalFullDiff.newText)
    : undefined;
  list[index] = {
    ...existingWithoutLineStats,
    status:
      existing.status === 'created' || change.status === 'created'
        ? 'created'
        : 'modified',
    isArtifact: existing.isArtifact || change.isArtifact,
    ...(lineStats
      ? { additions: lineStats.additions, deletions: lineStats.deletions }
      : {}),
    diffs,
  };
}

function mergeFileDiffs(
  existingDiffs: TurnOutputFileChange['diffs'],
  nextDiffs: TurnOutputFileChange['diffs'],
): TurnOutputFileChange['diffs'] {
  const diffs = [...existingDiffs, ...nextDiffs];
  if (!diffs.every((diff) => diff.fullContent)) return diffs;
  const firstFullDiff = diffs[0];
  const lastFullDiff = diffs.at(-1);
  if (!firstFullDiff || !lastFullDiff) return diffs;
  return [
    {
      oldText: firstFullDiff.oldText,
      newText: lastFullDiff.newText,
      fullContent: true,
    },
  ];
}

function getFinalFullContentDiff(diffs: TurnOutputFileChange['diffs']) {
  const finalDiff = diffs.at(-1);
  return finalDiff?.fullContent ? finalDiff : undefined;
}

function countChangedLines(oldText: string, newText: string) {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  if (oldLines.length * newLines.length > MAX_LINE_STAT_COMPARISONS) {
    return undefined;
  }
  const commonLines = countLongestCommonSubsequence(oldLines, newLines);
  return {
    additions: newLines.length - commonLines,
    deletions: oldLines.length - commonLines,
  };
}

function splitDiffLines(text: string) {
  if (!text) return [];
  return text.replace(/\r?\n$/, '').split(/\r\n|\r|\n/);
}

function countLongestCommonSubsequence(left: string[], right: string[]) {
  const previous = new Array(right.length + 1).fill(0);
  const current = new Array(right.length + 1).fill(0);
  for (const leftLine of left) {
    for (let index = 0; index < right.length; index++) {
      current[index + 1] =
        leftLine === right[index]
          ? previous[index] + 1
          : Math.max(previous[index + 1], current[index]);
    }
    for (let index = 0; index < current.length; index++) {
      previous[index] = current[index];
    }
    current.fill(0);
  }
  return previous[right.length] ?? 0;
}

function isSameWorkspacePath(
  left: string,
  right: string,
  workspaceCwd?: string,
) {
  return isSamePath(left, right, workspaceCwd);
}
