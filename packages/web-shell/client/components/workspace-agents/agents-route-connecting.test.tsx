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

// The route with its real wiring; only the daemon behind it is stubbed.
const api = vi.hoisted(() => ({
  listAgents: async () => ({ agents: [], runtimes: [] }),
  createJoinToken: async () => ({
    token: 'join-token',
    workspaceId: 'ws_1',
    expiresAt: Date.now() + 10 * 60_000,
  }),
  joinCoordinator: (_input: unknown): Promise<unknown> => new Promise(() => {}),
  connectRemoteHost: (_input: unknown): Promise<unknown> =>
    new Promise(() => {}),
  createAgent: async () => ({}),
  deleteAgent: async () => ({}),
  setAgentEnabled: async () => ({}),
  updateAgent: async () => ({}),
}));

vi.mock('./threads-api', () => ({ createThreadsHttpApi: () => api }));
vi.mock('../../daemon/availability-context.js', () => ({
  useDaemonAvailability: () => 'available',
  useDaemonAvailabilityController: () => undefined,
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({ workspaceCwd: '/ws' }),
  useWorkspace: () => ({ baseUrl: 'https://hub.example:4170' }),
}));
vi.mock('../../utils/workspace', () => ({
  isAgentCollaborationEnabledForWorkspace: () => true,
}));
vi.mock('../agents/AgentCreatePage', () => ({ AgentCreatePage: () => null }));

const { AgentsRoute } = await import('./agents-route');

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

async function chooseTab(label: string) {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((item) => item.textContent?.trim() === label);
  expect(tab).toBeDefined();
  await act(async () => tab!.click());
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

async function submit(formId: string) {
  const form = document.getElementById(formId) as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

async function showAgents() {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ).find((entry) => entry.textContent?.trim() === 'Agents');
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

it.each([
  [
    'a join',
    async () => {
      await chooseTab('Join a coordinator');
      await type('joinLink', 'https://hub.example:4170/join/ws_1');
      await type('enrollmentToken', 'join-token');
      await submit('join-coordinator');
    },
    'joinCoordinator',
  ],
  [
    'a remote connect',
    async () => {
      await chooseTab('I have its address and token');
      await type('remoteUrl', 'https://worker.example');
      await type('remoteToken', 'remote-token');
      await type('remoteCwd', '/remote');
      await submit('connect-existing-runtime');
    },
    'connectRemoteHost',
  ],
] as const)(
  'holds the page while %s from the dialog is in flight',
  async (_label, send, call) => {
    let settle!: (answer: unknown) => void;
    const spy = vi
      .spyOn(api, call)
      .mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <AgentsRoute initialView="runtime" onOpenDefinitions={vi.fn()} />
        </I18nProvider>,
      );
    });
    await click('Add a runtime');
    await send();
    expect(spy).toHaveBeenCalledOnce();
    await click('Close');
    await showAgents();

    expect(button('New agent')?.disabled).toBe(true);
    expect(button('Role templates')?.disabled).toBe(true);

    await act(async () => settle({ connected: true, saved: true }));

    expect(button('New agent')?.disabled).toBe(false);
    expect(button('Role templates')?.disabled).toBe(false);
    spy.mockRestore();
  },
);
