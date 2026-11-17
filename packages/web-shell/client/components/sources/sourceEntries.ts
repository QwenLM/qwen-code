import type {
  DaemonSessionAttachmentReference,
  SessionSource,
} from '@qwen-code/sdk/daemon';
import type {
  WebShellSource,
  WebShellSourceReference,
} from '../../customization';
import type { ACPToolCall, Message } from '../../adapters/types';

export function sourceKey(entry: WebShellSource): string {
  return entry.type === 'source'
    ? entry.source.id
    : `attachment:${entry.attachment.attachmentId}`;
}

export function sourceTitle(entry: WebShellSource): string {
  return entry.type === 'source'
    ? entry.source.title
    : entry.attachment.attachmentId;
}

export function sourceLocation(entry: WebShellSource): string {
  if (entry.type === 'attachment') return entry.attachment.attachmentId;
  const locator = entry.source.locator;
  return locator.type === 'url'
    ? locator.url
    : locator.type === 'workspace_file'
      ? locator.workspacePath
      : locator.attachmentId;
}

export function getSourceEntries(
  sources: readonly SessionSource[],
  attachments: readonly DaemonSessionAttachmentReference[],
): WebShellSource[] {
  const ids = new Set(
    sources.flatMap((source) =>
      source.locator.type === 'attachment' ? [source.locator.attachmentId] : [],
    ),
  );
  const entries: WebShellSource[] = sources.map((source) => ({
    type: 'source',
    source,
  }));
  for (const attachment of attachments) {
    if (ids.has(attachment.attachmentId)) continue;
    ids.add(attachment.attachmentId);
    entries.push({ type: 'attachment', attachment });
  }
  return entries;
}

function locatorKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const locator = value as Record<string, unknown>;
  if (locator['type'] === 'url' && typeof locator['url'] === 'string') {
    try {
      const url = new URL(locator['url']);
      if (url.protocol === 'https:' || url.protocol === 'http:')
        return `url:${url.href}`;
    } catch {
      /* Unresolved tool input cannot identify a registered source. */
    }
  }
  if (
    locator['type'] === 'workspace_file' &&
    typeof locator['workspacePath'] === 'string'
  ) {
    const path = locator['workspacePath'].replaceAll('\\', '/');
    if (path.startsWith('/') || /^[a-z]:/i.test(path)) return;
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return;
        parts.pop();
      } else parts.push(part);
    }
    if (parts.length) return `file:${parts.join('/')}`;
  }
  return;
}

function returnedSourceId(tool: ACPToolCall): string | undefined {
  const text = [
    typeof tool.rawOutput === 'string' ? tool.rawOutput : '',
    ...(tool.content ?? []).map((part) => part.content?.text ?? ''),
  ].join('\n');
  return /(?:^|\n)Reference added: ([a-f0-9]{64})(?:\s|$)/.exec(text)?.[1];
}

export function getSourcesByTurn(
  messages: readonly Message[],
  entries: readonly WebShellSource[],
  workspaceCwd: string | undefined,
  sessionId: string | undefined,
  references: readonly WebShellSourceReference[] = [],
): ReadonlyMap<string, readonly WebShellSource[]> {
  if (!entries.length) return new Map();
  const byId = new Map(
    entries
      .filter((entry) => entry.type === 'source')
      .map((entry) => [sourceKey(entry), entry]),
  );
  const byLocator = new Map<string, WebShellSource>();
  const byAttachment = new Map<string, WebShellSource>();
  for (const entry of entries) {
    if (entry.type === 'attachment')
      byAttachment.set(entry.attachment.attachmentId, entry);
    else {
      if (entry.source.locator.type === 'attachment')
        byAttachment.set(entry.source.locator.attachmentId, entry);
      if (
        entry.source.locator.type === 'workspace_file' &&
        (!workspaceCwd || entry.source.workspaceCwd !== workspaceCwd)
      )
        continue;
      const key = locatorKey(entry.source.locator);
      if (key) byLocator.set(key, entry);
    }
  }
  const turns = new Map<string, Set<string>>();
  let turnId: string | undefined;
  const add = (id: string, source: WebShellSource | undefined) => {
    if (source) turns.get(id)?.add(sourceKey(source));
  };
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'user_shell') {
      turnId = message.id;
      turns.set(turnId, new Set());
      if (message.role === 'user') {
        for (const attachment of [
          ...(message.images ?? []),
          ...(message.files ?? []),
        ]) {
          if (attachment.attachmentId)
            add(turnId, byAttachment.get(attachment.attachmentId));
        }
      }
      continue;
    }
    if (!turnId || message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      if (
        tool.toolName !== 'record_source' ||
        tool.status !== 'completed' ||
        tool.wasCancelled ||
        tool.parentToolCallId
      )
        continue;
      const id = returnedSourceId(tool);
      const key = locatorKey(tool.args?.['locator']);
      add(
        turnId,
        (id ? byId.get(id) : undefined) ??
          (key ? byLocator.get(key) : undefined),
      );
    }
  }
  for (const reference of references) {
    if (sessionId && reference.sessionId === sessionId)
      add(reference.turnId, byId.get(reference.sourceId));
  }
  return new Map(
    [...turns].map(([id, keys]) => [
      id,
      entries.filter((entry) => keys.has(sourceKey(entry))),
    ]),
  );
}
