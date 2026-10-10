// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  ManagedToolResultPanel,
  MANAGED_OUTPUT_PAGE_BYTES,
} from './ManagedToolResultPanel';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import {
  artifact,
  result,
  notStartedResult,
  blockedResult,
  previewOnlyResult,
} from './managed-tool-result.test-fixtures';
import type { ManagedToolResultReader } from './managed-tool-result-types';

describe('ManagedToolResultPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  let reader: ManagedToolResultReader;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    close = vi.fn();
    reader = {
      canDownload: true,
      getResult: vi
        .fn()
        .mockResolvedValue({ result, access: { can_read_content: true } }),
      getArtifact: vi
        .fn()
        .mockResolvedValue({ artifact, access: { can_read_content: true } }),
      listArtifacts: vi.fn().mockResolvedValue({
        data: [{ artifact, access: { can_read_content: true } }],
        hasMore: false,
        nextCursor: null,
      }),
      readRange: vi
        .fn()
        .mockImplementation(async (_artifact, offset: number, length: number) =>
          new TextEncoder().encode('hello').slice(offset, offset + length),
        ),
      downloadArtifact: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  async function render(
    sessionId = 'session-1',
    itemId: string | null = 'item-1',
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ManagedToolResultPanel
            reader={reader}
            sessionId={sessionId}
            itemId={itemId ?? undefined}
            clientId="client"
            onClose={close}
          />
        </I18nProvider>,
      );
      await flush();
    });
  }
  async function click(label: string) {
    const button = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  it('keeps listed artifacts and selection when loading another page', async () => {
    const second = { ...artifact, id: 'artifact-2', byte_length: 6 };
    vi.mocked(reader.listArtifacts)
      .mockResolvedValueOnce({
        data: [{ artifact, access: { can_read_content: true } }],
        hasMore: true,
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ artifact: second, access: { can_read_content: true } }],
        hasMore: false,
        nextCursor: null,
      });
    await render('session-1', null);
    await click('Load more');
    expect(document.body.textContent).toContain('stdout · 5 B');
    expect(document.body.textContent).toContain('stdout · 6 B');
    expect(
      document.body.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe('stdout · 5 B');
  });

  it('preserves the current page and retries the same cursor after paging fails', async () => {
    vi.mocked(reader.listArtifacts)
      .mockResolvedValueOnce({
        data: [{ artifact, access: { can_read_content: true } }],
        hasMore: true,
        nextCursor: 'page-2',
      })
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ data: [], hasMore: false, nextCursor: null });
    await render('session-1', null);
    await click('Load more');
    expect(document.body.textContent).toContain('stdout · 5 B');
    await click('Load more');
    expect(
      vi.mocked(reader.listArtifacts).mock.calls.map((call) => call[1]?.cursor),
    ).toEqual([undefined, 'page-2', 'page-2']);
  });

  it('checks current content access separately from the shared result before reading', async () => {
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact,
      access: { can_read_content: false },
    });
    await render();
    expect(document.body.textContent).toContain(
      'Original output is not available to your account.',
    );
    expect(reader.readRange).not.toHaveBeenCalled();
    expect(
      [...document.body.querySelectorAll('button')].some(
        (node) => node.textContent === 'Download',
      ),
    ).toBe(false);
  });

  it('hides download when the host lacks a streaming sink while keeping bounded reading', async () => {
    reader = { ...reader, canDownload: false };
    await render();
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('hello');
    expect(document.body.textContent).toContain('needs a host integration');
    expect(
      [...document.body.querySelectorAll('button')].some(
        (node) => node.textContent === 'Download',
      ),
    ).toBe(false);
  });

  it('decodes a UTF-8 character crossing two pages without replacement or a full-body read', async () => {
    const bytes = new Uint8Array(MANAGED_OUTPUT_PAGE_BYTES + 5).fill(65);
    bytes.set(new TextEncoder().encode('😀end'), MANAGED_OUTPUT_PAGE_BYTES - 2);
    const large = { ...artifact, byte_length: bytes.byteLength };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [large] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: large,
      access: { can_read_content: true },
    });
    vi.mocked(reader.readRange).mockImplementation(
      async (_artifact, offset, length) => bytes.slice(offset, offset + length),
    );
    await render();
    expect(reader.readRange).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).not.toContain('�');
    await click('Next page');
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('😀end');
    expect(reader.readRange).toHaveBeenCalledTimes(2);
    expect(reader.readRange).toHaveBeenLastCalledWith(
      large,
      MANAGED_OUTPUT_PAGE_BYTES,
      MANAGED_OUTPUT_PAGE_BYTES,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await click('Previous page');
    expect(reader.readRange).toHaveBeenCalledTimes(2);
  });

  it('evicts old pages instead of retaining or rendering a large output', async () => {
    const large = { ...artifact, byte_length: 100 * 1024 * 1024 };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [large] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: large,
      access: { can_read_content: true },
    });
    vi.mocked(reader.readRange).mockImplementation(
      async (_artifact, _offset, length) => new Uint8Array(length).fill(65),
    );
    await render();
    for (let index = 0; index < 5; index++) await click('Next page');
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent
        ?.length,
    ).toBe(MANAGED_OUTPUT_PAGE_BYTES);
    const calls = vi.mocked(reader.readRange).mock.calls.length;
    for (let index = 0; index < 3; index++) await click('Previous page');
    expect(reader.readRange).toHaveBeenCalledTimes(calls);
    await click('Previous page');
    expect(reader.readRange).toHaveBeenLastCalledWith(
      large,
      MANAGED_OUTPUT_PAGE_BYTES - 3,
      3,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(reader.readRange).toHaveBeenCalledTimes(calls + 2);
    expect(
      vi
        .mocked(reader.readRange)
        .mock.calls.every((call) => call[2] <= MANAGED_OUTPUT_PAGE_BYTES),
    ).toBe(true);
  });

  it('shows expiry and requires explicit refresh rather than reading latest implicitly', async () => {
    vi.mocked(reader.readRange).mockRejectedValueOnce(
      new JavaManagedAgentHttpError(410, 'expired', 'expired'),
    );
    await render();
    expect(document.body.textContent).toContain(
      'This output revision has expired.',
    );
    expect(reader.getResult).toHaveBeenCalledTimes(1);
    await click('Refresh output');
    expect(reader.getResult).toHaveBeenCalledTimes(2);
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('hello');
  });

  it('shows the localized denial text when a content read is forbidden', async () => {
    vi.mocked(reader.readRange).mockRejectedValue(
      new JavaManagedAgentHttpError(403, 'forbidden', 'forbidden'),
    );
    await render();
    expect(document.body.textContent).toContain(
      'Original output is not available to your account.',
    );
  });

  it('aborts pending reads on session change and discards their late response', async () => {
    let finish: (bytes: Uint8Array) => void = () => undefined;
    vi.mocked(reader.readRange).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    const signal = vi.mocked(reader.readRange).mock.calls[0][3].signal!;
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, session_id: 'session-2', artifacts: [] },
      access: { can_read_content: false },
    });
    await render('session-2');
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish(new TextEncoder().encode('wrong session'));
      await flush();
    });
    expect(document.body.textContent).not.toContain('wrong session');
  });

  it('discards late reads without repainting or poisoning the page cache', async () => {
    const large = { ...artifact, byte_length: 2 * MANAGED_OUTPUT_PAGE_BYTES };
    const finishes: Array<(bytes: Uint8Array) => void> = [];
    vi.mocked(reader.readRange).mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    vi.mocked(reader.getArtifact).mockImplementation(async () => ({
      artifact: { ...large },
      access: { can_read_content: true },
    }));
    vi.mocked(reader.listArtifacts)
      .mockResolvedValueOnce({
        data: [{ artifact: large, access: { can_read_content: true } }],
        hasMore: true,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        data: [{ artifact: { ...large }, access: { can_read_content: true } }],
        hasMore: false,
        nextCursor: null,
      });
    await render('session-1', null);
    const signal = vi.mocked(reader.readRange).mock.calls[0][3].signal!;
    await click('Load more');
    expect(signal.aborted).toBe(true);
    expect(finishes.length).toBeGreaterThanOrEqual(2);
    const stale = finishes.slice(0, -1);
    await act(async () => {
      finishes.at(-1)!(new Uint8Array(MANAGED_OUTPUT_PAGE_BYTES).fill(70));
      await flush();
    });
    await act(async () => {
      for (const finish of stale)
        finish(new Uint8Array(MANAGED_OUTPUT_PAGE_BYTES).fill(83));
      await flush();
    });
    const output = () =>
      document.body.querySelector('[data-managed-output-bytes]')?.textContent;
    expect(output()).toBe('F'.repeat(MANAGED_OUTPUT_PAGE_BYTES));
    await click('Next page');
    await act(async () => {
      finishes.at(-1)!(new Uint8Array(MANAGED_OUTPUT_PAGE_BYTES).fill(78));
      await flush();
    });
    await click('Previous page');
    expect(output()).toBe('F'.repeat(MANAGED_OUTPUT_PAGE_BYTES));
  });

  it('reuses decoded page text during an unrelated parent render', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      await render();
      const count = decode.mock.calls.length;
      expect(count).toBeGreaterThan(0);
      await render();
      expect(decode).toHaveBeenCalledTimes(count);
    } finally {
      decode.mockRestore();
    }
  });

  it('retains four full pages while returning to the first page', async () => {
    const large = { ...artifact, byte_length: 8 * MANAGED_OUTPUT_PAGE_BYTES };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [large] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: large,
      access: { can_read_content: true },
    });
    vi.mocked(reader.readRange).mockImplementation(
      async (_artifact, _offset, length) => new Uint8Array(length).fill(65),
    );
    await render();
    for (let i = 0; i < 3; i++) await click('Next page');
    const before = vi.mocked(reader.readRange).mock.calls.length;
    for (let i = 0; i < 3; i++) await click('Previous page');
    expect(reader.readRange).toHaveBeenCalledTimes(before);
  });

  it('rejects unavailable and mismatched metadata without reading content', async () => {
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: { ...artifact, availability: 'unavailable' },
      access: { can_read_content: true },
    });
    await render();
    expect(reader.readRange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('unavailable');
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: { ...artifact, revision: 'b'.repeat(64) },
      access: { can_read_content: true },
    });
    await click('Refresh output');
    expect(reader.readRange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('changed');
  });

  it('aborts a download when the panel unmounts', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(reader.downloadArtifact).mockImplementation(
      async (_artifact, options) => {
        signal = options?.signal;
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    );
    await render();
    await click('Download');
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    // Keep afterEach safe after this intentional unmount.
    root = createRoot(container);
  });

  it('clears cached content when the provider changes even for the same Session ID', async () => {
    await render();
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('hello');
    let release!: (
      value: Awaited<ReturnType<ManagedToolResultReader['getResult']>>,
    ) => void;
    const fresh = {
      ...reader,
      getResult: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
      getArtifact: vi
        .fn()
        .mockResolvedValue({ artifact, access: { can_read_content: true } }),
      readRange: vi.fn().mockResolvedValue(new TextEncoder().encode('fresh')),
    };
    reader = fresh;
    await render();
    expect(
      document.body.querySelector('[data-managed-output-bytes]'),
    ).toBeNull();
    await act(async () => {
      release({ result, access: { can_read_content: true } });
      await flush();
    });
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('fresh');
    expect(fresh.readRange).toHaveBeenCalledTimes(1);
  });

  it('preserves a boundary emoji after its predecessor is evicted and checks the lookback', async () => {
    const bytes = new Uint8Array(9 * MANAGED_OUTPUT_PAGE_BYTES).fill(65);
    bytes.set(
      new TextEncoder().encode('😀'),
      3 * MANAGED_OUTPUT_PAGE_BYTES - 2,
    );
    const large = { ...artifact, byte_length: bytes.length };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [large] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: large,
      access: { can_read_content: true },
    });
    vi.mocked(reader.readRange).mockImplementation(
      async (_artifact, offset, length) => bytes.slice(offset, offset + length),
    );
    await render();
    for (let i = 0; i < 7; i++) await click('Next page');
    for (let i = 0; i < 4; i++) await click('Previous page');
    const text = document.body.querySelector(
      '[data-managed-output-bytes]',
    )?.textContent;
    expect(text?.startsWith('😀')).toBe(true);
    expect(text).not.toContain('�');
    expect(
      vi.mocked(reader.readRange).mock.calls.map((call) => [call[1], call[2]]),
    ).toContainEqual([3 * MANAGED_OUTPUT_PAGE_BYTES - 3, 3]);
  });

  it('downloads the selected revision with a signal and shows sink failures', async () => {
    vi.mocked(reader.downloadArtifact).mockRejectedValue(
      new Error('save failed'),
    );
    await render();
    await click('Download');
    expect(reader.downloadArtifact).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({
        clientId: 'client',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(document.body.textContent).toContain('save failed');
    await click('Close output');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reads an empty artifact without issuing a byte request', async () => {
    const empty = { ...artifact, byte_length: 0 };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [empty] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockResolvedValue({
      artifact: empty,
      access: { can_read_content: true },
    });
    await render();
    expect(reader.readRange).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('Empty output (0 bytes)');
  });

  it('resets the page when selecting another stream', async () => {
    const large = { ...artifact, byte_length: MANAGED_OUTPUT_PAGE_BYTES * 2 };
    const other = {
      ...artifact,
      id: 'artifact-2',
      stream_role: 'stderr' as const,
    };
    vi.mocked(reader.getResult).mockResolvedValue({
      result: { ...result, artifacts: [large, other] },
      access: { can_read_content: true },
    });
    vi.mocked(reader.getArtifact).mockImplementation(async (_session, id) => ({
      artifact: id === large.id ? large : other,
      access: { can_read_content: true },
    }));
    vi.mocked(reader.readRange).mockImplementation(
      async (a, _offset, length) =>
        a.id === other.id
          ? new TextEncoder().encode('other')
          : new Uint8Array(length).fill(65),
    );
    await render();
    await click('Next page');
    await click('stderr · 5 B');
    expect(reader.readRange).toHaveBeenLastCalledWith(
      other,
      0,
      MANAGED_OUTPUT_PAGE_BYTES,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('other');
  });
  it.each([
    [notStartedResult, 'Command not executed'],
    [blockedResult, 'Output delivery blocked'],
    [previewOnlyResult, 'approved excerpt'],
  ])(
    'renders shared execution/capture facts when raw access is denied: %s',
    async (fixture, expected) => {
      vi.mocked(reader.getResult).mockResolvedValue({
        result: fixture,
        access: { can_read_content: false },
      });
      vi.mocked(reader.getArtifact).mockResolvedValue({
        artifact,
        access: { can_read_content: false },
      });
      await render();
      expect(document.body.textContent).toContain(expected);
      expect(reader.readRange).not.toHaveBeenCalled();
      expect(reader.downloadArtifact).not.toHaveBeenCalled();
    },
  );
});
