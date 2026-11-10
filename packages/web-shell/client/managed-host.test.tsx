// @vitest-environment jsdom

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderManagedAgentWebShell } from './managed-host';

vi.mock('./ManagedAgentWebShell', () => ({
  ManagedAgentWebShell: ({ sessionId }: { sessionId?: string }) => (
    <div data-web-shell-root>{sessionId}</div>
  ),
}));

it('mounts, replaces props and disposes a host root', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const container = document.createElement('div');
  host.appendChild(container);
  let shell!: ReturnType<typeof renderManagedAgentWebShell>;
  try {
    await act(async () => {
      shell = renderManagedAgentWebShell(container, { sessionId: 'first' });
    });
    expect(container.textContent).toBe('first');
    await act(async () => shell.update({ sessionId: 'second' }));
    expect(container.textContent).toBe('second');
    await act(async () => shell.unmount());
    expect(container.childElementCount).toBe(0);
  } finally {
    host.remove();
  }
});

it('keeps shadow-root styles until the last host root unmounts', async () => {
  const packageStyle = document.createElement('style');
  packageStyle.dataset.qwenWebShell = 'component';
  packageStyle.textContent = '[data-web-shell-root] { color: red; }';
  document.head.appendChild(packageStyle);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const first = document.createElement('div');
  const second = document.createElement('div');
  shadow.append(first, second);
  let left!: ReturnType<typeof renderManagedAgentWebShell>;
  let right!: ReturnType<typeof renderManagedAgentWebShell>;
  try {
    await act(async () => {
      left = renderManagedAgentWebShell(first, { sessionId: 'first' });
      right = renderManagedAgentWebShell(second, { sessionId: 'second' });
    });
    const hasStyles = () =>
      shadow.querySelectorAll('style').length > 0 ||
      (shadow.adoptedStyleSheets?.length ?? 0) > 0;
    expect(hasStyles()).toBe(true);
    await act(async () => left.unmount());
    expect(second.textContent).toBe('second');
    expect(hasStyles()).toBe(true);
    await act(async () => right.unmount());
    expect(hasStyles()).toBe(false);
  } finally {
    packageStyle.remove();
    host.remove();
  }
});

it('shares one adopted sheet across host roots and survives a repeated disposal', async () => {
  vi.stubGlobal(
    'CSSStyleSheet',
    class {
      replaceSync(_css: string) {}
    },
  );
  const packageStyle = document.createElement('style');
  packageStyle.dataset.qwenWebShell = 'component';
  packageStyle.textContent = '[data-web-shell-root] { color: red; }';
  document.head.appendChild(packageStyle);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  let sheets: CSSStyleSheet[] = [];
  Object.defineProperty(shadow, 'adoptedStyleSheets', {
    get: () => sheets,
    set: (next: CSSStyleSheet[]) => {
      sheets = next;
    },
  });
  const first = document.createElement('div');
  const second = document.createElement('div');
  shadow.append(first, second);
  let left!: ReturnType<typeof renderManagedAgentWebShell>;
  let right!: ReturnType<typeof renderManagedAgentWebShell>;
  try {
    await act(async () => {
      left = renderManagedAgentWebShell(first, { sessionId: 'first' });
      right = renderManagedAgentWebShell(second, { sessionId: 'second' });
    });
    expect(sheets).toHaveLength(1);
    await act(async () => left.unmount());
    expect(sheets).toHaveLength(1);
    // React treats a second root.unmount() as a no-op, so a host that disposes
    // twice must not spend the sibling's reference.
    await act(async () => left.unmount());
    expect(sheets).toHaveLength(1);
    expect(second.textContent).toBe('second');
    await act(async () => right.unmount());
    expect(sheets).toHaveLength(0);
  } finally {
    packageStyle.remove();
    host.remove();
    vi.unstubAllGlobals();
  }
});
