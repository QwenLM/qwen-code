// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdk = vi.hoisted(() => ({
  constructed: [] as Array<{ baseUrl: string; token?: string }>,
  client: {
    capabilities: vi.fn(),
    workspacePathSuggestions: vi.fn(),
    addWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    workspaceDirectoryPicker: vi.fn(),
  },
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: function DaemonClient(options: {
    baseUrl: string;
    token?: string;
  }) {
    sdk.constructed.push(options);
    return sdk.client;
  },
}));

const { AddHostedWorkspaceDialog } = await import('./AddHostedWorkspaceDialog');

const originalLocation = window.location;
const PAGE = originalLocation.origin;
const REMOTE = 'https://remote.example:4170';
const assign = vi.fn();

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setLocation(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
    },
    writable: true,
    configurable: true,
  });
}

async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

// Lets the capability probe and the state it sets settle.
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const buttonNamed = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === name,
  )!;
const submitButton = () =>
  document.querySelector<HTMLButtonElement>('button[type="submit"]')!;

function typeInto(selector: string, value: string) {
  const target = document.querySelector<HTMLInputElement>(selector)!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  sdk.constructed.length = 0;
  sdk.client.capabilities.mockResolvedValue({
    features: ['dynamic_workspace_registration'],
    workspaceCwd: '/repo/app',
    workspaces: [],
  });
  sdk.client.workspacePathSuggestions.mockResolvedValue({
    dir: '/repo/',
    sep: '/',
    suggestions: [],
    truncated: false,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe('AddHostedWorkspaceDialog', () => {
  it('registers a folder on the connected daemon in place', async () => {
    setLocation(`${PAGE}/session/s1`);
    const onClose = vi.fn();
    const onAddCurrent = vi.fn().mockResolvedValue(undefined);
    await mount(
      <AddHostedWorkspaceDialog
        onClose={onClose}
        onAddCurrent={onAddCurrent}
      />,
    );

    act(() => buttonNamed('Next: choose folder').click());
    await flush();
    expect(sdk.constructed.map((options) => options.baseUrl)).toEqual([PAGE]);

    act(() => submitButton().click());
    await flush();

    expect(onAddCurrent).toHaveBeenCalledWith('/repo/', false, undefined);
    expect(sdk.client.addWorkspace).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('returns to the original session when a cross-host add is cancelled', async () => {
    const original = `${PAGE}/session/original?workspace=local-ws`;
    const params = new URLSearchParams({
      daemon: REMOTE,
      addWorkspace: '1',
      workspaceReturn: original,
    });
    setLocation(`${PAGE}/?${params}`);
    const onClose = vi.fn();
    await mount(<AddHostedWorkspaceDialog onClose={onClose} />);
    await flush();

    expect(sdk.constructed.map((options) => options.baseUrl)).toEqual([REMOTE]);
    act(() => buttonNamed('Cancel').click());

    expect(assign).toHaveBeenCalledWith(original);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens an existing temporary folder only after persistence succeeds', async () => {
    setLocation(`${PAGE}/`);
    const workspace = {
      id: 'ws-1',
      cwd: '/repo/app',
      displayName: 'Old',
      persisted: false,
      primary: false,
    };
    sdk.client.capabilities.mockResolvedValue({
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        'workspace_display_name',
      ],
      workspaceCwd: '/repo/app',
      workspaces: [workspace],
    });
    sdk.client.addWorkspace
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce({ ...workspace, persisted: true });
    sdk.client.updateWorkspace.mockResolvedValue(undefined);
    const onClose = vi.fn();
    await mount(<AddHostedWorkspaceDialog onClose={onClose} />);
    act(() => buttonNamed('Next: choose folder').click());
    await flush();

    typeInto('#add-workspace-path', '/repo/app');
    typeInto('#add-workspace-display-name', 'Renamed');
    act(() => submitButton().click());
    await flush();

    expect(sdk.client.addWorkspace).toHaveBeenCalledWith('/repo/app', {
      persist: true,
    });
    expect(assign).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    act(() => submitButton().click());
    await flush();

    expect(sdk.client.addWorkspace).toHaveBeenCalledTimes(2);
    expect(sdk.client.updateWorkspace).toHaveBeenCalledWith('ws-1', {
      displayName: 'Renamed',
    });
    expect(assign).toHaveBeenCalledWith(`${PAGE}/?workspace=ws-1`);
  });

  it('renames an already registered folder instead of registering it again', async () => {
    setLocation(`${PAGE}/`);
    sdk.client.capabilities.mockResolvedValue({
      features: ['dynamic_workspace_registration', 'workspace_display_name'],
      workspaceCwd: '/repo/app',
      workspaces: [{ id: 'ws-1', cwd: '/repo/app', displayName: 'Old' }],
    });
    sdk.client.updateWorkspace.mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onAddCurrent = vi.fn();
    await mount(
      <AddHostedWorkspaceDialog
        onClose={onClose}
        onAddCurrent={onAddCurrent}
      />,
    );
    act(() => buttonNamed('Next: choose folder').click());
    await flush();

    typeInto('#add-workspace-path', '/repo/app/');
    typeInto('#add-workspace-display-name', 'Renamed');
    act(() => submitButton().click());
    await flush();

    expect(sdk.client.updateWorkspace).toHaveBeenCalledWith('ws-1', {
      displayName: 'Renamed',
    });
    expect(sdk.client.addWorkspace).not.toHaveBeenCalled();
    expect(onAddCurrent).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(`${PAGE}/?workspace=ws-1`);
    expect(onClose).not.toHaveBeenCalled();
  });
});
