// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  AddRuntimeDialog,
  type JoinToken,
  type RuntimeJoinOutcome,
} from './add-runtime-dialog';

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

const NOT_SAVED_HERE =
  'This computer joined, but could not save the connection, so it will not reconnect after a restart or a workspace reload: disk full';
const NOT_SAVED_THERE =
  'That computer connected, but could not save the connection, so it will not reconnect after a restart or a workspace reload: disk full';

async function renderDialog(props: {
  onJoinCoordinator?: () => Promise<RuntimeJoinOutcome>;
  onConnectExisting?: () => Promise<RuntimeJoinOutcome>;
  onCreateJoinToken?: () => Promise<JoinToken>;
}) {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <AddRuntimeDialog
          open
          onOpenChange={() => {}}
          serverUrl="https://hub.example:4170"
          runtimes={[]}
          onCreateJoinToken={vi.fn<() => Promise<JoinToken>>()}
          {...props}
        />
      </I18nProvider>,
    );
  });
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

function notSavedNotice() {
  return Array.from(document.querySelectorAll('[role="status"]')).find((item) =>
    item.textContent?.includes('could not save the connection'),
  )?.textContent;
}

async function click(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function connectExisting() {
  await type('remoteUrl', 'https://worker.example');
  await type('remoteToken', 'remote-token');
  await type('remoteCwd', '/remote');
  await submit('connect-existing-runtime');
}

it.each([
  ['an unsaved join', { saveError: 'disk full' }, NOT_SAVED_HERE],
  ['a saved join', {}, undefined],
] as const)(
  'says so after %s to another coordinator',
  async (_label, outcome, notice) => {
    const onJoinCoordinator = vi.fn(async () => outcome);
    await renderDialog({ onJoinCoordinator });
    await chooseTab('Join a coordinator');
    await type('joinLink', 'https://hub.example:4170/join/ws_1');
    await type('enrollmentToken', 'join-token');
    await submit('join-coordinator');

    expect(onJoinCoordinator).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(
      'This computer joined https://hub.example:4170 as a runtime.',
    );
    expect(notSavedNotice()).toBe(notice);
  },
);

it('says so when a remote it pulled in could not save the connection', async () => {
  const onConnectExisting = vi.fn(async () => ({ saveError: 'disk full' }));
  await renderDialog({ onConnectExisting });
  await chooseTab('I have its address and token');
  await connectExisting();

  expect(onConnectExisting).toHaveBeenCalledOnce();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it('drops the notice when the next connect fails', async () => {
  const onConnectExisting = vi
    .fn<() => Promise<RuntimeJoinOutcome>>()
    .mockResolvedValueOnce({ saveError: 'disk full' })
    .mockResolvedValueOnce(false);
  await renderDialog({ onConnectExisting });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await connectExisting();

  expect(onConnectExisting).toHaveBeenCalledTimes(2);
  expect(notSavedNotice()).toBeUndefined();
});

it('drops the notice once the dialog is closed', async () => {
  await renderDialog({
    onJoinCoordinator: vi.fn(async () => ({ saveError: 'disk full' })),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  expect(notSavedNotice()).toBe(NOT_SAVED_HERE);

  await click('Done');

  expect(notSavedNotice()).toBeUndefined();
});

it('drops the notice when a join tried next fails', async () => {
  const onJoinCoordinator = vi.fn(async (): Promise<RuntimeJoinOutcome> => {
    throw new Error('Invalid or expired Agent Host enrollment token.');
  });
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onJoinCoordinator,
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  expect(onJoinCoordinator).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain(
    'Invalid or expired Agent Host enrollment token.',
  );
  expect(notSavedNotice()).toBeUndefined();
});

it('drops the notice when closed while keeping a join link', async () => {
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  });
  await click('Create join command');
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await chooseTab('Run one command there');
  await click('Close (the link keeps working)');

  expect(notSavedNotice()).toBeUndefined();
});

it('drops the notice when a join command is created next', async () => {
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await chooseTab('Run one command there');
  await click('Create join command');

  expect(notSavedNotice()).toBeUndefined();
});

it('does not carry what was typed on one tab into the other tab’s fields', async () => {
  // Both forms sit in the same place; without their own keys React reused
  // their inputs, so a join token showed up as the remote workspace.
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({})),
    onJoinCoordinator: vi.fn(async () => ({})),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'SECRET-TOKEN');
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('input[name="allowHttp"]')!
      .click(),
  );

  await chooseTab('I have its address and token');

  for (const name of ['remoteUrl', 'remoteToken', 'remoteCwd']) {
    expect(
      document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value,
    ).toBe('');
  }
  // Nor an opt-in to plain HTTP.
  expect(
    document.querySelector<HTMLInputElement>('input[name="allowHttp"]')!
      .checked,
  ).toBe(false);
});
