// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

const config = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock('../../config/remote-workspace-add', () => ({
  startRemoteWorkspaceAdd: config.start,
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

function typeInto(id: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
  it('uses the original local or remote workspace location choice', () => {
    config.start.mockReturnValue(true);
    mount();

    expect(document.body.textContent).toContain('Workspace location');
    expect(
      document.querySelector<HTMLInputElement>('input[value="remote"]')
        ?.checked,
    ).toBe(true);

    act(() => {
      document.querySelector<HTMLInputElement>('input[value="local"]')!.click();
    });
    expect(document.querySelector('#remote-workspace-host-address')).toBeNull();

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

  it('starts the remote folder flow with the selected server credentials', () => {
    config.start.mockReturnValue(true);
    mount();

    typeInto('#remote-workspace-host-address', 'https://remote.example:4170');
    typeInto('#remote-workspace-host-token', 'secret');
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });

    expect(config.start).toHaveBeenCalledWith(
      'https://remote.example:4170',
      'secret',
    );
  });

  it('keeps the dialog open when the address is invalid', () => {
    mount();

    typeInto('#remote-workspace-host-address', 'remote.example:4170');
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });

    expect(config.start).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'HTTP or HTTPS',
    );
  });
});
