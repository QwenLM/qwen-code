// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { I18nProvider } from '../../i18n';
import DocxPreview from './DocxPreview';

const { renderAsync } = vi.hoisted(() => ({ renderAsync: vi.fn() }));
vi.mock('docx-preview', () => ({ renderAsync }));

let root: Root;
let container: HTMLDivElement;
const bytes = Buffer.from('DOCX bytes');
const actions = {
  stat: vi.fn(),
  readFileBytes: vi.fn(),
};
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function render(props: Partial<Parameters<typeof DocxPreview>[0]> = {}) {
  act(() =>
    root.render(
      <I18nProvider language="en">
        <DocxPreview
          workspacePath="report.docx"
          workspaceActions={actions}
          {...props}
        />
      </I18nProvider>,
    ),
  );
  const frame = container.querySelector('iframe')!;
  act(() => frame.dispatchEvent(new Event('load')));
  return frame;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Blob', NodeBlob);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:docx-download'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  actions.stat.mockResolvedValue({
    type: 'file',
    sizeBytes: bytes.length,
    modifiedMs: 1,
  });
  actions.readFileBytes.mockResolvedValue({
    contentBase64: bytes.toString('base64'),
    offset: 0,
    returnedBytes: bytes.length,
    sizeBytes: bytes.length,
  });
  renderAsync.mockImplementation(
    async (_bytes: ArrayBuffer, body: HTMLElement) => {
      body.innerHTML =
        '<p>Preview content</p><a href="javascript:alert(1)" target="_top">Document link</a>';
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ['createObjectURL', originalCreate],
    ['revokeObjectURL', originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

describe('DocxPreview', () => {
  it('renders supplied bytes without workspace reads and disables document navigation', async () => {
    const frame = render({
      data: new Blob([bytes]),
      workspaceActions: undefined,
    });
    await settle();
    expect(actions.stat).not.toHaveBeenCalled();
    expect(actions.readFileBytes).not.toHaveBeenCalled();
    expect(Buffer.from(renderAsync.mock.calls[0]![0])).toEqual(bytes);
    expect(renderAsync.mock.calls[0]![3]).toEqual({
      useBase64URL: true,
      renderAltChunks: false,
    });
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain('img-src data:; font-src data:;');
    expect(frame.style.visibility).toBe('visible');
    expect(frame.contentDocument!.body.textContent).toContain(
      'Preview content',
    );
    expect(
      frame.contentDocument!.querySelector('a')?.hasAttribute('href'),
    ).toBe(false);
    expect(
      frame.contentDocument!.querySelector('a')?.hasAttribute('target'),
    ).toBe(false);
    expect(container.querySelector('p')).toBeNull();
    expect(container.querySelector('a[download]')?.getAttribute('href')).toBe(
      'blob:docx-download',
    );
  });

  it('reads literal workspace paths as bytes and reloads for versions and workspace actions', async () => {
    const props = {
      workspacePath: 'reports.xlsx#approved/Q3?final.DOCX',
      artifactVersion: '1',
    };
    render(props);
    await settle();
    expect(actions.readFileBytes).toHaveBeenCalledWith(props.workspacePath, {
      offset: 0,
      maxBytes: 256 * 1024,
    });
    expect(actions.stat).toHaveBeenCalledTimes(2);
    render({ ...props, artifactVersion: '2' });
    await settle();
    expect(actions.readFileBytes).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    const secondary = {
      stat: vi.fn().mockResolvedValue({
        type: 'file',
        sizeBytes: bytes.length,
        modifiedMs: 1,
      }),
      readFileBytes: vi.fn().mockResolvedValue({
        contentBase64: bytes.toString('base64'),
        offset: 0,
        returnedBytes: bytes.length,
        sizeBytes: bytes.length,
      }),
    };
    render({ ...props, workspaceActions: secondary });
    await settle();
    expect(secondary.readFileBytes).toHaveBeenCalledTimes(1);
    expect(secondary.stat).toHaveBeenCalledTimes(2);
    expect(actions.readFileBytes).toHaveBeenCalledTimes(2);
    expect(actions.stat).toHaveBeenCalledTimes(4);
    act(() => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('retries read errors and retains downloads after parse errors', async () => {
    actions.readFileBytes.mockRejectedValueOnce(new Error('Read denied'));
    render();
    await settle();
    expect(container.textContent).toContain('Read denied');
    const retry = () =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Try again',
      )!;
    renderAsync.mockRejectedValueOnce(new Error('Invalid ZIP'));
    act(() => retry().click());
    await settle();
    expect(container.textContent).toContain('Unable to preview this DOCX');
    expect(container.querySelector('a[download]')).not.toBeNull();
    act(() => retry().click());
    await settle();
    expect(container.querySelector('iframe')!.style.visibility).toBe('visible');
  });

  it('rejects oversized workspace files before reads but permits downloading the original', async () => {
    actions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: 10 * 1024 * 1024 + 1,
      modifiedMs: 1,
    });
    render();
    await settle();
    expect(container.textContent).toContain('up to 10 MiB');
    expect(actions.readFileBytes).not.toHaveBeenCalled();
    expect(renderAsync).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Download',
      ),
    ).toBe(true);
  });

  it('keeps an oversized supplied Blob downloadable without parsing or workspace reads', async () => {
    render({ data: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) });
    await settle();
    expect(container.textContent).toContain('up to 10 MiB');
    expect(renderAsync).not.toHaveBeenCalled();
    expect(actions.stat).not.toHaveBeenCalled();
    expect(container.querySelector('a[download]')).not.toBeNull();
  });

  it('discards a pending render when a newer document replaces it', async () => {
    let finish!: () => void;
    let finishCurrent!: () => void;
    let stale!: HTMLElement;
    renderAsync.mockImplementationOnce(
      (_bytes: ArrayBuffer, body: HTMLElement) => {
        stale = body;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderAsync.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishCurrent = resolve;
      });
    });
    const frame = render({ artifactVersion: '1' });
    await settle();
    expect(frame.style.visibility).toBe('hidden');
    render({ artifactVersion: '2' });
    await settle();
    stale.textContent = 'STALE CONTENT';
    await act(async () => finish());
    expect(frame.style.visibility).toBe('hidden');
    expect(stale.isConnected).toBe(false);
    await act(async () => finishCurrent());
    expect(frame.style.visibility).toBe('visible');
  });

  it('uses the supplied Sources download name instead of the attachment identifier', async () => {
    render({
      data: new Blob([bytes]),
      workspaceActions: undefined,
      downloadName: 'Source title.docx',
    });
    await settle();
    expect(
      container.querySelector('a[download]')?.getAttribute('download'),
    ).toBe('Source title.docx');
  });

  it('scrolls internal bookmarks without document navigation and disables external links', async () => {
    renderAsync.mockImplementationOnce(
      async (_bytes: ArrayBuffer, body: HTMLElement) => {
        body.innerHTML =
          '<a href="#bookmark" target="_top">Bookmark</a><span id="bookmark">Target</span><a href="https://example.test/">External</a>';
      },
    );
    const frame = render();
    await settle();
    const doc = frame.contentDocument!;
    const scroll = vi.fn();
    Object.defineProperty(doc.getElementById('bookmark'), 'scrollIntoView', {
      value: scroll,
    });
    const link = doc.querySelector('a')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(link.getAttribute('href')).toBe('#bookmark');
    expect(link.hasAttribute('target')).toBe(false);
    expect(doc.querySelectorAll('a[href]')).toHaveLength(1);
    expect(doc.URL).toBe('about:blank');
  });

  it.each([false, true])(
    'times out a pending render and ignores its late completion (reject=%s)',
    async (reject) => {
      vi.useFakeTimers();
      let finish!: () => void;
      let stale!: HTMLElement;
      renderAsync.mockImplementationOnce(
        (_bytes: ArrayBuffer, body: HTMLElement) => {
          stale = body;
          return new Promise<void>((resolve, rejectRender) => {
            finish = () =>
              reject ? rejectRender(new Error('Late failure')) : resolve();
          });
        },
      );
      const frame = render();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(renderAsync).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(container.textContent).toContain('took too long');
      expect(frame.style.visibility).toBe('hidden');
      expect(stale.isConnected).toBe(false);
      expect(container.querySelector('a[download]')).not.toBeNull();
      await act(async () => finish());
      expect(frame.style.visibility).toBe('hidden');
      expect(container.textContent).toContain('took too long');
      const retry = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Try again',
      )!;
      act(() => retry.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(frame.style.visibility).toBe('visible');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ignores read completion after unmount', async () => {
    let finish!: (value: {
      contentBase64: string;
      offset: number;
      returnedBytes: number;
      sizeBytes: number;
    }) => void;
    actions.readFileBytes.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render();
    await settle();
    act(() => root.render(null));
    await act(async () =>
      finish({
        contentBase64: bytes.toString('base64'),
        offset: 0,
        returnedBytes: bytes.length,
        sizeBytes: bytes.length,
      }),
    );
    expect(renderAsync).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
