import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectManagedReadingExport,
  renderManagedReadingExport,
  MANAGED_EXPORT_MAX_BYTES,
} from './managed-session-export';
import type {
  ManagedAgentProvider,
  ManagedExportItem,
  ManagedExportPage,
} from './managed-agent-provider';

const item = (id: string, value = '你好 **world**'): ManagedExportItem => ({
  itemId: id,
  sessionId: 's',
  turnId: 't',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [
    {
      partId: id,
      type: 'output_text',
      text: value,
      firstSequence: 1,
      lastSequence: 2,
    },
  ],
  attributes: {},
  firstSequence: 1,
  lastSequence: 2,
  createdAt: 1,
  updatedAt: 2,
});
function provider(pages: ManagedExportPage[], watermark = 2) {
  return {
    getSession: vi.fn().mockResolvedValue({
      sessionId: 's',
      title: 'Title',
      lastSequence: watermark,
    }),
    exportSnapshot: vi.fn().mockImplementation(async () => pages.shift()),
  } as unknown as ManagedAgentProvider;
}
afterEach(() => vi.useRealTimers());
describe('Managed reading exports', () => {
  it('collects all immutable pages and renders offline HTML with inert content', async () => {
    const api = provider([
      {
        items: [
          item(
            '1',
            '<script>alert(1)</script>\n\n![remote](https://example.com/a.png)',
          ),
        ],
        hasMore: true,
        nextCursor: 'page2',
        snapshotThroughSequence: 2,
      },
      { items: [item('2')], hasMore: false, snapshotThroughSequence: 2 },
    ]);
    const data = await collectManagedReadingExport(
      api,
      'c',
      's',
      new AbortController().signal,
    );
    expect(api.exportSnapshot).toHaveBeenLastCalledWith(
      's',
      expect.objectContaining({ cursor: 'page2' }),
    );
    expect(data.blocks).toHaveLength(2);
    const html = renderManagedReadingExport(data, 'html');
    expect(html).toContain('你好');
    expect(html).toContain('default-src');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('src="https:');
    expect(html).not.toContain('example.com/a.png');
    expect(renderManagedReadingExport(data, 'md')).toContain('你好 **world**');
  });
  it('waits for the captured watermark instead of exporting a stale tail', async () => {
    vi.useFakeTimers();
    const api = provider([
      { items: [], hasMore: false, snapshotThroughSequence: 1 },
      { items: [item('1')], hasMore: false, snapshotThroughSequence: 2 },
    ]);
    const result = collectManagedReadingExport(
      api,
      'c',
      's',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).snapshotThroughSequence).toBe(2);
  });
  it('fails after 30 seconds if materialization never catches up', async () => {
    vi.useFakeTimers();
    const api = provider([]);
    vi.mocked(api.exportSnapshot!).mockResolvedValue({
      items: [],
      hasMore: false,
      snapshotThroughSequence: 1,
    });
    const result = collectManagedReadingExport(
      api,
      'c',
      's',
      new AbortController().signal,
    );
    const rejected = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await rejected).toMatchObject({ message: 'export_not_ready' });
  });
  it.each(['watermark', 'identity', 'duplicate', 'cursor'])(
    'rejects inconsistent %s pages',
    async (mode) => {
      const first = {
        items: [item('1')],
        hasMore: true,
        nextCursor: 'next',
        snapshotThroughSequence: 2,
      };
      const second = {
        items: [item('2')],
        hasMore: false,
        nextCursor: undefined as string | undefined,
        snapshotThroughSequence: 2,
      };
      if (mode === 'watermark') second.snapshotThroughSequence = 3;
      if (mode === 'identity') second.items[0]!.sessionId = 'other';
      if (mode === 'duplicate') second.items[0]!.itemId = '1';
      if (mode === 'cursor') {
        second.hasMore = true;
        second.nextCursor = 'next';
      }
      await expect(
        collectManagedReadingExport(
          provider([first, second]),
          'c',
          's',
          new AbortController().signal,
        ),
      ).rejects.toThrow('invalid_export_snapshot');
    },
  );
  it('exports only approved public presentation fields, raster attachments and explicit truncation', async () => {
    const image = item('1');
    image.role = 'user';
    image.attributes = {
      inputAttachments: [
        { type: 'image', mimeType: 'image/png', data: 'YQ==' },
        {
          type: 'resource',
          resource: {
            uri: 'managed-input:///hello.txt',
            text: 'attached text',
          },
        },
      ],
      credential: 'SECRET',
      storageRef: 'PRIVATE',
    };
    const tool = item('2');
    tool.type = 'tool_call';
    tool.content = [];
    tool.attributes = {
      toolName: 'Shell',
      input: { command: 'echo public argument' },
      result: {
        preview: { text: 'preview', truncated: true },
        storageRef: 'PRIVATE',
      },
      receipt: 'SECRET',
    };
    const data = await collectManagedReadingExport(
      provider([
        { items: [image, tool], hasMore: false, snapshotThroughSequence: 2 },
      ]),
      'c',
      's',
      new AbortController().signal,
    );
    const html = renderManagedReadingExport(data, 'html');
    expect(html).toContain('data:image/png;base64,YQ==');
    expect(html).toContain('attached text');
    expect(html).toContain('echo public argument');
    expect(html).toContain('1970-01-01T00:00:00.001Z');
    expect(html).toContain('Truncated preview');
    expect(renderManagedReadingExport(data, 'md')).toContain(
      'echo public argument',
    );
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('PRIVATE');
  });
  it('propagates cursor expiry without downloading a partial transcript', async () => {
    const api = provider([]);
    vi.mocked(api.exportSnapshot!)
      .mockResolvedValueOnce({
        items: [item('1')],
        hasMore: true,
        nextCursor: 'next',
        snapshotThroughSequence: 2,
      })
      .mockRejectedValueOnce(new Error('cursor_expired'));
    await expect(
      collectManagedReadingExport(api, 'c', 's', new AbortController().signal),
    ).rejects.toThrow('cursor_expired');
    expect(api.exportSnapshot).toHaveBeenCalledTimes(2);
    expect(api.exportSnapshot).toHaveBeenLastCalledWith(
      's',
      expect.objectContaining({ cursor: 'next' }),
    );
  });
  it('rejects oversized output', () => {
    expect(() =>
      renderManagedReadingExport(
        {
          session: { title: 'title', sessionId: 's' } as never,
          exportedAt: 'now',
          snapshotThroughSequence: 1,
          blocks: [
            {
              role: 'assistant',
              text: 'x'.repeat(MANAGED_EXPORT_MAX_BYTES),
              images: [],
            },
          ],
        },
        'md',
      ),
    ).toThrow('export_too_large');
  });
});
