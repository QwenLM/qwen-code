// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, connection } = vi.hoisted(() => ({
  actions: {
    loadExtensionsStatus: vi.fn(),
    checkExtensionUpdates: vi.fn(),
    refreshExtensions: vi.fn(),
    enableExtension: vi.fn(),
    disableExtension: vi.fn(),
    updateExtension: vi.fn(),
    uninstallExtension: vi.fn(),
    extensionOperationStatus: vi.fn(),
  },
  connection: {
    clientId: undefined as string | undefined,
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useWorkspaceActions: () => actions,
  useWorkspaceEventSignals: () => ({ extensionsVersion: 0 }),
}));

const { ExtensionsDialog } = await import('./ExtensionsDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const extension = (isActive: boolean) => ({
  kind: 'extension' as const,
  id: 'ext-demo',
  name: 'demo',
  displayName: 'Demo',
  version: '1.0.0',
  isActive,
  path: '/tmp/demo',
  capabilities: {
    mcpServers: [],
    commands: [],
    skills: [],
    agents: [],
    contextFiles: [],
    settings: [],
  },
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <ExtensionsDialog />
      </I18nProvider>,
    );
  });
  await flush();
}

function click(el: Element | undefined) {
  if (!el) throw new Error('click target not found');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function buttonIncluding(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function buttonsIncluding(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((button) =>
    button.textContent?.includes(text),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  connection.clientId = undefined;
  vi.clearAllMocks();
});

describe('ExtensionsDialog', () => {
  it('disables an extension without requiring a session client id', async () => {
    actions.loadExtensionsStatus
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/tmp/workspace',
        initialized: true,
        extensions: [extension(true)],
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/tmp/workspace',
        initialized: true,
        extensions: [extension(false)],
      });
    actions.checkExtensionUpdates.mockResolvedValue({ states: {} });
    actions.disableExtension.mockResolvedValue({
      accepted: true,
      operationId: 'op-1',
    });

    await mount();

    click(buttonIncluding('Demo'));
    click(buttonIncluding('Disable Extension'));
    await flush();

    expect(actions.disableExtension).toHaveBeenCalledWith(
      'demo',
      { scope: 'user' },
      undefined,
    );
    expect(actions.extensionOperationStatus).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('disabled');
  });

  it('requires a session client id before uninstalling an extension', async () => {
    actions.loadExtensionsStatus.mockResolvedValue({
      v: 1,
      workspaceCwd: '/tmp/workspace',
      initialized: true,
      extensions: [extension(true)],
    });
    actions.checkExtensionUpdates.mockResolvedValue({ states: {} });

    await mount();

    click(buttonIncluding('Demo'));
    click(buttonIncluding('Uninstall Extension'));
    click(buttonsIncluding('Uninstall Extension').at(-1));
    await flush();

    expect(actions.uninstallExtension).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Wait for the session to connect',
    );
  });
});
