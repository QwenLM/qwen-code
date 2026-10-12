// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionCopyMenu } from './SelectionCopyMenu';
import { SelectionCopyMenu as TranscriptSelectionCopyMenu } from './SelectionCopyMenu.transcript-stub';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';

let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  portal?.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  enabled = true,
  content = 'reply',
  language: 'en' | 'zh-CN' = 'en',
) {
  if (!container) container = document.createElement('div');
  if (!portal) portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
  const render = (value: string) =>
    act(() =>
      root.render(
        <I18nProvider language={language}>
          <WebShellPortalRootContext.Provider value={portal}>
            <SelectionCopyMenu
              className="reply-body"
              content={value}
              enabled={enabled}
            >
              <p>
                Before <strong>bold text</strong> after
              </p>
            </SelectionCopyMenu>
          </WebShellPortalRootContext.Provider>
        </I18nProvider>,
      ),
    );
  render(content);
  return render;
}
async function choose(
  pointerType = 'mouse',
  releaseOutside = false,
  startOutside = false,
) {
  const pointer = (type: string) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    return event;
  };
  await act(async () =>
    (startOutside
      ? document.body
      : container.querySelector('strong')!
    ).dispatchEvent(pointer('pointerdown')),
  );
  const text = container.querySelector('strong')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () =>
    (releaseOutside
      ? document.body
      : container.querySelector('strong')!
    ).dispatchEvent(pointer('pointerup')),
  );
}

describe('SelectionCopyMenu', () => {
  it('opens when dragging from the reply and releasing outside its body', async () => {
    mount();
    await choose('mouse', true);
    expect(window.getSelection()?.toString()).toBe('bold');
    expect(
      portal.querySelector('[data-slot="popover-content"]'),
    ).not.toBeNull();
  });
  it('keeps handling a valid selection released inside the reply', async () => {
    mount();
    await choose('mouse', false, true);
    expect(
      portal.querySelector('[data-slot="popover-content"]'),
    ).not.toBeNull();
  });
  it('does not reopen a dismissed menu after an unrelated outside release', async () => {
    mount();
    await choose();
    act(() => document.dispatchEvent(new Event('scroll')));
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      await act(async () => document.body.dispatchEvent(event));
    }
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('does not open after a cancelled pointer selection', async () => {
    mount();
    await choose();
    act(() => document.dispatchEvent(new Event('scroll')));
    for (const type of ['pointerdown', 'pointercancel', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      await act(async () =>
        (type === 'pointerdown'
          ? container.querySelector('strong')!
          : document.body
        ).dispatchEvent(event),
      );
    }
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('leaves drags starting in advanced tables to their own selection behavior', async () => {
    mount();
    await choose();
    act(() => document.dispatchEvent(new Event('scroll')));
    const table = document.createElement('div');
    table.setAttribute('data-selection-copy-table', '');
    container.querySelector('.reply-body')!.append(table);
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      await act(async () =>
        (type === 'pointerdown'
          ? table
          : container.querySelector('strong')!
        ).dispatchEvent(event),
      );
    }
    expect(window.getSelection()?.toString()).toBe('bold');
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    await act(async () =>
      table.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }),
      ),
    );
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('uses the scoped popover portal, keeps selection and copies partial Markdown', async () => {
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    mount();
    await choose();
    expect(
      portal.querySelector('[data-slot="popover-content"]'),
    ).not.toBeNull();
    expect(window.getSelection()?.toString()).toBe('bold');
    const button = [...portal.querySelectorAll('button')].find(
      (item) => item.textContent === 'Copy Markdown',
    )!;
    await act(async () => button.click());
    expect(write).toHaveBeenCalledWith('**bold**');
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('uses clear Chinese labels and copies plain text', async () => {
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    mount(true, 'reply', 'zh-CN');
    await choose();
    const buttons = [...portal.querySelectorAll('button')];
    expect(buttons.map((item) => item.textContent)).toEqual([
      '复制纯文本',
      '复制 Markdown',
    ]);
    await act(async () => buttons[0].click());
    expect(write).toHaveBeenCalledWith('bold');
  });
  it.each(['touch', 'pen'])(
    'leaves %s selection to the native menu',
    async (type) => {
      mount();
      await choose(type);
      expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    },
  );
  it('does not open when disabled for streaming or exported replies', async () => {
    mount(false);
    await choose();
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('closes on scroll and when content changes', async () => {
    const render = mount();
    await choose();
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    await choose();
    render('updated');
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('closes when selection is cleared', async () => {
    mount();
    await choose();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('keeps the menu available if clipboard writing fails', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('denied'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    await choose();
    await act(async () =>
      (portal.querySelector('button') as HTMLButtonElement).click(),
    );
    expect(warn).toHaveBeenCalled();
    expect(
      portal.querySelector('[data-slot="popover-content"]'),
    ).not.toBeNull();
  });
  it('keeps the menu and restores selection after a real fallback failure', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('denied'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = document.execCommand;
    let copiedInsideMenu = false;
    document.execCommand = vi.fn(() => {
      const textarea = document.querySelector('textarea')!;
      copiedInsideMenu = portal.contains(textarea);
      textarea.focus();
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      return false;
    });
    try {
      mount();
      await choose();
      await act(async () =>
        (portal.querySelector('button') as HTMLButtonElement).click(),
      );
      expect(copiedInsideMenu).toBe(true);
      expect(
        portal.querySelector('[data-slot="popover-content"]'),
      ).not.toBeNull();
      expect(window.getSelection()?.toString()).toBe('bold');
    } finally {
      document.execCommand = original;
    }
  });

  it('leaves keyboard selections to native copying', async () => {
    mount();
    const text = container.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()!.addRange(range);
    for (const target of [
      document.body,
      container.querySelector('.reply-body')!,
    ]) {
      await act(async () =>
        target.dispatchEvent(
          new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }),
        ),
      );
      expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    }
  });

  it('keeps the transcript body wrapper and class without interactive controls', () => {
    mount();
    act(() =>
      root.render(
        <TranscriptSelectionCopyMenu
          className="export-body"
          content="reply"
          enabled={false}
        >
          <pre>export code</pre>
        </TranscriptSelectionCopyMenu>,
      ),
    );
    expect(container.querySelector('div.export-body > pre')?.textContent).toBe(
      'export code',
    );
    expect(container.querySelector('button')).toBeNull();
  });
  it('closes on viewport resize and changed nonempty selection', async () => {
    mount();
    await choose();
    act(() => window.dispatchEvent(new Event('resize')));
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    await choose();
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(container.querySelector('p')!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it.each([1, 2])(
    'ignores mouse button %s without computing its path',
    async (button) => {
      mount();
      await choose();
      act(() => window.dispatchEvent(new Event('resize')));
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new MouseEvent(type, { bubbles: true, button });
        Object.defineProperty(event, 'pointerType', { value: 'mouse' });
        const path = vi.spyOn(event, 'composedPath');
        await act(async () =>
          container.querySelector('strong')!.dispatchEvent(event),
        );
        expect(path).not.toHaveBeenCalled();
      }
      expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
    },
  );
  it.each([false, true])(
    'restores composer focus after a successful copy (shadow=%s)',
    async (shadow) => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      mount();
      const composer = document.createElement('textarea');
      const host = document.createElement('div');
      container.append(host);
      const parent = shadow ? host.attachShadow({ mode: 'open' }) : host;
      parent.append(composer);
      composer.focus();
      await choose();
      await act(async () =>
        (portal.querySelector('button') as HTMLButtonElement).click(),
      );
      expect(document.activeElement).toBe(shadow ? host : composer);
      if (shadow) expect((parent as ShadowRoot).activeElement).toBe(composer);
    },
  );
  it('leaves ignored diagram interactions alone with an existing selection', async () => {
    mount();
    await choose();
    act(() => window.dispatchEvent(new Event('resize')));
    const diagram = document.createElement('div');
    diagram.setAttribute('data-selection-copy-ignore', '');
    diagram.setAttribute('data-selection-copy-gesture', '');
    container.querySelector('.reply-body')!.append(diagram);
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      await act(async () => diagram.dispatchEvent(event));
    }
    expect(window.getSelection()?.toString()).toBe('bold');
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it.each([
    [800, 100],
    [400, 500],
  ])(
    'dismisses after reply reflow to %s x %s but ignores the initial observer callback',
    async (width, height) => {
      let resized: () => void = () => {};
      let bodyObserver: { disconnect: ReturnType<typeof vi.fn> } | undefined;
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private callback: () => void) {}
          observe(target: Element) {
            if (target.matches('.reply-body')) {
              resized = this.callback;
              bodyObserver = { disconnect: this.disconnect };
            }
          }
          disconnect = vi.fn();
        },
      );
      mount();
      const body = container.querySelector('.reply-body')!;
      const rect = vi
        .spyOn(body, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 400, 100));
      await choose();
      act(() => resized());
      expect(
        portal.querySelector('[data-slot="popover-content"]'),
      ).not.toBeNull();
      expect(bodyObserver).toBeDefined();
      rect.mockReturnValue(new DOMRect(0, 0, width, height));
      act(() => resized());
      expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
      expect(bodyObserver!.disconnect).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['', ' '])(
    'offers Markdown without blank plain-text copy for an image (prefix=%j)',
    async (prefix) => {
      mount();
      const paragraph = container.querySelector('p')!;
      paragraph.innerHTML = `${prefix}<img src="https://example.com/image.png" alt="">`;
      for (const type of ['pointerdown', 'pointerup']) {
        if (type === 'pointerup') {
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          window.getSelection()!.addRange(range);
        }
        const event = new MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperty(event, 'pointerType', { value: 'mouse' });
        await act(async () => paragraph.dispatchEvent(event));
      }
      const buttons = portal.querySelectorAll('button');
      expect(buttons[0].disabled).toBe(true);
      expect(buttons[1].disabled).toBe(false);
    },
  );
  it('closes when only the selection end changes', async () => {
    mount();
    await choose();
    act(() => {
      const text = container.querySelector('strong')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 9);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(portal.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
  it('opens for code selected from an excluded header', async () => {
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    mount();
    const body = container.querySelector('.reply-body')!;
    body.querySelector('p')!.innerHTML =
      '<div data-selection-code-language="python"><div data-selection-copy-ignore><span>python</span></div><pre><code>answer = 42</code></pre></div>';
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      if (type === 'pointerup') {
        const range = document.createRange();
        range.selectNodeContents(body.querySelector('code')!);
        window.getSelection()!.addRange(range);
      }
      await act(async () =>
        body
          .querySelector(type === 'pointerdown' ? 'span' : 'code')!
          .dispatchEvent(event),
      );
    }
    const button = [...portal.querySelectorAll('button')].find(
      (item) => item.textContent === 'Copy Markdown',
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(write).toHaveBeenCalledWith('```python\nanswer = 42\n```');
  });
});
