import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedExportItem,
  ManagedExportPage,
} from './managed-agent-provider';

export const MANAGED_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
interface ExportBlock {
  role: string;
  createdAt?: string;
  text: string;
  images: { data: string; mimeType: string }[];
}
export interface ManagedReadingExport {
  session: ManagedAgentSessionSummary;
  exportedAt: string;
  snapshotThroughSequence: number;
  blocks: ExportBlock[];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}
function blocks(items: readonly ManagedExportItem[]): ExportBlock[] {
  return items.map((item) => {
    const attributes = object(item.attributes);
    const result = object(attributes['result']);
    const preview = object(result['preview']);
    const images: ExportBlock['images'] = [];
    const parts = item.content.filter((part) => part.text);
    const hasReasoning = parts.some((part) => part.type === 'reasoning');
    const reasoningOnly =
      hasReasoning && parts.every((part) => part.type === 'reasoning');
    const content = parts.map((part) =>
      hasReasoning && !reasoningOnly
        ? `### ${part.type === 'reasoning' ? 'Public reasoning' : 'Assistant answer'}\n\n${part.text}`
        : part.text!,
    );
    const attachments: unknown[] = Array.isArray(attributes['inputAttachments'])
      ? attributes['inputAttachments']
      : [];
    for (const raw of attachments) {
      const attachment = object(raw);
      if (attachment['type'] === 'image') {
        const mimeType = text(attachment['mimeType']);
        const data = text(attachment['data']);
        if (
          /^image\/(png|jpeg|gif|webp)$/.test(mimeType) &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(data)
        )
          images.push({ data, mimeType });
        else content.push('[Image attachment]');
      } else if (attachment['type'] === 'resource') {
        const resource = object(attachment['resource']);
        const uri = text(resource['uri']);
        if (uri.startsWith('managed-input:///')) {
          let name = uri.slice('managed-input:///'.length);
          try {
            name = decodeURIComponent(name);
          } catch {
            /* Keep the display name. */
          }
          content.push(`[Attachment: ${name}]\n${text(resource['text'])}`);
        }
      }
    }
    if (item.type === 'tool_call') {
      content.push(
        text(attributes['title']) || text(attributes['name']) || 'Tool',
      );
      content.push('[Arguments not included in this public snapshot.]');
      content.push(
        text(preview['text']) ||
          '[Result preview not included in this public snapshot.]',
      );
      if (
        preview['truncated'] === true ||
        result['truncated'] === true ||
        attributes['truncated'] === true
      )
        content.push(
          '[Truncated preview — download the full Artifact separately.]',
        );
    }
    return {
      role:
        item.type === 'tool_call'
          ? `tool · ${item.status}`
          : reasoningOnly
            ? 'reasoning'
            : item.role || item.type,
      createdAt: new Date(item.createdAt).toISOString(),
      text: content.filter(Boolean).join('\n\n'),
      images,
    };
  });
}
function delay(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 1_000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
export async function collectManagedReadingExport(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<ManagedReadingExport> {
  if (!provider.exportSnapshot) throw new Error('unsupported_export');
  const preparation = new AbortController();
  const cancelPreparation = () => preparation.abort(signal.reason);
  signal.addEventListener('abort', cancelPreparation, { once: true });
  if (signal.aborted) cancelPreparation();
  const timer = setTimeout(() => preparation.abort(), 30_000);
  let session: ManagedAgentSessionSummary;
  let page: ManagedExportPage;
  try {
    session = await provider.getSession(sessionId, {
      clientId,
      signal: preparation.signal,
    });
    if (
      session.sessionId !== sessionId ||
      !Number.isSafeInteger(session.lastSequence) ||
      session.lastSequence! < 0
    )
      throw new Error('invalid_export_snapshot');
    do {
      preparation.signal.throwIfAborted();
      page = await provider.exportSnapshot(sessionId, {
        clientId,
        signal: preparation.signal,
      });
      if (
        !Number.isSafeInteger(page.snapshotThroughSequence) ||
        page.snapshotThroughSequence < 0
      )
        throw new Error('invalid_export_snapshot');
      if (page.snapshotThroughSequence >= session.lastSequence!) break;
      await delay(preparation.signal);
    } while (page.snapshotThroughSequence < session.lastSequence!);
  } catch (error) {
    if (preparation.signal.aborted && !signal.aborted)
      throw new Error('export_not_ready');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancelPreparation);
    preparation.abort();
  }
  const watermark = page.snapshotThroughSequence;
  if (!Number.isSafeInteger(watermark) || watermark < 0)
    throw new Error('invalid_export_snapshot');
  const items: ManagedExportItem[] = [];
  const cursors = new Set<string>();
  const identities = new Set<string>();
  let bytes = 0;
  while (true) {
    signal.throwIfAborted();
    if (page.snapshotThroughSequence !== watermark)
      throw new Error('invalid_export_snapshot');
    bytes += new TextEncoder().encode(JSON.stringify(page.items)).byteLength;
    if (bytes > MANAGED_EXPORT_MAX_BYTES) throw new Error('export_too_large');
    for (const item of page.items) {
      if (
        item.sessionId !== sessionId ||
        identities.has(item.itemId) ||
        !Number.isSafeInteger(item.firstSequence) ||
        !Number.isSafeInteger(item.lastSequence) ||
        item.firstSequence < 0 ||
        item.firstSequence > item.lastSequence ||
        item.lastSequence > watermark
      )
        throw new Error('invalid_export_snapshot');
      identities.add(item.itemId);
      items.push(item);
    }
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new Error('invalid_export_snapshot');
    cursors.add(page.nextCursor);
    page = await provider.exportSnapshot(sessionId, {
      clientId,
      cursor: page.nextCursor,
      signal,
    });
  }
  return {
    session,
    exportedAt: new Date().toISOString(),
    snapshotThroughSequence: watermark,
    blocks: blocks(items),
  };
}

export function renderManagedReadingExport(
  data: ManagedReadingExport,
  format: 'html' | 'md',
): string {
  let content: string;
  const title = data.session.title || data.session.sessionId;
  if (format === 'md') {
    content =
      `# ${title.replace(/[\r\n]/g, ' ')}\n\nSession: ${data.session.sessionId}\n\nExported: ${data.exportedAt}\n\nSnapshot: ${data.snapshotThroughSequence}\n\n` +
      data.blocks
        .map(
          (block) =>
            `## ${block.role}\n\n${block.createdAt || ''}\n\n${block.text}\n\n${block.images.map(() => '[Image attachment]').join('\n')}\n`,
        )
        .join('\n');
  } else {
    const body = renderToStaticMarkup(
      <main>
        <h1>{title}</h1>
        <p>
          {data.session.sessionId} · {data.exportedAt} · Snapshot{' '}
          {data.snapshotThroughSequence}
        </p>
        {data.blocks.map((block, index) => (
          <section key={index}>
            <h2>{block.role}</h2>
            {block.createdAt && <time>{block.createdAt}</time>}
            {block.role.startsWith('tool') ? (
              <pre>{block.text}</pre>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt }) => <span>[{alt || 'Image'}]</span>,
                }}
              >
                {block.text}
              </ReactMarkdown>
            )}
            {block.images.map((image, index) => (
              <img
                key={index}
                alt="Attachment"
                src={`data:${image.mimeType};base64,${image.data}`}
              />
            ))}
          </section>
        ))}
      </main>,
    );
    content =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\">" +
      '<title>Qwen Code conversation</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#202124;background:#fff}main{max-width:900px;margin:32px auto;padding:0 20px}section{border-top:1px solid #ddd;padding:16px 0}h2{font-size:16px;color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:12px}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}</style></head><body>' +
      body +
      '</body></html>';
  }
  if (new TextEncoder().encode(content).byteLength > MANAGED_EXPORT_MAX_BYTES)
    throw new Error('export_too_large');
  return content;
}
export async function downloadManagedSession(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string,
  format: 'html' | 'md',
  signal: AbortSignal,
) {
  const data = await collectManagedReadingExport(
    provider,
    clientId,
    sessionId,
    signal,
  );
  signal.throwIfAborted();
  const blob = new Blob([renderManagedReadingExport(data, format)], {
    type:
      format === 'html'
        ? 'text/html;charset=utf-8'
        : 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${data.session.title.replace(/[^\p{L}\p{N} _-]/gu, '_').slice(0, 80) || 'session'}-${sessionId.slice(0, 8)}.${format}`;
  link.addEventListener('click', (event) => event.stopPropagation(), {
    once: true,
  });
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
