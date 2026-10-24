// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedUserMessageQueue } from './ManagedUserMessageQueue';
import type { ManagedUserMessageSnapshot } from './use-managed-user-messages';

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(
  snapshot: ManagedUserMessageSnapshot,
  command = vi.fn().mockResolvedValue(undefined),
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ManagedUserMessageQueue snapshot={snapshot} command={command} />,
    ),
  );
  mounted.push({ root, container });
  return { container, command };
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
const snapshot: ManagedUserMessageSnapshot = {
  paused: false,
  messages: [
    {
      id: 'umsg_1',
      sequence: 1,
      revision: 3,
      state: 'queued',
      input: [
        { type: 'text', text: 'original' },
        {
          type: 'resource',
          resource: {
            uri: 'managed-input:///notes.md',
            mimeType: 'text/markdown',
            text: 'pinned content',
          },
        },
      ],
    },
  ],
};
function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
describe('ManagedUserMessageQueue', () => {
  it('withdraws using the exact message revision', async () => {
    const { container, command } = render(snapshot);
    await act(async () => button(container, 'managed.queue.withdraw').click());
    expect(command).toHaveBeenCalledWith({
      action: 'withdraw',
      messageId: 'umsg_1',
      expectedRevision: 3,
    });
  });
  it('preserves pinned file content when saving an edit', async () => {
    const { container, command } = render(snapshot);
    act(() => button(container, 'managed.queue.edit').click());
    await act(async () => button(container, 'managed.queue.save').click());
    expect(command).toHaveBeenCalledWith({
      action: 'edit',
      messageId: 'umsg_1',
      expectedRevision: 3,
      input: [
        { type: 'input_text', text: 'original' },
        {
          type: 'input_file',
          name: 'notes.md',
          mime_type: 'text/markdown',
          text: 'pinned content',
        },
      ],
    });
  });
  it('makes claimed input immutable and blocked delivery non-resumable', () => {
    const { container } = render({
      paused: true,
      messages: [
        {
          ...snapshot.messages[0],
          state: 'recovery_blocked',
          turnId: 'turn_old',
        },
      ],
    });
    expect(container.textContent).not.toContain('managed.queue.withdraw');
    expect(container.textContent).not.toContain('managed.queue.edit');
    expect(button(container, 'managed.queue.resume').disabled).toBe(true);
  });
  it('allows withdrawing a context mismatch that was never dispatched', async () => {
    const { container, command } = render({
      paused: true,
      messages: [{ ...snapshot.messages[0], state: 'recovery_blocked' }],
    });
    await act(async () => button(container, 'managed.queue.withdraw').click());
    expect(command).toHaveBeenCalledWith({
      action: 'withdraw',
      messageId: 'umsg_1',
      expectedRevision: 3,
    });
  });
});
