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
  listRemoteComputers: config.connections,
  formatOriginHost: (origin: string) => new URL(origin).host,
}));

const { AddRemoteWorkspaceDialog } = await import('./AddRemoteWorkspaceDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onContinueHere: ReturnType<typeof vi.fn>;
let onConnectComputer: ReturnType<typeof vi.fn>;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onContinueHere = vi.fn();
  onConnectComputer = vi.fn();
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <AddRemoteWorkspaceDialog
          onClose={vi.fn()}
          onContinueHere={onContinueHere}
          onConnectComputer={onConnectComputer}
        />
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
  it('continues to the folder step in place for this computer', () => {
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
    // The page's own daemon needs no handover, so the shell is not reloaded.
    expect(onContinueHere).toHaveBeenCalledTimes(1);
    expect(config.start).not.toHaveBeenCalled();
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

    // The requirement comes with a way to satisfy it.
    const connect = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Connect a computer');
    act(() => connect!.click());
    expect(onConnectComputer).toHaveBeenCalledTimes(1);
  });
});
