// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import SpreadsheetPreview from './SpreadsheetPreview';
import type {
  ExcelPreviewResult,
  ExcelPreviewSheet,
} from './excel-preview-types';

const { workers, constructWorker } = vi.hoisted(() => ({
  constructWorker: vi.fn(),
  workers: [] as Array<{
    onmessage?: (event: { data: ExcelPreviewResult }) => void;
    onerror?: () => void;
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('./excel-preview.worker?worker&inline', () => ({
  default: class {
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      constructWorker();
      workers.push(this);
    }
  },
}));

let root: Root;
let container: HTMLDivElement;
const blob = () => new NodeBlob(['xlsx bytes']) as unknown as Blob;
const revoke = vi.fn();
async function render(data: Blob, path = 'report.xlsx') {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <SpreadsheetPreview data={data} workspacePath={path} />
      </I18nProvider>,
    );
  });
}

describe('SpreadsheetPreview', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.tagName === 'TR' ? 29 : 600;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    workers.length = 0;
    constructWorker.mockReset();
    revoke.mockClear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:excel-${workers.length}`),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('bounds mounted tabs while every worksheet remains keyboard reachable', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    await render(blob());
    const worker = workers[0]!;
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'loaded',
          workbook: {
            sheetNames: Array.from({ length: 5000 }, (_, i) => `Sheet ${i}`),
          },
        },
      }),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(50);
    const next = container.querySelector<HTMLButtonElement>(
      '[aria-label="Next worksheets"]',
    )!;
    const tabList = container.querySelector<HTMLElement>('[role="tablist"]')!;
    tabList.scrollLeft = 3200;
    act(() => next.click());
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 50,
    });
    const active = container.querySelector('[role="tab"][data-state="active"]');
    expect(scrollIntoView.mock.contexts).toContain(active);
    const previous = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous worksheets"]',
    )!;
    act(() => previous.click());
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 49,
    });
    act(() => next.click());
    const key = (value: string) =>
      act(() => {
        container
          .querySelector('[role="tab"][data-state="active"]')!
          .dispatchEvent(
            new KeyboardEvent('keydown', {
              key: value,
              bubbles: true,
              cancelable: true,
            }),
          );
      });
    key('ArrowLeft');
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 49,
    });
    expect(document.activeElement?.textContent).toBe('Sheet 49');
    key('End');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(50);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 4999,
    });
    expect(document.activeElement?.textContent).toBe('Sheet 4999');
    key('Home');
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 0,
    });
    expect(document.activeElement?.textContent).toBe('Sheet 0');
    expect(previous.disabled).toBe(true);
    const requests = worker.postMessage.mock.calls.length;
    act(() => previous.click());
    expect(worker.postMessage).toHaveBeenCalledTimes(requests);
  });

  it('keeps a loaded preview usable when an overlapping download fails', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    type Bytes = {
      path: string;
      offset: number;
      sizeBytes: number;
      returnedBytes: number;
      contentBase64: string;
    };
    const pending: Array<{
      resolve: (bytes: Bytes) => void;
      reject: (reason: Error) => void;
    }> = [];
    const actions = {
      stat: vi
        .fn()
        .mockResolvedValue({ type: 'file', sizeBytes: 4, modifiedMs: 1 }),
      readFileBytes: vi.fn(
        () =>
          new Promise<Bytes>((resolve, reject) =>
            pending.push({ resolve, reject }),
          ),
      ),
      readWorkspaceFile: vi.fn(),
      listScheduledTasks: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
    };
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <SpreadsheetPreview
            workspacePath="report.xlsx"
            workspaceActions={actions}
          />
        </I18nProvider>,
      ),
    );
    expect(pending).toHaveLength(1);
    await act(async () => container.querySelector('button')!.click());
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[0]!.resolve({
        path: 'report.xlsx',
        offset: 0,
        sizeBytes: 4,
        returnedBytes: 4,
        contentBase64: 'eGxzeA==',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const worker = workers[0]!;
    act(() =>
      worker.onmessage?.({
        data: { type: 'loaded', workbook: { sheetNames: ['One', 'Two'] } },
      }),
    );
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'sheet',
          index: 0,
          sheet: {
            name: 'One',
            columns: 1,
            truncated: false,
            merges: [],
            rows: [[{ text: 'Revenue', style: {} }]],
          },
        },
      }),
    );
    await act(async () => pending[1]!.reject(new Error('Download failed')));
    expect(container.querySelector('table')?.textContent).toContain('Revenue');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Download failed',
    );
    const download = container.querySelector<HTMLAnchorElement>('a[download]')!;
    download.addEventListener('click', (event) => event.preventDefault());
    await act(async () => download.click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('table')?.textContent).toContain('Revenue');
    act(() =>
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.focus(),
    );
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 1,
    });
  });

  it.each(['construction', 'async error'])(
    'keeps the original downloadable when worker %s fails',
    async (failure) => {
      if (failure === 'construction') {
        constructWorker.mockImplementationOnce(() => {
          throw new DOMException('Worker blocked by policy', 'SecurityError');
        });
      }
      const original = blob();
      await render(original);
      if (failure === 'async error') {
        act(() => workers[0]!.onerror?.());
        expect(workers[0]!.terminate).toHaveBeenCalled();
      } else {
        expect(workers).toHaveLength(0);
      }
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        failure === 'construction' ? /blocked by policy/ : /Unable to preview/,
      );
      const download = container.querySelector('a');
      expect(download?.href).toBe('blob:excel-0');
      expect(download?.download).toBe('report.xlsx');
      expect(URL.createObjectURL).toHaveBeenCalledWith(original);
      expect(revoke).not.toHaveBeenCalled();
      act(() => root.render(null));
      expect(revoke).toHaveBeenCalledWith('blob:excel-0');
    },
  );

  it.each(['attachment', 'workspace'])(
    'accepts an exactly 10 MiB %s for parsing',
    async (source) => {
      const size = 10 * 1024 * 1024;
      if (source === 'attachment') {
        await render(new NodeBlob([new Uint8Array(size)]) as unknown as Blob);
      } else {
        vi.stubGlobal('Blob', NodeBlob);
        const actions = {
          stat: vi.fn().mockResolvedValue({
            type: 'file',
            sizeBytes: size,
            modifiedMs: 1,
          }),
          readFileBytes: vi.fn(
            async (
              path: string,
              options: { offset?: number; maxBytes?: number } = {},
            ) => {
              const offset = options.offset ?? 0;
              const length = Math.min(options.maxBytes ?? size, size - offset);
              return {
                path,
                offset,
                sizeBytes: size,
                returnedBytes: length,
                contentBase64: Buffer.alloc(length).toString('base64'),
              };
            },
          ),
          readWorkspaceFile: vi.fn(),
          listScheduledTasks: vi.fn(),
          updateScheduledTask: vi.fn(),
          deleteScheduledTask: vi.fn(),
        };
        await act(async () =>
          root.render(
            <I18nProvider language="en">
              <SpreadsheetPreview
                workspacePath="report.xlsx"
                workspaceActions={actions}
              />
            </I18nProvider>,
          ),
        );
        await act(async () => {
          await vi.waitFor(() => expect(workers).toHaveLength(1));
        });
        expect(actions.readFileBytes).toHaveBeenCalled();
        expect(actions.readWorkspaceFile).not.toHaveBeenCalled();
      }
      expect(workers).toHaveLength(1);
      const request = workers[0]!.postMessage.mock.calls[0]![0];
      expect(request.type).toBe('load');
      expect(request.data.byteLength).toBe(size);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('a')?.download).toBe('report.xlsx');
    },
  );

  it('terminates replaced work and ignores stale results, retaining the original download', async () => {
    await render(blob());
    const first = workers[0]!;
    expect(first.postMessage).toHaveBeenCalledOnce();
    await render(blob(), 'second.xlsx');
    expect(first.terminate).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:excel-0');
    act(() => first.onmessage?.({ data: { type: 'error' } }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() =>
      workers[1]!.onmessage?.({
        data: {
          type: 'loaded',
          workbook: { sheetNames: ['Current'] },
        },
      }),
    );
    act(() =>
      workers[1]!.onmessage?.({
        data: {
          type: 'sheet',
          index: 0,
          sheet: {
            name: 'Current',
            columns: 1,
            truncated: false,
            merges: [],
            rows: [[{ text: '<script>safe</script>', style: {} }]],
          },
        },
      }),
    );
    expect(container.querySelector('table')?.textContent).toContain(
      '<script>safe</script>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')?.download).toBe('second.xlsx');
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(workers[1]!.terminate).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:excel-1');
    root = createRoot(container);
  });

  it('requests only the selected sheet, ignores stale results and mounts only visible rows', async () => {
    await render(blob());
    const worker = workers[0]!;
    expect(worker.postMessage.mock.calls[0]![0].type).toBe('load');
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'loaded',
          workbook: { sheetNames: ['Large', 'Small'] },
        },
      }),
    );
    expect(worker.postMessage.mock.calls.slice(1)).toEqual([
      [{ type: 'sheet', index: 0 }],
    ]);
    const sheet: ExcelPreviewSheet = {
      name: 'Large',
      columns: 1,
      merges: [],
      truncated: false,
      rows: Array.from({ length: 2000 }, (_, i) => [
        { text: `Row ${i + 1}`, style: {} },
      ]),
    };
    act(() => worker.onmessage?.({ data: { type: 'sheet', index: 0, sheet } }));
    expect(
      container.querySelectorAll('tbody tr[data-index]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('tbody tr[data-index]').length,
    ).toBeLessThan(50);
    expect(
      container.querySelector('table')?.getAttribute('aria-rowcount'),
    ).toBe('2001');
    expect(container.querySelector('table')?.textContent).toContain('Row 1');
    expect(container.querySelector('table')?.textContent).not.toContain(
      'Row 2000',
    );
    const second =
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
    act(() => second.focus());
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'sheet',
      index: 1,
    });
    expect(container.querySelector('table')).toBeNull();
    act(() => worker.onmessage?.({ data: { type: 'sheet', index: 0, sheet } }));
    expect(container.querySelector('table')).toBeNull();
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'sheet',
          index: 1,
          sheet: {
            ...sheet,
            name: 'Small',
            rows: [
              [{ text: 'Selected sheet', style: {} }],
              [{ text: '', formula: '1+1', uncalculated: true, style: {} }],
            ],
          },
        },
      }),
    );
    expect(container.querySelector('table')?.textContent).toContain(
      'Selected sheet',
    );
    const annotation = container.querySelector('td span')!;
    expect(annotation.textContent).toContain('Not calculated');
    expect(annotation.classList.contains('text-muted-foreground')).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('shows a timeout with a downloadable original and ignores late worker messages', async () => {
    vi.useFakeTimers();
    await render(blob(), 'slow.xlsx');
    act(() => vi.advanceTimersByTime(30000));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'took too long',
    );
    expect(container.querySelector('a')?.download).toBe('slow.xlsx');
    const last = workers.at(-1)!;
    expect(last.terminate).toHaveBeenCalled();
    act(() =>
      last.onmessage?.({
        data: {
          type: 'loaded',
          workbook: { sheetNames: [] },
        },
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'took too long',
    );
  });

  it('gives the selected sheet its own timeout and ignores a result after it expires', async () => {
    vi.useFakeTimers();
    await render(blob(), 'slow-sheet.xlsx');
    const worker = workers.at(-1)!;
    act(() => vi.advanceTimersByTime(29000));
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'loaded',
          workbook: {
            sheetNames: Array.from({ length: 60 }, (_, i) => `Slow ${i}`),
          },
        },
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(worker.terminate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(28000));
    expect(worker.terminate).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'took too long',
    );
    const requests = worker.postMessage.mock.calls.length;
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      '[role="tab"], [aria-label="Next worksheets"], [aria-label="Previous worksheets"]',
    )) {
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(worker.postMessage).toHaveBeenCalledTimes(requests);
    expect(container.querySelector('a')?.download).toBe('slow-sheet.xlsx');
    act(() =>
      worker.onmessage?.({
        data: {
          type: 'sheet',
          index: 0,
          sheet: {
            name: 'Slow',
            columns: 1,
            rows: [[{ text: 'Late', style: {} }]],
            merges: [],
            truncated: false,
          },
        },
      }),
    );
    expect(container.querySelector('table')).toBeNull();
  });

  it('does not read oversized workspace files and offers a separate download', async () => {
    const actions = {
      stat: vi.fn().mockResolvedValue({
        type: 'file',
        sizeBytes: 11 * 1024 * 1024,
        modifiedMs: 1,
      }),
      readFileBytes: vi.fn(),
      readWorkspaceFile: vi.fn(),
      listScheduledTasks: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
    };
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <SpreadsheetPreview
            workspacePath="large.xlsx"
            workspaceActions={actions}
          />
        </I18nProvider>,
      ),
    );
    expect(actions.stat).toHaveBeenCalledWith('large.xlsx');
    expect(actions.readFileBytes).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '10 MiB',
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (button) =>
          button.textContent?.includes('Download') && !button.disabled,
      ),
    ).toBe(true);
  });

  it('rejects oversized attachments before starting a parser and keeps download available', async () => {
    await render(
      new NodeBlob([new Uint8Array(10 * 1024 * 1024 + 1)]) as unknown as Blob,
    );
    expect(workers).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '10 MiB',
    );
    expect(container.querySelector('a')?.download).toBe('report.xlsx');
  });
});
