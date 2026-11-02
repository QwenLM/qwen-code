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
