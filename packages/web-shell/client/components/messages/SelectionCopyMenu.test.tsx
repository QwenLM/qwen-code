// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionCopyMenu } from './SelectionCopyMenu';
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
