// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonExtensionEntry,
  type ExtensionOperationStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, connection, signals } = vi.hoisted(() => ({
  actions: {
    loadExtensionsStatus: vi.fn(),
    installExtension: vi.fn(),
    activeExtensionOperations: vi.fn(),
    extensionOperationStatus: vi.fn(),
    respondToExtensionInteraction: vi.fn(),
    checkExtensionUpdates: vi.fn(),
    refreshExtensions: vi.fn(),
    enableExtension: vi.fn(),
    disableExtension: vi.fn(),
    updateExtension: vi.fn(),
    uninstallExtension: vi.fn(),
  },
  connection: { clientId: 'client-1' as string | undefined },
  signals: { extensionsVersion: 0 },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useWorkspaceActions: () => actions,
  useWorkspaceEventSignals: () => signals,
}));

const { ExtensionsManagerPage } = await import('./ExtensionsManagerPage');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function extension(
  updateState?: DaemonExtensionEntry['updateState'],
): DaemonExtensionEntry {
  return {
    kind: 'extension',
    id: 'demo',
    name: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    isActive: true,
    path: '/tmp/demo',
    updateState,
    capabilities: {
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      hookCount: 0,
      commandCount: 0,
      contextFileCount: 0,
      channelCount: 0,
      hasSettings: false,
    },
  };
}

function renderPage() {
  root?.render(
    <I18nProvider language="en">
      <ExtensionsManagerPage onClose={vi.fn()} />
    </I18nProvider>,
  );
}

async function mount(
  extensions: DaemonExtensionEntry[] = [],
  activeOperations: ExtensionOperationStatus[] = [],
) {
  actions.activeExtensionOperations.mockResolvedValue({
    v: 1,
    operations: activeOperations,
  });
  if (!actions.checkExtensionUpdates.getMockImplementation()) {
    actions.checkExtensionUpdates.mockResolvedValue({ states: {} });
  }
  actions.loadExtensionsStatus.mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    extensions,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    renderPage();
  });
  await flush();
}

function buttonIncluding(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function elementIncluding(selector: string, text: string): Element | undefined {
  return Array.from(document.querySelectorAll(selector)).find((element) =>
    element.textContent?.includes(text),
  );
}

function click(element: Element | undefined) {
  if (!element) throw new Error('click target not found');
  act(() => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function pointerDown(element: Element | undefined) {
  if (!element) throw new Error('pointer target not found');
  act(() => {
    element.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
}

function changeInput(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('input not found');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function startInstall() {
  click(buttonIncluding('Add Extension'));
  changeInput(document.querySelector('#extension-source'), 'owner/repo');
  click(buttonIncluding('Install'));
  await flush();
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  connection.clientId = 'client-1';
  signals.extensionsVersion = 0;
  vi.clearAllMocks();
});

describe('ExtensionsManagerPage', () => {
  it('recovers an active extension operation when reopened', async () => {
    actions.extensionOperationStatus.mockResolvedValue({
      v: 1,
      operationId: 'op-active',
      operation: 'install',
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      source: 'owner/repo',
      result: { status: 'installed', name: 'demo' },
    });

    await mount(
      [],
      [
        {
          v: 1,
          operationId: 'op-active',
          operation: 'install',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
          source: 'owner/repo',
        },
      ],
    );

    expect(actions.extensionOperationStatus).toHaveBeenCalledWith('op-active');
    expect(document.body.textContent).toContain('installed');
  });

  it('reloads the extension list without refreshing daemon sessions', async () => {
    await mount();

    actions.loadExtensionsStatus.mockClear();
    click(buttonIncluding('refresh'));
    await flush();

    expect(actions.loadExtensionsStatus).toHaveBeenCalledOnce();
    expect(actions.refreshExtensions).not.toHaveBeenCalled();
  });

  it('disables adding another extension while an install is pending', async () => {
    actions.installExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-1',
    });
    actions.extensionOperationStatus.mockResolvedValue({
      v: 1,
      operationId: 'op-1',
      operation: 'install',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    });
    await mount();

    await startInstall();

    expect(actions.installExtension).toHaveBeenCalledOnce();
    expect(buttonIncluding('Add Extension')?.disabled).toBe(true);
  });

  it('closes a failed interaction and resumes polling the install', async () => {
    actions.installExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-1',
    });
    actions.extensionOperationStatus
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-1',
        operation: 'install',
        status: 'waiting_for_input',
        createdAt: 1,
        updatedAt: 2,
        interaction: {
          id: 'interaction-1',
          kind: 'setting',
          setting: {
            name: 'API key',
            description: 'Enter an API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-1',
        operation: 'install',
        status: 'waiting_for_input',
        createdAt: 1,
        updatedAt: 3,
        interaction: {
          id: 'interaction-2',
          kind: 'setting',
          setting: {
            name: 'Second API key',
            description: 'Enter another API key',
            envVar: 'SECOND_API_KEY',
            sensitive: true,
          },
        },
      });
    actions.respondToExtensionInteraction.mockRejectedValue(
      new Error('Interaction expired'),
    );
    await mount();

    await startInstall();
    changeInput(
      document.querySelector('input[aria-label="API key"]'),
      'secret',
    );
    click(buttonIncluding('Install'));
    await flush();

    expect(actions.respondToExtensionInteraction).toHaveBeenCalledWith(
      'op-1',
      'interaction-1',
      { value: 'secret' },
      'client-1',
    );
    expect(actions.extensionOperationStatus).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Interaction expired');
    expect(
      (
        document.querySelector(
          'input[aria-label="Second API key"]',
        ) as HTMLInputElement | null
      )?.value,
    ).toBe('');
  });

  it('keeps polling while an interaction is waiting', async () => {
    vi.useFakeTimers();
    actions.installExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-waiting',
    });
    actions.extensionOperationStatus
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-waiting',
        operation: 'install',
        status: 'waiting_for_input',
        createdAt: 1,
        updatedAt: 2,
        interaction: {
          id: 'interaction-waiting',
          kind: 'setting',
          setting: {
            name: 'API key',
            description: 'Enter an API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-waiting',
        operation: 'install',
        status: 'failed',
        createdAt: 1,
        updatedAt: 3,
        error: 'Extension interaction timed out',
      });

    try {
      await mount();
      await startInstall();
      expect(document.body.textContent).toContain('API key');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await flush();

      expect(actions.extensionOperationStatus).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(
        'Extension interaction timed out',
      );
      expect(buttonIncluding('Add Extension')?.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains operation tracking after a transient status error', async () => {
    vi.useFakeTimers();
    actions.installExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-retry',
    });
    actions.extensionOperationStatus
      .mockRejectedValueOnce(new Error('Temporary network error'))
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-retry',
        operation: 'install',
        status: 'succeeded',
        createdAt: 1,
        updatedAt: 2,
        result: { status: 'installed', name: 'demo' },
      });

    try {
      await mount();
      await startInstall();
      expect(document.body.textContent).toContain('Temporary network error');
      expect(buttonIncluding('Add Extension')?.disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await flush();

      expect(actions.extensionOperationStatus).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain('installed');
      expect(buttonIncluding('Add Extension')?.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops tracking an operation that is no longer on the daemon', async () => {
    actions.installExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-missing',
    });
    actions.extensionOperationStatus.mockRejectedValue(
      new DaemonHttpError(404, {}, 'Operation not found'),
    );

    await mount();
    await startInstall();

    expect(actions.extensionOperationStatus).toHaveBeenCalledOnce();
    expect(buttonIncluding('Add Extension')?.disabled).toBe(false);
    expect(document.body.textContent).toContain('Operation not found');
  });

  it('checks for updates automatically after loading extensions', async () => {
    actions.checkExtensionUpdates.mockResolvedValue({
      states: { demo: 'update available' },
    });

    await mount([extension()]);

    expect(actions.checkExtensionUpdates).toHaveBeenCalledWith('client-1');
    expect(document.body.textContent).toContain('update available');
  });

  it('updates an extension without a session client id', async () => {
    connection.clientId = undefined;
    actions.checkExtensionUpdates.mockResolvedValue({
      states: { demo: 'update available' },
    });
    actions.updateExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-update',
    });
    actions.extensionOperationStatus
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-update',
        operation: 'update',
        status: 'waiting_for_input',
        createdAt: 1,
        updatedAt: 2,
        interaction: {
          id: 'interaction-update',
          kind: 'setting',
          setting: {
            name: 'Optional setting',
            description: 'May be left empty',
            envVar: 'OPTIONAL_SETTING',
            sensitive: false,
          },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        operationId: 'op-update',
        operation: 'update',
        status: 'succeeded',
        createdAt: 1,
        updatedAt: 3,
        result: { status: 'updated', name: 'demo' },
      });
    actions.respondToExtensionInteraction.mockResolvedValue({ accepted: true });
    await mount([extension()]);

    click(document.querySelector('[data-slot="card"]') ?? undefined);
    await flush();
    pointerDown(
      document.querySelector('button[aria-label="Extension actions"]') ??
        undefined,
    );
    await flush();
    click(
      elementIncluding('[data-slot="dropdown-menu-item"]', 'Update Extension'),
    );
    await flush();

    expect(actions.updateExtension).toHaveBeenCalledWith('demo', undefined);
    expect(actions.extensionOperationStatus).toHaveBeenCalledWith('op-update');
    expect(document.body.textContent).toContain('Optional setting');
    click(buttonIncluding('Update'));
    await flush();
    expect(actions.respondToExtensionInteraction).toHaveBeenCalledWith(
      'op-update',
      'interaction-update',
      { value: '' },
      undefined,
    );
    expect(actions.extensionOperationStatus).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      'Wait for the session to connect',
    );
  });

  it('opens extension details with the keyboard', async () => {
    await mount([extension()]);

    const card = document.querySelector('[data-slot="card"]');
    expect(card?.getAttribute('role')).toBe('button');
    act(() => {
      card?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();

    expect(document.querySelector('h1')?.textContent).toContain('Demo');
  });

  it('clears stale update states when the extensions signal changes', async () => {
    actions.checkExtensionUpdates.mockResolvedValue({
      states: { demo: 'update available' },
    });
    await mount([extension('up to date')]);
    expect(document.body.textContent).toContain('update available');

    signals.extensionsVersion = 1;
    await act(async () => {
      renderPage();
    });
    await flush();

    expect(document.body.textContent).not.toContain('update available');
  });
});
