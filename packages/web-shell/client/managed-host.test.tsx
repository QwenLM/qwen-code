// @vitest-environment jsdom

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderManagedAgentWebShell } from './managed-host';

vi.mock('./ManagedAgentWebShell', () => ({
  ManagedAgentWebShell: ({ sessionId }: { sessionId?: string }) => (
    <div data-web-shell-root>{sessionId}</div>
  ),
}));

it('mounts, replaces props and disposes a host root with its adopted shadow styles', async () => {
  const style = document.createElement('style');
  style.dataset.qwenWebShell = 'component';
  style.textContent = '[data-web-shell-root] { color: red; }';
  document.head.appendChild(style);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadow.appendChild(container);
  let shell!: ReturnType<typeof renderManagedAgentWebShell>;
  try {
    await act(async () => {
      shell = renderManagedAgentWebShell(container, { sessionId: 'first' });
    });
    expect(container.textContent).toBe('first');
    expect(shadow.querySelector('style')?.textContent).toContain(
      '[data-web-shell-root]',
    );
    await act(async () => shell.update({ sessionId: 'second' }));
    expect(container.textContent).toBe('second');
    await act(async () => shell.unmount());
    expect(container.childElementCount).toBe(0);
    expect(shadow.querySelector('style')).toBeNull();
    expect(document.head.contains(style)).toBe(true);
  } finally {
    host.remove();
    style.remove();
  }
});
