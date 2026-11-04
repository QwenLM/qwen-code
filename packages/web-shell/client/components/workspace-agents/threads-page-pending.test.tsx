// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { RuntimeJoinOutcome } from './add-runtime-dialog';
import { ThreadsPage, type ThreadsPageProps } from './ThreadsPage';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage(props: Partial<ThreadsPageProps>) {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ThreadsPage
          agents={[]}
          view="agents"
          onViewChange={vi.fn()}
          onDeleteAgent={vi.fn()}
          onSetAgentEnabled={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
}

function button(label: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => target!.click());
}

async function type(name: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([
  [{ connecting: true }, true],
  [{ pending: true }, false],
  [{}, false],
] as const)(
  'keeps the page while a join or remote connect is in flight (%o)',
  async (state, held) => {
    // Leaving for the agent builder or the role templates would unmount the
    // runtime dialog and drop what it sent; other actions do not.
    await renderPage({
      onOpenAgentBuilder: vi.fn(),
      onOpenDefinitions: vi.fn(),
      ...state,
    });

    expect(button('New agent')?.disabled).toBe(held);
    expect(button('Role templates')?.disabled).toBe(held);
  },
);

it.each([
  [{ connecting: true }, true],
  [{ pending: true }, true],
  [{}, false],
] as const)(
  'holds Mention in chat, which leaves the page, on agents and squads (%o)',
  async (state, held) => {
    const reviewer = {
      id: 'agent-1',
      name: 'reviewer',
      enabled: true,
      status: 'idle' as const,
      waiting: 0,
    };
    const props = {
      agents: [reviewer],
      onMentionAgent: vi.fn(),
      squads: {
        squads: [
          {
            id: 'squad-1',
            name: 'reviewers',
            leaderAgentId: 'agent-1',
            leaderName: 'reviewer',
            members: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        onCreate: vi.fn(async () => true),
        onUpdate: vi.fn(async () => true),
        onRetire: vi.fn(),
      },
      ...state,
    };
    await renderPage({ ...props, view: 'agents' });
    expect(button('Mention in chat')?.disabled).toBe(held);

    await renderPage({ ...props, view: 'squads' });
    // The agents view stays in the page, hidden.
    const squadMention = Array.from(
      document.querySelectorAll('[data-testid="squads-section"] button'),
    ).find((item) => item.textContent?.trim() === 'Mention in chat');
    expect((squadMention as HTMLButtonElement | undefined)?.disabled).toBe(
      held,
    );
  },
);

it('keeps a join sent from the add dialog through a replacement in between', async () => {
  // Replacing a runtime opens its own dialog; the add dialog, and the join
  // still in flight in it, are left as they were.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const onJoinCoordinator = vi.fn(
    () => new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  );
  await renderPage({
    view: 'runtime',
    runtimes: [
      {
        id: 'host_1',
        kind: 'external',
        label: 'worker',
        provider: 'qwen',
        status: 'online',
      },
    ],
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator,
  });
  await click('Add a runtime');
  await act(async () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === 'Join a coordinator')!
      .click(),
  );
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await act(async () =>
    document
      .getElementById('join-coordinator')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await click('Close');
  await click('Replace Host');
  await click('Close');
  await click('Add a runtime');

  expect(button('Connect')?.disabled).toBe(true);
  await act(async () => settle({ saveError: 'disk full' }));

  expect(onJoinCoordinator).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain(
    'This computer joined, but could not save the connection, so it will not reconnect after a restart or a workspace reload: disk full',
  );
});

const worker = {
  id: 'host_1',
  kind: 'external' as const,
  label: 'worker',
  provider: 'qwen',
  status: 'online' as const,
};

it.each([true, false])(
  'offers to create an agent on a replacement only while nothing is in flight (%s)',
  async (connecting) => {
    // Creating an agent leaves the page, and with it a request in flight.
    const props: Partial<ThreadsPageProps> = {
      view: 'runtime',
      runtimes: [worker],
      hostServerUrl: 'https://hub.example:4170',
      connecting,
      onOpenAgentBuilder: vi.fn(),
      onCreateJoinToken: vi.fn(async () => ({
        token: 'join-token',
        workspaceId: 'ws_1',
        expiresAt: Date.now() + 10 * 60_000,
      })),
    };
    await renderPage(props);
    await click('Replace Host');
    await click('Create join command');
    // Only the replacement dialog is open, not the add dialog beside it.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await renderPage({
      ...props,
      runtimes: [{ ...worker, id: 'host_2', label: 'worker-2' }],
    });

    expect(document.body.textContent).toContain(
      'worker was replaced by worker-2',
    );
    expect(button('Create an agent on worker-2') !== undefined).toBe(
      !connecting,
    );
  },
);
