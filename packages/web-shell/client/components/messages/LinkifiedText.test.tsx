// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const externalOpenMock = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  isExternalOpenUrl: vi.fn(() => true),
  openExternalUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/externalOpen', () => externalOpenMock);

import { LinkifiedText } from './LinkifiedText';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  externalOpenMock.isDesktopShell.mockReturnValue(false);
  vi.clearAllMocks();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

describe('LinkifiedText', () => {
  it('renders URLs as external anchors', () => {
    const container = render(
      <LinkifiedText text="see https://example.com/docs, then reply" />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('https://example.com/docs');
    expect(container.textContent).toBe(
      'see https://example.com/docs, then reply',
    );
  });

  it('trims trailing punctuation from the link text', () => {
    const container = render(<LinkifiedText text="看 https://a.example/b。" />);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://a.example/b');
    expect(container.textContent).toBe('看 https://a.example/b。');
  });

  it('renders plain text unchanged when there is no URL', () => {
    const container = render(<LinkifiedText text="mail me at a@b.test" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('mail me at a@b.test');
  });

  it('normalizes a bare % in the href but keeps the visible text verbatim', () => {
    const container = render(
      <LinkifiedText text="discount https://example.com/100% today" />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/100%25');
    expect(link?.textContent).toBe('https://example.com/100%');
  });

  it('leaves valid percent-encoding untouched', () => {
    const container = render(
      <LinkifiedText text="see https://example.com/a%20b end" />,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/a%20b',
    );
  });

  // A `%` followed by two non-hex alphanumerics is not encoded — the same
  // rule as the assistant path's normalizeUri.
  it('leaves a % followed by two alphanumerics untouched', () => {
    const container = render(
      <LinkifiedText text="see https://example.com/50%off end" />,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/50%off',
    );
  });

  it('sends the normalized href to the desktop external opener', () => {
    externalOpenMock.isDesktopShell.mockReturnValue(true);
    const container = render(
      <LinkifiedText text="see https://example.com/100%" />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      link!.dispatchEvent(event);
    });

    expect(externalOpenMock.openExternalUrl).toHaveBeenCalledWith(
      'https://example.com/100%25',
    );
  });

  it('routes clicks through the desktop external opener', () => {
    externalOpenMock.isDesktopShell.mockReturnValue(true);
    const container = render(<LinkifiedText text="see https://a.example/b" />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      link!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(externalOpenMock.openExternalUrl).toHaveBeenCalledWith(
      'https://a.example/b',
    );
  });
});
