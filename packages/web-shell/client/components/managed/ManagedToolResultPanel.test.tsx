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
import { artifact, result } from './managed-tool-result.test-fixtures';
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
    for (let index = 0; index < 2; index++) await click('Previous page');
    expect(reader.readRange).toHaveBeenCalledTimes(calls);
    await click('Previous page');
    expect(vi.mocked(reader.readRange).mock.calls.length).toBeGreaterThan(
      calls,
    );
    expect(
      vi
        .mocked(reader.readRange)
        .mock.calls.every((call) => call[2] <= MANAGED_OUTPUT_PAGE_BYTES),
    ).toBe(true);
  });

  it('shows expiry and requires explicit refresh rather than reading latest implicitly', async () => {
    vi.mocked(reader.readRange).mockRejectedValue(
      new JavaManagedAgentHttpError(410, 'expired', 'expired'),
    );
    await render();
    expect(document.body.textContent).toContain(
      'This output revision has expired.',
    );
    expect(reader.getResult).toHaveBeenCalledTimes(1);
    await click('Refresh output');
    expect(reader.getResult).toHaveBeenCalledTimes(2);
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

  it('clears cached content when the provider changes even for the same Session ID', async () => {
    await render();
    expect(
      document.body.querySelector('[data-managed-output-bytes]')?.textContent,
    ).toBe('hello');
    const oldSignal = vi.mocked(reader.getArtifact).mock.calls[0][2].signal!;
    const readRange = vi.fn();
    reader = {
      ...reader,
      readRange,
      getArtifact: vi
        .fn()
        .mockResolvedValue({ artifact, access: { can_read_content: false } }),
    };
    await render();
    expect(oldSignal.aborted).toBe(true);
    expect(
      document.body.querySelector('[data-managed-output-bytes]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      'Original output is not available to your account.',
    );
    expect(readRange).not.toHaveBeenCalled();
  });
});
