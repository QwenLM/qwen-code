import type {
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/webui/daemon-react-sdk';
import type { WebArtifact, WebArtifactOperation } from './artifactTypes';

const MAX_ARTIFACTS = 50;
const MAX_COLLECTED_PATHS = 8;

interface CollectArtifactsOptions {
  workspaceCwd?: string;
}

interface ArtifactDraft {
  path: string;
  operation: WebArtifactOperation;
  title?: string;
  toolName?: string;
  updatedAt: number;
  readCount: number;
  writeCount: number;
}

export function collectArtifactsFromTranscript(
  blocks: readonly DaemonTranscriptBlock[],
  options: CollectArtifactsOptions = {},
): WebArtifact[] {
  const artifacts = new Map<string, ArtifactDraft>();

  for (const block of blocks) {
    if (!isToolBlock(block)) continue;
    const operation = inferOperation(block);
    const paths = collectToolPaths(block, options.workspaceCwd);
    for (const path of paths) {
      const existing = artifacts.get(path);
      if (existing) {
        existing.operation = mergeOperation(existing.operation, operation);
        existing.updatedAt = Math.max(existing.updatedAt, block.updatedAt);
        existing.title = block.title || existing.title;
        existing.toolName = block.toolName ?? existing.toolName;
        if (operation === 'read') existing.readCount += 1;
        if (isWriteOperation(operation)) existing.writeCount += 1;
        continue;
      }
      artifacts.set(path, {
        path,
        operation,
        title: block.title,
        toolName: block.toolName,
        updatedAt: block.updatedAt,
        readCount: operation === 'read' ? 1 : 0,
        writeCount: isWriteOperation(operation) ? 1 : 0,
      });
    }
  }

  return Array.from(artifacts.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ARTIFACTS)
    .map((artifact) => ({
      id: `web-artifact:${artifact.path}`,
      path: artifact.path,
      operation: artifact.operation,
      source: 'transcript_tool',
      ...(artifact.title ? { title: artifact.title } : {}),
      ...(artifact.toolName ? { toolName: artifact.toolName } : {}),
      updatedAt: artifact.updatedAt,
      ...(artifact.readCount > 0 ? { readCount: artifact.readCount } : {}),
      ...(artifact.writeCount > 0 ? { writeCount: artifact.writeCount } : {}),
      diffAvailable: false,
    }));
}

function collectToolPaths(
  block: DaemonToolTranscriptBlock,
  workspaceCwd?: string,
) {
  const paths = new Set<string>();
  collectPaths(block.locations, paths, workspaceCwd, 0, true);
  collectPaths(block.preview, paths, workspaceCwd, 0, true);
  collectPaths(block.rawInput, paths, workspaceCwd, 0, false);
  collectPaths(block.rawOutput, paths, workspaceCwd, 0, false);
  return Array.from(paths).slice(0, MAX_COLLECTED_PATHS);
}

function collectPaths(
  value: unknown,
  paths: Set<string>,
  workspaceCwd: string | undefined,
  depth: number,
  acceptString: boolean,
) {
  if (paths.size >= MAX_COLLECTED_PATHS || depth > 3 || value == null) return;
  if (typeof value === 'string') {
    const path = acceptString ? normalizePath(value, workspaceCwd) : undefined;
    if (path) paths.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      collectPaths(item, paths, workspaceCwd, depth + 1, acceptString);
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
    .replace(/^['"]|['"]$/g, '');
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

function inferOperation(
  block: DaemonToolTranscriptBlock,
): WebArtifactOperation {
  const name = `${block.toolName ?? ''} ${block.toolKind ?? ''} ${block.title}`
    .trim()
    .toLowerCase();
  if (/\b(write|create)\b/.test(name)) return 'produced';
  if (/\b(edit|modify|notebookedit|patch)\b/.test(name)) return 'modified';
  if (/\b(read|grep|glob|list|stat)\b/.test(name)) return 'read';
  return 'referenced';
}

function mergeOperation(
  previous: WebArtifactOperation,
  next: WebArtifactOperation,
): WebArtifactOperation {
  return operationRank(next) > operationRank(previous) ? next : previous;
}

function operationRank(value: WebArtifactOperation) {
  switch (value) {
    case 'produced':
      return 4;
    case 'modified':
      return 3;
    case 'read':
      return 2;
    case 'referenced':
      return 1;
    default:
      return 0;
  }
}

function isWriteOperation(value: WebArtifactOperation) {
  return value === 'modified' || value === 'produced';
}

function isToolBlock(
  block: DaemonTranscriptBlock,
): block is DaemonToolTranscriptBlock {
  return block.kind === 'tool';
}
