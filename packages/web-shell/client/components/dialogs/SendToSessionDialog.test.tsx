// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import type { SessionCatalogQuery } from '../../session-catalog/session-catalog-store';
import { SendToSessionDialog } from './SendToSessionDialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select opens on pointer events jsdom does not fully implement.
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

const catalog = vi.hoisted(() => ({
  sessions: new Map<string, DaemonSessionSummary[]>(),
  queries: [] as SessionCatalogQuery[],
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogQuery: (_client: unknown, query: SessionCatalogQuery) => {
    catalog.queries.push(query);
    return { sessions: catalog.sessions.get(query.workspaceCwd) ?? [] };
  },
}));

const WS_A = '/work/a';
const WS_B = '/work/b';
const workspaces = [
  { id: 'a', cwd: WS_A, trusted: true },
  { id: 'b', cwd: WS_B, displayName: 'Backend', trusted: true },
] as DaemonWorkspaceCapability[];

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
  catalog.sessions.clear();
  catalog.queries.length = 0;
});

function mount(onSend: (request: unknown) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider language="en">
        <SendToSessionDialog
          client={{} as DaemonClient}
          callerSessionId="caller"
          currentWorkspaceCwd={WS_A}
          workspaces={workspaces}
          onSend={onSend}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function choose(container: HTMLElement, testId: string, text: string) {
  await act(async () =>
    click(container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!),
  );
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((el) => el.textContent?.includes(text));
  if (!option) throw new Error(`no option "${text}"`);
  await act(async () => click(option));
}

function type(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="send-to-session-message"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function sendButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="send-to-session-send"]',
  )!;
}

describe('SendToSessionDialog', () => {
  it('sends a new session in the current workspace by default', async () => {
    const onSend = vi.fn(async () => undefined);
    const container = mount(onSend);
    expect(sendButton(container).disabled).toBe(true);
    type(container, '  check the build  ');
    await act(async () => sendButton(container).click());
    expect(onSend).toHaveBeenCalledWith({
      workspaceCwd: WS_A,
      prompt: 'check the build',
    });
  });

  it('lists every other active session in the chosen workspace', async () => {
    catalog.sessions.set(WS_B, [
      { sessionId: 'kid-1', workspaceCwd: WS_B, displayName: 'Docs pass' },
      {
        sessionId: 'side-1',
        workspaceCwd: WS_B,
        displayName: 'A side task',
        sourceType: 'web-shell-side-task',
      },
      { sessionId: 'caller', workspaceCwd: WS_B, displayName: 'Myself' },
    ] as DaemonSessionSummary[]);
    const onSend = vi.fn(async () => undefined);
    const container = mount(onSend);
    await choose(container, 'send-to-session-workspace', 'Backend');
    expect(catalog.queries.at(-1)).toMatchObject({
      routeKind: 'qualified',
      workspaceCwd: WS_B,
      options: { archiveState: 'active' },
    });
    await act(async () =>
      click(
        container.querySelector<HTMLElement>(
          '[data-testid="send-to-session-target"]',
        )!,
      ),
    );
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((el) => el.textContent);
    expect(options).toEqual(['New session', 'Docs pass', 'A side task']);
    await act(async () =>
      click(
        Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"]'),
        ).find((el) => el.textContent === 'Docs pass')!,
      ),
    );
    type(container, 'again');
    await act(async () => sendButton(container).click());
    expect(onSend).toHaveBeenCalledWith({
      workspaceCwd: WS_B,
      targetSessionId: 'kid-1',
      prompt: 'again',
    });
  });

  it('shows the refusal and keeps the message', async () => {
    const onSend = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 409'), {
        body: { error: 'Workspace /work/b is not trusted.' },
      });
    });
    const container = mount(onSend);
    type(container, 'hello');
    await act(async () => sendButton(container).click());
    expect(container.textContent).toContain(
      'Workspace /work/b is not trusted.',
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="send-to-session-message"]',
      )!.value,
    ).toBe('hello');
    expect(sendButton(container).disabled).toBe(false);
  });
});
