// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ChatContextHeader } from './ChatContextHeader';

// The QR entry reads the workspace connection from context.
vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
    }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function mount(
  props: Partial<Parameters<typeof ChatContextHeader>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ChatContextHeader
          content="Session title"
          environmentOpen={false}
          environmentAvailable
          rightPanelOpen={false}
          rightPanelAvailable={false}
          onToggleEnvironment={vi.fn()}
          onToggleRightPanel={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('ChatContextHeader', () => {
  it('renders custom content inside the persistent action shell', () => {
    const view = mount({ content: <span>Custom header</span> });

    expect(view.textContent).toContain('Custom header');
    expect(view.querySelectorAll('button')).toHaveLength(1);
  });

  it('hides the right-panel action until content exists', () => {
    const view = mount();

    expect(
      view.querySelector('button[aria-label="Toggle right panel"]'),
    ).toBeNull();
  });

  it('hides the environment action until content exists', () => {
    const view = mount({ environmentAvailable: false });

    expect(
      view.querySelector('button[aria-label="Toggle environment information"]'),
    ).toBeNull();
  });

  it('toggles each available panel independently', () => {
    const onToggleEnvironment = vi.fn();
    const onToggleRightPanel = vi.fn();
    const view = mount({
      rightPanelAvailable: true,
      onToggleEnvironment,
      onToggleRightPanel,
    });

    act(() => {
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });

    expect(onToggleEnvironment).toHaveBeenCalledOnce();
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });

  it('keeps the right-panel action to the right of the environment action', () => {
    const view = mount({ rightPanelAvailable: true });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });

  it('opens the token usage panel from the trailing header action', () => {
    const onOpenTokenUsage = vi.fn();
    const view = mount({ rightPanelAvailable: true, onOpenTokenUsage });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Session token usage',
      'Toggle right panel',
    ]);
    act(() => actions[1]!.click());
    expect(onOpenTokenUsage).toHaveBeenCalledOnce();
  });

  it('hides the token usage action when no session is available', () => {
    const view = mount();
    expect(
      view.querySelector('button[aria-label="Session token usage"]'),
    ).toBeNull();
  });

  it('shows the Local Control QR entry ahead of the other actions', () => {
    const view = mount({
      rightPanelAvailable: true,
      onOpenLocalControlSettings: vi.fn(),
    });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Mobile access',
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });
});
