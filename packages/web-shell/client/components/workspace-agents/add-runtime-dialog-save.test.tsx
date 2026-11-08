// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonUnavailableError } from '../../daemon/availability';
import { I18nProvider } from '../../i18n';
import {
  AddRuntimeDialog,
  type JoinToken,
  type RuntimeJoinOutcome,
  type RuntimeSummary,
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

interface DialogProps {
  onJoinCoordinator?: () => Promise<RuntimeJoinOutcome>;
  onConnectExisting?: (input: unknown) => Promise<RuntimeJoinOutcome>;
  onCreateJoinToken?: () => Promise<JoinToken>;
  runtimes?: RuntimeSummary[];
  replacementTarget?: RuntimeSummary;
  onCreateAgentOn?: (runtimeId: string) => void;
}

/** The dialog with real open state, as the Agents page mounts it. */
function Harness(props: DialogProps) {
  const [open, setOpen] = useState(true);
  return (
    <I18nProvider language="en">
      <button type="button" data-reopen onClick={() => setOpen(true)}>
        Add a runtime
      </button>
      <AddRuntimeDialog
        open={open}
        onOpenChange={setOpen}
        serverUrl="https://hub.example:4170"
        runtimes={[]}
        onCreateJoinToken={vi.fn<() => Promise<JoinToken>>()}
        {...props}
      />
    </I18nProvider>
  );
}

async function renderDialog(props: DialogProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

async function reopen() {
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-reopen]')!.click(),
  );
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

function notSavedNotices() {
  return Array.from(document.querySelectorAll('[role="status"]'))
    .map((item) => item.textContent ?? '')
    .filter((text) => text.includes('could not save the connection'));
}

function notSavedNotice() {
  return Array.from(document.querySelectorAll('[role="status"]')).find((item) =>
    item.textContent?.includes('could not save the connection'),
  )?.textContent;
}

function button(label: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
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

it.each([
  ['an unsaved remote connect', { saveError: 'disk full' }, NOT_SAVED_THERE],
  [
    'an unsaved remote connect with no detail',
    { saveError: '' },
    'That computer connected, but could not save the connection, so it will not reconnect after a restart or a workspace reload.',
  ],
  ['a saved remote connect', {}, undefined],
] as const)(
  'says so after %s it pulled in',
  async (_label, outcome, notice) => {
    const onConnectExisting = vi.fn(async () => outcome);
    await renderDialog({ onConnectExisting });
    await chooseTab('I have its address and token');
    await connectExisting();

    expect(onConnectExisting).toHaveBeenCalledOnce();
    expect(notSavedNotice()).toBe(notice);
  },
);

it('renders the unsaved notice with a period when a join reports no save error', async () => {
  // joinOutcome maps {connected: true, saved: false} with no saveError to
  // {saveError: ''}; the notice must still render, ending in the '.' fallback
  // rather than a dangling colon. Pins both the render guard (!== undefined,
  // not truthiness) and the message's empty-error fallback.
  const onJoinCoordinator = vi.fn(async () => ({ saveError: '' }));
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  expect(notSavedNotice()).toBe(
    'This computer joined, but could not save the connection, so it will not reconnect after a restart or a workspace reload.',
  );
});

it('shows the unsaved notice only under the form it is about', async () => {
  // A warning about one machine must not stay pinned under another's form,
  // nor be lost by looking at another tab, or clicking the one already open.
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onJoinCoordinator: vi.fn(async () => ({})),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await chooseTab('Join a coordinator');
  expect(notSavedNotice()).toBeUndefined();
  await chooseTab('I have its address and token');
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
  await chooseTab('I have its address and token');
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it('keeps an attempt that settles after a tab switch with its own form', async () => {
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  await renderDialog({
    onConnectExisting: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
    onJoinCoordinator: vi.fn(async () => ({})),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Join a coordinator');

  await act(async () => settle({ saveError: 'disk full' }));

  expect(notSavedNotice()).toBeUndefined();
  await chooseTab('I have its address and token');
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it('shows a join’s notice on its result even if another tab was open when it settled', async () => {
  // The result replaces the forms, so there is no tab to switch back to.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  await renderDialog({
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await chooseTab('I have its address and token');

  await act(async () => settle({ saveError: 'disk full' }));

  expect(document.body.textContent).toContain(
    'This computer joined https://hub.example:4170 as a runtime.',
  );
  expect(notSavedNotice()).toBe(NOT_SAVED_HERE);
});

it('shows only this computer’s notice on its joined result', async () => {
  // The remote's notice is about another machine; the joined result is
  // about this one, even with the remote's form open when the join settled.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await chooseTab('I have its address and token');

  await act(async () => settle({ saveError: 'disk full' }));

  expect(notSavedNotices()).toEqual([NOT_SAVED_HERE]);
});

it('shows a remote connect’s notice on its result even if another tab was open when it came online', async () => {
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const props = {
    onConnectExisting: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
    onJoinCoordinator: vi.fn(async () => ({})),
  };
  await renderDialog(props);
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Join a coordinator');
  await act(async () => settle({ saveError: 'disk full' }));
  expect(notSavedNotice()).toBeUndefined();

  // The remote's runtime comes online: the dialog shows it as connected.
  await renderDialog({
    ...props,
    runtimes: [
      {
        id: 'host_1',
        kind: 'external',
        label: 'worker',
        provider: 'qwen',
        status: 'online',
      },
    ],
  });

  expect(document.body.textContent).toContain('worker is connected');
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it.each(['existing', 'join'] as const)(
  'shows what an attempt did when it settles after the dialog was closed and reopened (%s)',
  async (path) => {
    // Closing does not cancel the request; its result is what happened, and
    // the user still needs to hear that it will not survive a restart.
    let settle!: (outcome: RuntimeJoinOutcome) => void;
    const pending = () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve));
    await renderDialog(
      path === 'existing'
        ? { onConnectExisting: pending }
        : { onJoinCoordinator: pending },
    );
    if (path === 'existing') {
      await chooseTab('I have its address and token');
      await connectExisting();
    } else {
      await chooseTab('Join a coordinator');
      await type('joinLink', 'https://hub.example:4170/join/ws_1');
      await type('enrollmentToken', 'join-token');
      await submit('join-coordinator');
    }
    await click('Close');

    await act(async () => settle({ saveError: 'disk full' }));
    await reopen();

    if (path === 'existing') {
      expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
    } else {
      expect(document.body.textContent).toContain(
        'This computer joined https://hub.example:4170 as a runtime.',
      );
      expect(notSavedNotice()).toBe(NOT_SAVED_HERE);
    }
  },
);

it('does not let a close and reopen send a join token that is still in flight', async () => {
  // The token is on its way, and spent once the join lands: sending it again
  // would replace the new connection and then fail.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const onJoinCoordinator = vi.fn(
    () => new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  );
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await click('Close');
  await reopen();

  const connect = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === 'Connect',
  )!;
  expect(connect.disabled).toBe(true);
  await submit('join-coordinator');
  expect(onJoinCoordinator).toHaveBeenCalledOnce();

  await act(async () => settle({}));
  // Joined: the form, and the spent token in it, are gone.
  expect(document.body.textContent).toContain(
    'This computer joined https://hub.example:4170 as a runtime.',
  );
  expect(document.querySelector('input[name="enrollmentToken"]')).toBeNull();
});

it.each(['existing', 'join'] as const)(
  'sends one request for two submits in the same tick (%s)',
  async (path) => {
    const call = vi.fn(() => new Promise<RuntimeJoinOutcome>(() => {}));
    await renderDialog(
      path === 'existing'
        ? { onConnectExisting: call }
        : { onJoinCoordinator: call },
    );
    const formId =
      path === 'existing' ? 'connect-existing-runtime' : 'join-coordinator';
    if (path === 'existing') {
      await chooseTab('I have its address and token');
      await type('remoteUrl', 'https://worker.example');
      await type('remoteToken', 'remote-token');
      await type('remoteCwd', '/remote');
    } else {
      await chooseTab('Join a coordinator');
      await type('joinLink', 'https://hub.example:4170/join/ws_1');
      await type('enrollmentToken', 'join-token');
    }
    const form = document.getElementById(formId) as HTMLFormElement;
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      }
    });
    expect(call).toHaveBeenCalledOnce();
  },
);

it('lets a join be tried again once the previous one has failed', async () => {
  const onJoinCoordinator = vi
    .fn<() => Promise<RuntimeJoinOutcome>>()
    .mockRejectedValueOnce(
      new Error('Invalid or expired Agent Host enrollment token.'),
    )
    .mockResolvedValueOnce({});
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'old-token');
  await submit('join-coordinator');
  await type('enrollmentToken', 'new-token');
  await submit('join-coordinator');

  expect(onJoinCoordinator).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain(
    'This computer joined https://hub.example:4170 as a runtime.',
  );
});

it('does not keep a spent token for the next join', async () => {
  await renderDialog({ onJoinCoordinator: vi.fn(async () => ({})) });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await click('Done');
  await reopen();

  await chooseTab('Join a coordinator');
  expect(
    document.querySelector<HTMLInputElement>('input[name="enrollmentToken"]')!
      .value,
  ).toBe('');
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
  await reopen();

  expect(notSavedNotice()).toBeUndefined();
});

it('keeps each machine’s notice apart', async () => {
  // The remote's notice, hidden while this computer's join result shows,
  // survives that join being dismissed; this computer's goes with it.
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onJoinCoordinator: vi.fn(async () => ({ saveError: 'disk full' })),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  expect(notSavedNotice()).toBe(NOT_SAVED_HERE);

  await click('Done');
  await reopen();
  await chooseTab('I have its address and token');

  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it.each([
  ['refused', 'https://hub.example:4170/join/ws_1'],
  ['malformed', 'not a link'],
] as const)(
  'keeps the remote’s notice when a join tried next is %s',
  async (_label, link) => {
    // A join is about this computer; it does not replace what is known
    // about the remote.
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
    await type('joinLink', link);
    await type('enrollmentToken', 'join-token');
    await submit('join-coordinator');
    await chooseTab('I have its address and token');

    expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
  },
);

it('keeps a notice that was not on screen when the dialog was closed', async () => {
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await chooseTab('Run one command there');
  await click('Close');
  await reopen();
  await chooseTab('I have its address and token');

  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

it('drops a join command created before a remote connect, whose token that connect replaces', async () => {
  // The coordinator keeps one enrollment token; the connect issues its own.
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({})),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  });
  await click('Create join command');
  expect(button('Close (the link keeps working)')).toBeDefined();
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Run one command there');

  expect(document.body.textContent).not.toContain(
    'QWEN_AGENT_HOST_ENROLLMENT_TOKEN=',
  );
  expect(button('Create join command')).toBeDefined();
});

it('drops a notice that was on screen when the dialog was closed', async () => {
  await renderDialog({
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
  });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);

  await click('Close');
  await reopen();

  expect(notSavedNotice()).toBeUndefined();
});

it('keeps the remote’s notice when a join command is created next', async () => {
  // A join command is for another computer; the remote's notice still holds.
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
  await chooseTab('I have its address and token');

  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
});

const mayStillBeJoining = (error: string) =>
  `No answer from this computer’s daemon (${error}). It may still be joining: check on the coordinator before trying again, with a new join token if it did not join.`;

it.each([
  [
    'times out',
    () => new DOMException('signal timed out', 'TimeoutError'),
    mayStillBeJoining('signal timed out'),
  ],
  [
    'loses its connection',
    () => new TypeError('Failed to fetch'),
    mayStillBeJoining('Failed to fetch'),
  ],
  [
    'fails at a proxy',
    () => new Error('Agent request failed (504)'),
    'Agent request failed (504)',
  ],
] as const)(
  'drops the token of a join that %s, which may have spent it',
  async (_label, failure, message) => {
    await renderDialog({
      onJoinCoordinator: vi.fn(async (): Promise<RuntimeJoinOutcome> => {
        throw failure();
      }),
    });
    await chooseTab('Join a coordinator');
    await type('joinLink', 'https://hub.example:4170/join/ws_1');
    await type('enrollmentToken', 'join-token');
    await submit('join-coordinator');

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(
      document.querySelector<HTMLInputElement>('input[name="enrollmentToken"]')!
        .value,
    ).toBe('');
  },
);

it('does not put the remote’s notice on another machine’s connected result', async () => {
  // A computer that joined through a join command is not the remote the
  // notice is about.
  const remote: RuntimeSummary = {
    id: 'host_a',
    kind: 'external',
    label: 'machine-a',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  };
  await renderDialog({ ...props, runtimes: [remote] });
  await chooseTab('I have its address and token');
  await connectExisting();
  expect(notSavedNotice()).toBe(NOT_SAVED_THERE);
  await chooseTab('Run one command there');
  await click('Create join command');

  await renderDialog({
    ...props,
    runtimes: [remote, { ...remote, id: 'host_b', label: 'machine-b' }],
  });

  expect(document.body.textContent).toContain('machine-b is connected');
  expect(notSavedNotices()).toEqual([]);
});

it('does not put the remote’s notice on a join command’s connected result, from either tab', async () => {
  const remote: RuntimeSummary = {
    id: 'host_a',
    kind: 'external',
    label: 'machine-a',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  };
  await renderDialog({ ...props, runtimes: [remote] });
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Run one command there');
  await click('Create join command');
  await chooseTab('I have its address and token');

  await renderDialog({
    ...props,
    runtimes: [remote, { ...remote, id: 'host_b', label: 'machine-b' }],
  });

  expect(document.body.textContent).toContain('machine-b is connected');
  expect(notSavedNotices()).toEqual([]);
});

describe('the remote the address-and-token form connected', () => {
  // The coordinator itself is always listed, here from the same path.
  const local: RuntimeSummary = {
    id: 'local',
    kind: 'local',
    label: 'This computer',
    provider: 'qwen',
    status: 'online',
    workspaceCwd: '/remote',
  };
  const remote: RuntimeSummary = {
    id: 'host_a',
    kind: 'external',
    label: 'machine-a',
    provider: 'qwen',
    status: 'online',
    workspaceCwd: '/remote',
  };
  const other: RuntimeSummary = {
    ...remote,
    id: 'host_b',
    label: 'machine-b',
    workspaceCwd: '/b',
  };
  // Joined before and offline: not new until it comes back.
  const asleep: RuntimeSummary = {
    ...remote,
    id: 'host_z',
    label: 'machine-z',
    status: 'offline',
  };
  const later: RuntimeSummary = {
    ...remote,
    id: 'host_c',
    label: 'machine-c',
    workspaceCwd: '/c',
  };
  const props = () => ({
    onConnectExisting: vi.fn(
      async (): Promise<RuntimeJoinOutcome> => ({
        saveError: 'disk full',
        workspaceCwd: '/remote',
      }),
    ),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  });
  type Dialog = ReturnType<typeof props>;
  const roster = (dialog: Dialog, ...runtimes: RuntimeSummary[]) =>
    renderDialog({ ...dialog, runtimes: [local, asleep, ...runtimes] });
  const commandShown = () =>
    document.body.textContent?.includes(
      "QWEN_AGENT_HOST_ENROLLMENT_TOKEN='join-token'",
    );
  const shown = () =>
    /(machine-\w+) is connected/.exec(document.body.textContent ?? '')?.[1];
  /** Connects the remote (the roster after it misses it), then a command. */
  async function connectThenCommand(
    dialog: Dialog,
    ...before: RuntimeSummary[]
  ) {
    await roster(dialog, ...before);
    await chooseTab('I have its address and token');
    await connectExisting();
    await chooseTab('Run one command there');
    await click('Create join command');
    expect(commandShown()).toBe(true);
  }
  async function doneAndReopen() {
    await click('Done');
    await reopen();
  }

  it('is shown with its notice after a join command was created, and the command keeps waiting', async () => {
    const dialog = props();
    await connectThenCommand(dialog);

    await roster(dialog, remote);
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);

    await doneAndReopen();
    expect(commandShown()).toBe(true);
    expect(shown()).toBeUndefined();
    expect(notSavedNotices()).toEqual([]);
    await roster(dialog, remote, other);
    expect(shown()).toBe('machine-b');
    expect(notSavedNotices()).toEqual([]);
    await doneAndReopen();
    expect(commandShown()).toBe(false);
  });

  it('is shown after the command’s computer when that one is listed first, with its notice', async () => {
    const dialog = props();
    await connectThenCommand(dialog);

    await roster(dialog, other, remote);
    expect(shown()).toBe('machine-b');
    expect(notSavedNotices()).toEqual([]);

    await doneAndReopen();
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);
    await doneAndReopen();
    expect(shown()).toBeUndefined();
    expect(commandShown()).toBe(false);
  });

  it('does not replace a result on screen when another computer shows up', async () => {
    const dialog = props();
    await connectThenCommand(dialog);
    await roster(dialog, other);
    expect(shown()).toBe('machine-b');

    await roster(dialog, other, remote);
    expect(shown()).toBe('machine-b');
    expect(notSavedNotices()).toEqual([]);

    await doneAndReopen();
    await roster(dialog, other, remote, {
      ...remote,
      id: 'host_n',
      label: 'machine-n',
    });
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);
  });

  it('keeps the command waiting when it expired while the remote’s result was open, if its computer came', async () => {
    const dialog = props();
    await connectThenCommand(dialog);
    await roster(dialog, remote, other);
    expect(shown()).toBe('machine-a');

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await doneAndReopen();
    } finally {
      vi.useRealTimers();
    }
    expect(shown()).toBe('machine-b');
  });

  it('ends with the remote’s result once the command expired with no one else come', async () => {
    const dialog = props();
    dialog.onCreateJoinToken.mockResolvedValue({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() - 1,
    });
    await roster(dialog);
    await chooseTab('I have its address and token');
    await connectExisting();
    await chooseTab('Run one command there');
    await click('Create join command');
    await roster(dialog, remote);
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);

    await doneAndReopen();
    await roster(dialog, remote, other);

    expect(shown()).toBeUndefined();
  });

  it('is waited for alone once a remote connect dropped the join command, past other computers', async () => {
    const dialog = props();
    await roster(dialog);
    await click('Create join command');
    await chooseTab('I have its address and token');
    await connectExisting();

    await roster(dialog, other);
    expect(shown()).toBeUndefined();
    await roster(dialog, other, remote);
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);

    await doneAndReopen();
    await roster(dialog, other, remote, later);
    expect(shown()).toBeUndefined();
  });

  it('is the remote connected last, not an earlier one that shows up first', async () => {
    const dialog = props();
    dialog.onConnectExisting
      .mockResolvedValueOnce({ workspaceCwd: '/remote' })
      .mockResolvedValueOnce({
        saveError: 'r2 disk full',
        workspaceCwd: '/r2',
      });
    await roster(dialog);
    await chooseTab('I have its address and token');
    await connectExisting();
    await connectExisting();

    await roster(dialog, remote);
    expect(shown()).toBeUndefined();
    await roster(dialog, remote, {
      ...remote,
      id: 'host_r2',
      label: 'machine-r2',
      workspaceCwd: '/r2',
    });
    expect(shown()).toBe('machine-r2');
    expect(notSavedNotices()).toEqual([
      NOT_SAVED_THERE.replace('disk full', 'r2 disk full'),
    ]);
  });

  it('is kept by a join command when the computers online before serve other workspaces', async () => {
    const prior: RuntimeSummary = {
      ...other,
      id: 'host_p',
      label: 'machine-p',
    };
    const dialog = props();
    await connectThenCommand(dialog, prior);

    await roster(dialog, prior, remote);
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);
    await doneAndReopen();
    expect(commandShown()).toBe(true);
  });

  describe('when a computer online before it connected serves its workspace', () => {
    // The remote may be that one, back under its saved id.
    const before: RuntimeSummary = {
      ...remote,
      id: 'host_x',
      label: 'machine-x',
    };

    it('is not kept by a join command', async () => {
      const dialog = props();
      await connectThenCommand(dialog, before);

      await roster(dialog, before, {
        ...remote,
        id: 'host_s',
        label: 'machine-s',
      });

      // The command's computer, as it would be without a remote.
      expect(shown()).toBe('machine-s');
      expect(notSavedNotices()).toEqual([]);
      await doneAndReopen();
      expect(commandShown()).toBe(false);
    });

    it('is not waited for past the first computer that shows up', async () => {
      const dialog = props();
      await roster(dialog, before);
      await chooseTab('I have its address and token');
      await connectExisting();

      await roster(dialog, before, other);
      expect(shown()).toBe('machine-b');
      expect(notSavedNotices()).toEqual([]);

      await doneAndReopen();
      await roster(dialog, before, other, later);
      expect(shown()).toBeUndefined();
    });
  });

  it('is the first new runtime when its answer does not name its workspace', async () => {
    // An older daemon's answer.
    const dialog = props();
    dialog.onConnectExisting.mockResolvedValue({ saveError: 'disk full' });
    await roster(dialog);
    await chooseTab('I have its address and token');
    await connectExisting();

    await roster(dialog, other, remote);

    expect(shown()).toBe('machine-b');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);
  });

  it('is not told apart from another computer by an answer without its workspace', async () => {
    const dialog = props();
    dialog.onConnectExisting.mockResolvedValue({ saveError: 'disk full' });
    await connectThenCommand(dialog);

    await roster(dialog, remote);

    // Taken for the command's computer, as before.
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([]);
  });

  it('is not waited for again once it showed up', async () => {
    // The next computer serving that path is the join command's.
    const dialog = props();
    await connectThenCommand(dialog);
    await roster(dialog, remote);
    await doneAndReopen();

    await roster(dialog, remote, {
      ...remote,
      id: 'host_s',
      label: 'machine-s',
    });
    expect(shown()).toBe('machine-s');
    expect(notSavedNotices()).toEqual([]);
    await doneAndReopen();
    expect(commandShown()).toBe(false);
  });

  it('leaves nothing to wait for once its own connected result is closed', async () => {
    const dialog = props();
    await roster(dialog);
    await chooseTab('I have its address and token');
    await connectExisting();
    await roster(dialog, remote);
    expect(shown()).toBe('machine-a');
    expect(notSavedNotices()).toEqual([NOT_SAVED_THERE]);

    await doneAndReopen();
    await roster(dialog, remote, other);

    expect(shown()).toBeUndefined();
  });
});

it('does not let a connected result replace a join still in flight', async () => {
  // It would hide the join, and its Create-agent button leave the page.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  };
  await renderDialog(props);
  await click('Create join command');
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  await renderDialog({ ...props, runtimes: [remote] });
  expect(document.body.textContent).not.toContain('machine-b is connected');
  // The footer stays the join form's, not the connected result's.
  expect(button('Done')).toBeUndefined();
  expect(button('Connect')?.disabled).toBe(true);

  await act(async () => settle({ saveError: 'disk full' }));
  expect(notSavedNotices()).toEqual([NOT_SAVED_HERE]);
});

it('keeps a connected result that the joined result covered when the dialog was closed', async () => {
  // The join settles first and takes the dialog over; the computer that ran
  // the join command shows on the next opening.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  };
  await renderDialog(props);
  await click('Create join command');
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await renderDialog({ ...props, runtimes: [remote] });
  await act(async () => settle({}));
  expect(document.body.textContent).toContain(
    'This computer joined https://hub.example:4170 as a runtime.',
  );
  expect(document.body.textContent).not.toContain('machine-b is connected');

  await click('Done');
  await reopen();

  expect(document.body.textContent).toContain('machine-b is connected');
});

it('keeps counting the wait while a connected result is held for a join in flight', async () => {
  // The join command stays on screen, so its clock must not freeze.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    const remote: RuntimeSummary = {
      id: 'host_b',
      kind: 'external',
      label: 'machine-b',
      provider: 'qwen',
      status: 'online',
    };
    const props = {
      onCreateJoinToken: vi.fn(async () => ({
        token: 'join-token',
        workspaceId: 'ws_1',
        expiresAt: Date.now() + 10 * 60_000,
      })),
      onJoinCoordinator: () => new Promise<RuntimeJoinOutcome>(() => {}),
    };
    await renderDialog(props);
    await click('Create join command');
    await chooseTab('Join a coordinator');
    await type('joinLink', 'https://hub.example:4170/join/ws_1');
    await type('enrollmentToken', 'join-token');
    await submit('join-coordinator');
    await renderDialog({ ...props, runtimes: [remote] });
    await chooseTab('Run one command there');
    expect(document.body.textContent).toContain('0s so far.');

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(document.body.textContent).toContain('3s so far.');
  } finally {
    vi.useRealTimers();
  }
});

it('does not show the remote’s notice under a join in flight when the remote comes online', async () => {
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const remote: RuntimeSummary = {
    id: 'host_a',
    kind: 'external',
    label: 'machine-a',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onConnectExisting: vi.fn(async () => ({ saveError: 'disk full' })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  };
  await renderDialog(props);
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  await renderDialog({ ...props, runtimes: [remote] });
  expect(notSavedNotices()).toEqual([]);

  // Once the join settles, its own result takes the dialog over.
  await act(async () => settle({}));
  expect(notSavedNotices()).toEqual([]);
});

it('keeps a connected result that never showed when the dialog was closed', async () => {
  // It was waiting behind a join in flight; closing must not drop it.
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((_resolve, reject) => {
        settle = () => reject(new Error('Invalid or expired token.'));
      }),
  };
  await renderDialog(props);
  await click('Create join command');
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await renderDialog({ ...props, runtimes: [remote] });
  await click('Close');

  await act(async () => settle({}));
  await reopen();

  expect(document.body.textContent).toContain('machine-b is connected');
});

it('keeps the token of a plain-HTTP join the daemon would refuse, and sends nothing', async () => {
  // The daemon refuses it before using the token, so the token stays for a
  // second try once HTTP is allowed.
  const onJoinCoordinator = vi.fn(
    async (): Promise<RuntimeJoinOutcome> => ({}),
  );
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'http://10.0.0.2:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  expect(onJoinCoordinator).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'This join link uses plain HTTP. Tick “Allow plain HTTP” if this network is trusted, or use an HTTPS link.',
  );
  expect(
    document.querySelector<HTMLInputElement>('input[name="enrollmentToken"]')!
      .value,
  ).toBe('join-token');

  await act(async () =>
    document
      .querySelector<HTMLInputElement>('input[name="allowHttp"]')!
      .click(),
  );
  await submit('join-coordinator');

  expect(onJoinCoordinator).toHaveBeenCalledWith({
    serverUrl: 'http://10.0.0.2:4170',
    workspaceId: 'ws_1',
    enrollmentToken: 'join-token',
    allowHttp: true,
  });
});

it.each([
  'http://127.0.0.2:4170/join/ws_1',
  'http://localhost:4170/join/ws_1',
  'http://[::1]:4170/join/ws_1',
  'https://10.0.0.2:4170/join/ws_1',
])('sends a join to %s without asking to allow HTTP', async (link) => {
  // As the daemon checks it: HTTPS, or plain HTTP on loopback.
  const onJoinCoordinator = vi.fn(
    async (): Promise<RuntimeJoinOutcome> => ({}),
  );
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', link);
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  expect(onJoinCoordinator).toHaveBeenCalledOnce();
});

const alertText = () => document.querySelector('[role="alert"]')?.textContent;

it('keeps a join’s error with the join form, even if another tab was open when it failed', async () => {
  let fail!: (cause: Error) => void;
  await renderDialog({
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((_resolve, reject) => (fail = reject)),
    onConnectExisting: vi.fn(async () => ({})),
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await chooseTab('I have its address and token');

  await act(async () =>
    fail(new Error('Invalid or expired Agent Host enrollment token.')),
  );

  // Not under the remote's form, which has a token of its own.
  expect(alertText()).toBeUndefined();
  await chooseTab('Join a coordinator');
  expect(alertText()).toBe('Invalid or expired Agent Host enrollment token.');
  // A remote connect, or a join command, does not clear it either.
  await chooseTab('I have its address and token');
  await connectExisting();
  await chooseTab('Run one command there');
  await click('Create join command');
  await chooseTab('Join a coordinator');
  expect(alertText()).toBe('Invalid or expired Agent Host enrollment token.');
});

it('shows a join’s error on another machine’s connected result, as the join’s', async () => {
  let fail!: (cause: Error) => void;
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((_resolve, reject) => (fail = reject)),
    onCreateAgentOn: vi.fn(),
  };
  await renderDialog(props);
  await click('Create join command');
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await renderDialog({ ...props, runtimes: [remote] });

  await act(async () =>
    fail(new Error('Invalid or expired Agent Host enrollment token.')),
  );

  // Not hidden behind it: its Create-agent button would leave the page.
  expect(document.body.textContent).toContain('machine-b is connected');
  expect(alertText()).toBe(
    'This computer’s join: Invalid or expired Agent Host enrollment token.',
  );
  expect(button('Create an agent on machine-b')).toBeDefined();
  // Seen, so gone with the result.
  await click('Done');
  await reopen();
  expect(alertText()).toBeUndefined();
});

it('keeps a join command’s error with its form, through a join and its result', async () => {
  let settle!: (outcome: RuntimeJoinOutcome) => void;
  await renderDialog({
    onCreateJoinToken: vi.fn(async () => {
      throw new Error('Could not create a join token.');
    }),
    onJoinCoordinator: () =>
      new Promise<RuntimeJoinOutcome>((resolve) => (settle = resolve)),
  });
  await click('Create join command');
  expect(alertText()).toBe('Could not create a join token.');
  await chooseTab('Join a coordinator');
  expect(alertText()).toBeUndefined();
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  // Sending a join leaves the other form's error alone.
  await chooseTab('Run one command there');
  expect(alertText()).toBe('Could not create a join token.');
  // And the joined result is not about it.
  await act(async () => settle({}));
  expect(document.body.textContent).toContain(
    'This computer joined https://hub.example:4170 as a runtime.',
  );
  expect(alertText()).toBeUndefined();
});

it('drops a join command’s error once the next one is created', async () => {
  const onCreateJoinToken = vi
    .fn<() => Promise<JoinToken>>()
    .mockRejectedValueOnce(new Error('Could not create a join token.'))
    .mockResolvedValueOnce({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    });
  await renderDialog({ onCreateJoinToken });
  await click('Create join command');
  expect(alertText()).toBe('Could not create a join token.');

  await click('Create join command');

  expect(onCreateJoinToken).toHaveBeenCalledTimes(2);
  expect(alertText()).toBeUndefined();
});

it('shows a replacement dialog’s own error', async () => {
  // It has the join command form only.
  await renderDialog({
    replacementTarget: {
      id: 'host_1',
      kind: 'external',
      label: 'worker',
      provider: 'qwen',
      status: 'online',
    },
    onCreateJoinToken: vi.fn(async (): Promise<JoinToken> => {
      throw new Error('Could not create a join token.');
    }),
  });
  await click('Create join command');

  expect(alertText()).toBe('Could not create a join token.');
});

it.each(['join', 'existing'] as const)(
  'keeps the form it sent read-only until it settles (%s)',
  async (form) => {
    // What comes back is about the fields as they were sent.
    let end!: () => void;
    await renderDialog({
      onJoinCoordinator: () =>
        new Promise<RuntimeJoinOutcome>(
          (_resolve, reject) =>
            (end = () => reject(new Error('Agent request failed (502)'))),
        ),
      // As the page's wrapper does: a failed connect resolves false.
      onConnectExisting: () =>
        new Promise<RuntimeJoinOutcome>(
          (resolve) => (end = () => resolve(false)),
        ),
    });
    const fields =
      form === 'join'
        ? ['joinLink', 'enrollmentToken']
        : ['remoteUrl', 'remoteToken', 'remoteCwd'];
    const locked = () =>
      fields
        .map(
          (name) =>
            document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
              .readOnly,
        )
        .concat(
          document.querySelector<HTMLInputElement>('input[name="allowHttp"]')!
            .disabled,
        );
    if (form === 'join') {
      await chooseTab('Join a coordinator');
      await type('joinLink', 'https://hub.example:4170/join/ws_1');
      await type('enrollmentToken', 'join-token');
      await submit('join-coordinator');
    } else {
      await chooseTab('I have its address and token');
      await connectExisting();
    }

    expect(locked()).toEqual(fields.map(() => true).concat(true));

    await act(async () => end());

    expect(locked()).toEqual(fields.map(() => false).concat(false));
  },
);

it('sends what the address-and-token form says, HTTP box included', async () => {
  // Read from the form as it is submitted, before it turns read-only.
  const onConnectExisting = vi.fn(
    async (_input: unknown): Promise<RuntimeJoinOutcome> => ({}),
  );
  await renderDialog({ onConnectExisting });
  await chooseTab('I have its address and token');
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('input[name="allowHttp"]')!
      .click(),
  );
  await connectExisting();

  expect(onConnectExisting).toHaveBeenCalledWith({
    remoteUrl: 'https://worker.example',
    remoteToken: 'remote-token',
    remoteCwd: '/remote',
    serverUrl: 'https://hub.example:4170',
    allowHttp: true,
  });
});

it('drops the last join’s error once the next one is sent', async () => {
  const onJoinCoordinator = vi
    .fn<() => Promise<RuntimeJoinOutcome>>()
    .mockRejectedValueOnce(
      new Error('Invalid or expired Agent Host enrollment token.'),
    )
    .mockReturnValueOnce(new Promise<RuntimeJoinOutcome>(() => {}));
  await renderDialog({ onJoinCoordinator });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  expect(alertText()).toBe('Invalid or expired Agent Host enrollment token.');

  await type('enrollmentToken', 'new-join-token');
  await submit('join-coordinator');

  expect(onJoinCoordinator).toHaveBeenCalledTimes(2);
  expect(alertText()).toBeUndefined();
});

it('keeps a join form’s own check off a connected result, for when the form is back', async () => {
  // "Tick Allow plain HTTP" points at a box the connected result does not
  // show; nothing was sent, so it waits under its form.
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: vi.fn(async (): Promise<RuntimeJoinOutcome> => ({})),
  };
  await renderDialog(props);
  await click('Create join command');
  await chooseTab('Join a coordinator');
  await type('joinLink', 'http://10.0.0.2:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  const needsHttp =
    'This join link uses plain HTTP. Tick “Allow plain HTTP” if this network is trusted, or use an HTTPS link.';
  expect(alertText()).toBe(needsHttp);

  await renderDialog({ ...props, runtimes: [remote] });
  expect(document.body.textContent).toContain('machine-b is connected');
  expect(alertText()).toBeUndefined();

  await click('Done');
  await reopen();
  await chooseTab('Join a coordinator');
  expect(alertText()).toBe(needsHttp);
  expect(props.onJoinCoordinator).not.toHaveBeenCalled();
});

it('still shows a failed join’s error on a connected result after a join command is created', async () => {
  // Creating the command resets its own error only.
  const remote: RuntimeSummary = {
    id: 'host_b',
    kind: 'external',
    label: 'machine-b',
    provider: 'qwen',
    status: 'online',
  };
  const props = {
    onCreateJoinToken: vi.fn(async () => ({
      token: 'join-token',
      workspaceId: 'ws_1',
      expiresAt: Date.now() + 10 * 60_000,
    })),
    onJoinCoordinator: vi.fn(async (): Promise<RuntimeJoinOutcome> => {
      throw new Error('Invalid or expired Agent Host enrollment token.');
    }),
  };
  await renderDialog(props);
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  await chooseTab('Run one command there');
  await click('Create join command');

  await renderDialog({ ...props, runtimes: [remote] });

  expect(document.body.textContent).toContain('machine-b is connected');
  expect(alertText()).toBe(
    'This computer’s join: Invalid or expired Agent Host enrollment token.',
  );
});

it('drops an error that was on screen when the dialog was closed', async () => {
  await renderDialog({
    onJoinCoordinator: vi.fn(async (): Promise<RuntimeJoinOutcome> => {
      throw new Error('Invalid or expired Agent Host enrollment token.');
    }),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');
  expect(alertText()).toBe('Invalid or expired Agent Host enrollment token.');

  await click('Close');
  await reopen();

  expect(alertText()).toBeUndefined();
});

it('keeps the token when the daemon was not reachable, so nothing was sent', async () => {
  await renderDialog({
    onJoinCoordinator: vi.fn(async (): Promise<RuntimeJoinOutcome> => {
      throw new DaemonUnavailableError();
    }),
  });
  await chooseTab('Join a coordinator');
  await type('joinLink', 'https://hub.example:4170/join/ws_1');
  await type('enrollmentToken', 'join-token');
  await submit('join-coordinator');

  expect(
    document.querySelector<HTMLInputElement>('input[name="enrollmentToken"]')!
      .value,
  ).toBe('join-token');
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
