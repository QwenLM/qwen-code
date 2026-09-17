// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

const config = vi.hoisted(() => ({
  start: vi.fn(),
  connections: vi.fn<() => string[]>(),
}));

vi.mock('../../config/remote-workspace-add', () => ({
  startRemoteWorkspaceAdd: config.start,
}));

vi.mock('../../config/remote-connections', () => ({
  readRemoteConnections: config.connections,
}));

const { AddRemoteWorkspaceDialog } = await import('./AddRemoteWorkspaceDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <AddRemoteWorkspaceDialog onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('AddRemoteWorkspaceDialog', () => {
  it('defaults Add Workspace to this computer', () => {
    config.start.mockReturnValue(true);
    config.connections.mockReturnValue(['https://remote.example:4170']);
    mount();

    expect(document.body.textContent).toContain('Workspace location');
    expect(
      document.querySelector<HTMLInputElement>('input[value="local"]')?.checked,
    ).toBe(true);

    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });
    expect(config.start).toHaveBeenCalledWith(
      window.location.origin,
      undefined,
    );
  });

  it('starts the folder flow on a previously connected computer', () => {
    config.start.mockReturnValue(true);
    config.connections.mockReturnValue(['https://remote.example:4170']);
    mount();

    act(() => {
      document
        .querySelector<HTMLInputElement>('input[value="remote"]')!
        .click();
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });

    expect(config.start).toHaveBeenCalledWith(
      'https://remote.example:4170',
      undefined,
    );
  });

  it('disables Remote until a connection has been configured', () => {
    config.connections.mockReturnValue([]);
    mount();

    expect(
      document.querySelector<HTMLInputElement>('input[value="remote"]')
        ?.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'Connect a computer in Daemon Status first.',
    );
  });
});
