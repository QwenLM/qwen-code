// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, connection } = vi.hoisted(() => ({
  actions: {
    loadExtensionsStatus: vi.fn(),
    installExtension: vi.fn(),
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
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useWorkspaceActions: () => actions,
  useWorkspaceEventSignals: () => ({ extensionsVersion: 0 }),
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

async function mount() {
  actions.loadExtensionsStatus.mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    extensions: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <ExtensionsManagerPage onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
  await flush();
}

function buttonIncluding(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
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
  vi.clearAllMocks();
});

describe('ExtensionsManagerPage', () => {
  it('refreshes daemon sessions before reloading the extension list', async () => {
    actions.refreshExtensions.mockResolvedValue({ refreshed: 1, failed: 0 });
    await mount();

    actions.loadExtensionsStatus.mockClear();
    click(buttonIncluding('refresh'));
    await flush();

    expect(actions.refreshExtensions).toHaveBeenCalledWith('client-1');
    expect(actions.loadExtensionsStatus).toHaveBeenCalledOnce();
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
        status: 'failed',
        createdAt: 1,
        updatedAt: 3,
        error: 'Interaction expired',
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
  });
});
