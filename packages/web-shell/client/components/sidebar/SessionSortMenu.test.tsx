// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  SessionSortMenu,
  readSessionSort,
  writeSessionSort,
} from './SessionSortMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent)
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture)
  Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture)
  Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

it('exposes both choices through the real scoped menu and persists preferences per host', async () => {
  localStorage.clear();
  expect(readSessionSort('a')).toBe('updatedAt');
  writeSessionSort('a', 'lastUserPromptAt');
  expect(readSessionSort('a')).toBe('lastUserPromptAt');
  expect(readSessionSort('b')).toBe('updatedAt');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <SessionSortMenu value="updatedAt" onChange={onChange} />
        </I18nProvider>,
      ),
    );
    const button = container.querySelector('button')!;
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      button.click();
    });
    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(items.map((item) => item.textContent)).toEqual([
      'Recent activity',
      'Last question',
    ]);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    await act(async () => items[1].click());
    expect(onChange).toHaveBeenCalledWith('lastUserPromptAt');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
