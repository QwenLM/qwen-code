// @vitest-environment jsdom
import { act, StrictMode, type ContextType } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  McpAppGeneratedUi,
  McpAppGeneratedUiInvalidation,
  McpAppGeneratedUiOwner,
  McpAppGeneratedUiOwnerSource,
  McpAppMessages,
} from '../mcpAppHostContext';
import {
  McpAppGeneratedUiContext,
  McpAppGeneratedUiOwnerContext,
  McpAppHostContext,
  McpAppMessagesContext,
  McpAppSessionContext,
  McpAppToolsContext,
  McpAppVisibilityContext,
} from '../mcpAppHostContext';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { McpApp, type McpAppDisplay } from '../components/messages/McpApp';
import {
  GeneratedUiRuntimeProvider,
  useGeneratedUiRetention,
} from './GeneratedUiRuntimeProvider';
import { instanceKey, resourceKey } from './instance-store';

interface BridgeMock {
  capabilities?: unknown;
  onsandboxready?: () => void;
  oninitialized?: () => void;
  onsizechange?: (size: { height: number }) => void;
  onmessage?: (
    params: { role: string; content: Array<{ type: 'text'; text: string }> },
    extra: { signal: AbortSignal },
  ) => Promise<unknown>;
  oncalltool?: (
    params: { name: string; arguments?: Record<string, unknown> },
    extra: { signal: AbortSignal },
  ) => Promise<unknown>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendSandboxResourceReady: ReturnType<typeof vi.fn>;
  sendToolInput: ReturnType<typeof vi.fn>;
  sendToolResult: ReturnType<typeof vi.fn>;
  teardownResource: ReturnType<typeof vi.fn>;
}

const bridges = vi.hoisted(() => ({ instances: [] as BridgeMock[] }));

vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  PostMessageTransport: class PostMessageTransport {},
  AppBridge: class AppBridge implements BridgeMock {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    sendSandboxResourceReady = vi.fn().mockResolvedValue(undefined);
    sendToolInput = vi.fn().mockResolvedValue(undefined);
    sendToolResult = vi.fn().mockResolvedValue(undefined);
    teardownResource = vi.fn().mockResolvedValue(undefined);
    setHostContext = vi.fn();
    capabilities: unknown;
    constructor(_app: unknown, _info: unknown, capabilities?: unknown) {
      this.capabilities = capabilities;
      bridges.instances.push(this);
    }
  },
}));

const moveBeforeDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'moveBefore',
);
const closeHarnesses: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  bridges.instances = [];
  // This shim verifies React lifecycle and host routing only. It cannot prove
  // that a browser preserves iframe realms or Workers during a native move.
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', {
    configurable: true,
    value(this: HTMLElement, node: Node, before: Node | null) {
      this.insertBefore(node, before);
    },
  });
});

afterEach(async () => {
  for (const close of closeHarnesses.splice(0)) await close();
  if (moveBeforeDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      'moveBefore',
      moveBeforeDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
  }
  vi.useRealTimers();
});

function appDisplay(overrides: Partial<McpAppDisplay> = {}): McpAppDisplay {
  return {
    type: 'mcp_app',
    requiredFeature: 'generated-ui',
    serverName: 'qwen-code-generated-ui',
    resourceUri: 'ui://qwen-code-generated-ui/view-v1.html',
    html: '<main>Generated simulation</main>',
    toolArguments: { workers: 8 },
    toolResult: { content: [{ type: 'text', text: 'Simulation ready' }] },
    fallbackText: 'Simulation summary',
    ...overrides,
  };
}

interface Card {
  surface: string;
  toolId: string;
  display?: McpAppDisplay;
  visible?: boolean;
  surfaceVisible?: boolean;
  portal?: boolean;
}

interface HarnessProps {
  cards?: Card[];
  source?: McpAppGeneratedUiOwnerSource | null;
  receipt?: McpAppGeneratedUi | null;
  messages?: McpAppMessages | null;
  tools?: ContextType<typeof McpAppToolsContext>;
  viewportKey?: string;
  surfaceVisible?: boolean;
  portalRoot?: HTMLElement | null;
}

function setup(strict = false) {
  let ownerIdentity = {};
  const source: McpAppGeneratedUiOwnerSource = {
    scopeId: 'daemon-a',
    sessionId: 'session-a',
    clientId: 'client-a',
    workspaceCwd: '/workspace/a',
    eventEpoch: 'epoch-a',
    captureOwner: () => {
      const captured = ownerIdentity;
      return { isCurrent: () => ownerIdentity === captured };
    },
  };
  const receipt: McpAppGeneratedUi = {
    sessionId: source.sessionId,
    status: { version: 1, enabled: true },
  };
  const listeners = new Set<(event: McpAppGeneratedUiInvalidation) => void>();
  const owner: McpAppGeneratedUiOwner = {
    scopeId: source.scopeId,
    workspaceCwd: source.workspaceCwd,
    source,
    captureSessionDeletion: () => () => undefined,
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
  const requestMessage = vi
    .fn<McpAppMessages['requestMessage']>()
    .mockResolvedValue({});
  const messages: McpAppMessages = {
    sessionId: source.sessionId,
    requestMessage,
  };
  const display = appDisplay();
  const defaultCards: Card[] = [{ surface: 'main', toolId: 'call-a', display }];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = false;
  let store: ReturnType<typeof useGeneratedUiRetention>;
  function StoreObserver() {
    store = useGeneratedUiRetention();
    return null;
  }
  const render = async (props: HarnessProps = {}) => {
    const tree = (
      <I18nProvider language="en">
        <McpAppHostContext.Provider value="http://127.0.0.1:4170">
          <McpAppSessionContext.Provider value={source.sessionId}>
            <McpAppGeneratedUiContext.Provider
              value={
                props.receipt === null ? undefined : (props.receipt ?? receipt)
              }
            >
              <McpAppGeneratedUiOwnerContext.Provider
                value={{
                  ...owner,
                  source:
                    props.source === null
                      ? undefined
                      : (props.source ?? source),
                }}
              >
                <McpAppToolsContext.Provider value={props.tools}>
                  <McpAppMessagesContext.Provider
                    value={
                      props.messages === null
                        ? undefined
                        : (props.messages ?? messages)
                    }
                  >
                    <GeneratedUiRuntimeProvider>
                      <StoreObserver />
                      <section key={props.viewportKey ?? 'viewport'}>
                        {(props.cards ?? defaultCards).map((card) => {
                          const content = (
                            <McpAppVisibilityContext.Provider
                              key={card.surface}
                              value={
                                card.surfaceVisible ??
                                props.surfaceVisible ??
                                true
                              }
                            >
                              <article data-surface={card.surface}>
                                <McpApp
                                  display={card.display ?? display}
                                  toolId={card.toolId}
                                  visible={card.visible ?? true}
                                />
                              </article>
                            </McpAppVisibilityContext.Provider>
                          );
                          return card.portal && props.portalRoot
                            ? createPortal(
                                content,
                                props.portalRoot,
                                card.surface,
                              )
                            : content;
                        })}
                      </section>
                    </GeneratedUiRuntimeProvider>
                  </McpAppMessagesContext.Provider>
                </McpAppToolsContext.Provider>
              </McpAppGeneratedUiOwnerContext.Provider>
            </McpAppGeneratedUiContext.Provider>
          </McpAppSessionContext.Provider>
        </McpAppHostContext.Provider>
      </I18nProvider>
    );
    const content = (
      <WebShellPortalRootContext.Provider value={props.portalRoot ?? null}>
        {tree}
      </WebShellPortalRootContext.Provider>
    );
    await act(async () =>
      root.render(strict ? <StrictMode>{content}</StrictMode> : content),
    );
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await act(async () => root.unmount());
    container.remove();
  };
  closeHarnesses.push(close);
  return {
    source,
    receipt,
    display,
    container,
    requestMessage,
    listeners,
    render,
    close,
    store: () => {
      if (!store) throw new Error('Provider has not rendered');
      return store;
    },
    recover: () => {
      ownerIdentity = {};
    },
    invalidate: async (reason: McpAppGeneratedUiInvalidation['reason']) => {
      await act(async () =>
        owner.invalidate({
          scopeId: source.scopeId,
          sessionId: source.sessionId,
          reason,
        }),
      );
    },
    surface: (name = 'main') =>
      container.querySelector<HTMLElement>(`[data-surface="${name}"]`)!,
    parking: () =>
      container.querySelector<HTMLElement>('[data-generated-ui-parking]')!,
  };
}

function activeBridges() {
  return bridges.instances.filter(
    (bridge) => bridge.close.mock.calls.length === 0,
  );
}

async function initialize(bridge: BridgeMock) {
  await act(async () => {
    bridge.onsandboxready?.();
    bridge.oninitialized?.();
  });
  expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
  expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
}

function message(bridge: BridgeMock) {
  expect(bridge.onmessage).toBeTypeOf('function');
  return bridge.onmessage!(
    {
      role: 'user',
      content: [{ type: 'text', text: 'Continue with 8 workers' }],
    },
    { signal: new AbortController().signal },
  );
}

function createShadowPortal() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const portalRoot = document.createElement('div');
  shadow.appendChild(portalRoot);
  closeHarnesses.push(async () => host.remove());
  return { shadow, portalRoot };
}

describe('GeneratedUiRuntimeProvider lifecycle', () => {
  it('hands a hidden surface to a visible surface for the same producer', async () => {
    const h = setup();
    const main = { surface: 'main', toolId: 'call-a' };
    const split = { surface: 'split', toolId: 'call-a' };
    await h.render({ cards: [main] });
    const bridge = activeBridges()[0];
    const frame = h.surface().querySelector('iframe');
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    const oldSignal = h.requestMessage.mock.calls[0][0].signal;

    await h.render({ cards: [{ ...main, surfaceVisible: false }, split] });

    expect(oldSignal.aborted).toBe(true);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(h.surface('split').querySelector('iframe')).toBe(frame);
    expect(activeBridges()).toEqual([bridge]);
    expect(await message(bridge)).toEqual({});
    await h.render({ cards: [main] });
    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(activeBridges()).toEqual([bridge]);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
  });

  it('attaches a live card once a refused first attach becomes current', async () => {
    const h = setup();
    let current = false;
    const source: McpAppGeneratedUiOwnerSource = {
      scopeId: 'daemon-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      workspaceCwd: '/workspace/a',
      eventEpoch: 'epoch-a',
      captureOwner: () => ({ isCurrent: () => current }),
    };
    // During a live turn the owner snapshot can be stale when the card first
    // renders; that refusal must not turn into a released card.
    await h.render({ source });
    expect(h.surface().querySelector('iframe')).toBeNull();
    current = true;
    await h.render({ source });
    expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
    expect(h.surface().textContent).not.toContain('Reopen interactive view');
  });

  it('initializes without native moves but releases a populated runtime on relocation', async () => {
    Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
    const h = setup(true);
    await h.render({ cards: [] });
    expect(bridges.instances).toHaveLength(0);

    await h.render();

    expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
    expect(activeBridges()).toHaveLength(1);
    const bridge = activeBridges()[0];
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    await h.render({ viewportKey: 'history-slice' });
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(h.surface().querySelector('button')?.textContent).toBe(
      'Reopen interactive view',
    );
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(activeBridges()).toEqual([]);
  });

  it('leaves one live bridge after StrictMode replay and tears down on close', async () => {
    const h = setup(true);
    await h.render();
    expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
    expect(activeBridges()).toHaveLength(1);
    const bridge = activeBridges()[0];
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(1);

    await h.close();

    expect(activeBridges()).toHaveLength(0);
    expect(bridge.teardownResource).toHaveBeenCalledExactlyOnceWith(
      {},
      { timeout: 500 },
    );
    for (const created of bridges.instances) {
      expect(created.close).toHaveBeenCalledTimes(1);
    }
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('parks before ancestor removal and restores the same runtime on remount', async () => {
    const h = setup();
    await h.render();
    const bridge = activeBridges()[0];
    const frame = h.surface().querySelector('iframe')!;
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});

    await h.render({ cards: [] });

    expect(h.parking().contains(frame)).toBe(true);
    expect(h.parking().hasAttribute('inert')).toBe(true);
    expect(h.parking().getAttribute('aria-hidden')).toBe('true');
    expect(bridge.close).not.toHaveBeenCalled();
    expect(await message(bridge)).toEqual({ isError: true });
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    await h.render({ viewportKey: 'history-slice' });

    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(activeBridges()).toEqual([bridge]);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
  });

  it('retains a populated shadow portal across parked rerenders and StrictMode remounts', async () => {
    const h = setup(true);
    const { shadow, portalRoot } = createShadowPortal();
    const card = { surface: 'shadow', toolId: 'call-a', portal: true };
    await h.render({ portalRoot, cards: [] });
    await h.render({ portalRoot, cards: [card] });
    const bridge = activeBridges()[0];
    const frame = portalRoot.querySelector('iframe')!;
    const entry = h.store().getEntries()[0];
    await initialize(bridge);
    expect(frame.getRootNode()).toBe(shadow);
    expect(entry.container.contains(frame)).toBe(true);
    expect(await message(bridge)).toEqual({});
    const previousSignal = h.requestMessage.mock.calls[0][0].signal;

    await h.render({ portalRoot, cards: [] });

    const parking = portalRoot.querySelector<HTMLElement>(
      '[data-generated-ui-parking]',
    )!;
    expect(parking.hidden).toBe(true);
    expect(parking.hasAttribute('inert')).toBe(true);
    expect(parking.getAttribute('aria-hidden')).toBe('true');
    expect(parking.contains(frame)).toBe(true);
    expect(entry.parkedAt).toBeDefined();
    expect(h.parking().contains(frame)).toBe(false);
    expect(previousSignal.aborted).toBe(true);
    expect(await message(bridge)).toEqual({ isError: true });
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    await h.render({ portalRoot, cards: [], viewportKey: 'history-slice' });
    expect(h.store().getEntries()).toEqual([entry]);
    expect(parking.contains(frame)).toBe(true);
    expect(bridge.close).not.toHaveBeenCalled();

    await h.render({ portalRoot, cards: [card], viewportKey: 'returned' });

    expect(portalRoot.querySelector('[data-surface="shadow"] iframe')).toBe(
      frame,
    );
    expect(h.store().getEntries()).toEqual([entry]);
    expect(entry.parkedAt).toBeUndefined();
    expect(activeBridges()).toEqual([bridge]);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage.mock.calls[1][0].signal.aborted).toBe(false);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
  });

  it('removes only the parked shadow runtime when its portal parking host disappears', async () => {
    const h = setup();
    const { portalRoot } = createShadowPortal();
    const main = { surface: 'main', toolId: 'main' };
    const shadow = { surface: 'shadow', toolId: 'shadow', portal: true };
    await h.render({ portalRoot, cards: [main, shadow] });
    const [mainBridge, shadowBridge] = activeBridges();
    await initialize(mainBridge);
    await initialize(shadowBridge);
    const mainFrame = h.surface().querySelector('iframe');
    const shadowFrame = portalRoot.querySelector('iframe')!;
    const [mainEntry, shadowEntry] = h.store().getEntries();
    await h.render({ portalRoot, cards: [] });

    await h.render({ portalRoot: null, cards: [] });

    expect(h.store().getRecord(shadowEntry.key)?.reason).toBe(
      'parking-removed',
    );
    expect(shadowFrame.isConnected).toBe(false);
    expect(shadowBridge.close).toHaveBeenCalledTimes(1);
    expect(h.store().getEntries()).toEqual([mainEntry]);
    expect(h.parking().contains(mainFrame)).toBe(true);
    expect(mainBridge.close).not.toHaveBeenCalled();
    expect(portalRoot.querySelector('[data-generated-ui-parking]')).toBeNull();
    await h.render({ portalRoot, cards: [main, shadow] });
    expect(h.surface().querySelector('iframe')).toBe(mainFrame);
    expect(
      portalRoot.querySelector('[data-surface="shadow"] iframe'),
    ).toBeNull();
    expect(
      portalRoot.querySelector('[data-surface="shadow"] button'),
    ).not.toBeNull();
    expect(activeBridges()).toEqual([mainBridge]);
  });

  it('keeps an active key in one surface and allows reopening after its owner leaves', async () => {
    const h = setup();
    const main = { surface: 'main', toolId: 'call-a' };
    const duplicate = { surface: 'duplicate', toolId: 'call-a' };
    await h.render({ cards: [main, duplicate] });
    const bridge = activeBridges()[0];
    await initialize(bridge);
    const parkedFrame = h.surface().querySelector('iframe');
    expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
    expect(h.surface('duplicate').querySelector('iframe')).toBeNull();
    expect(h.surface('duplicate').querySelector('button')).toBeNull();
    expect(activeBridges()).toHaveLength(1);

    await h.render({ cards: [duplicate] });
    const reopen = h
      .surface('duplicate')
      .querySelector<HTMLButtonElement>('button');
    expect(reopen).not.toBeNull();
    await act(async () => reopen!.click());

    expect(h.surface('duplicate').querySelectorAll('iframe')).toHaveLength(1);
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(h.surface('duplicate').querySelector('iframe')).not.toBe(
      parkedFrame,
    );
    expect(h.surface('duplicate').textContent).toContain(
      'Reopening starts from the original content',
    );
    expect(activeBridges()).toHaveLength(1);
    expect(await message(activeBridges()[0])).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps separate tool keys and requires explicit reopen after a resource change', async () => {
    const h = setup();
    await h.render();
    const firstBridge = activeBridges()[0];
    const firstFrame = h.surface().querySelector('iframe');
    await initialize(firstBridge);
    await h.render({ cards: [{ surface: 'main', toolId: 'call-b' }] });
    const secondFrame = h.surface().querySelector('iframe');
    expect(secondFrame).not.toBe(firstFrame);
    expect(h.parking().contains(firstFrame)).toBe(true);
    expect(activeBridges()).toHaveLength(2);
    await h.render();
    expect(h.surface().querySelector('iframe')).toBe(firstFrame);
    expect(h.parking().contains(secondFrame)).toBe(true);

    const changed = appDisplay({ html: '<main>New simulation</main>' });
    await h.render({
      cards: [{ surface: 'main', toolId: 'call-a', display: changed }],
    });
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(firstBridge.close).toHaveBeenCalledTimes(1);
    const reopen = h.surface().querySelector<HTMLButtonElement>('button')!;
    await act(async () => reopen.click());
    const replacement = activeBridges().at(-1)!;
    await initialize(replacement);
    expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
    expect(h.surface().querySelector('iframe')).not.toBe(firstFrame);
    expect(replacement.sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.objectContaining({ html: changed.html }),
    );
  });

  it('wires owner invalidation to disposal without automatically reopening', async () => {
    const h = setup();
    await h.render();
    const bridge = activeBridges()[0];
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    const signal = h.requestMessage.mock.calls[0][0].signal;

    await h.invalidate('policy');

    expect(signal.aborted).toBe(true);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(bridge.onmessage).toBeUndefined();
    await h.render();
    expect(activeBridges()).toHaveLength(0);
    expect(h.surface().querySelector('button')).not.toBeNull();
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['html', 'csp', 'permissions', 'arguments', 'result', 'epoch'])(
    'invalidates a memoized resource when %s changes',
    async (change) => {
      const h = setup();
      await h.render();
      const bridge = activeBridges()[0];
      const frame = h.surface().querySelector('iframe');
      await initialize(bridge);
      const updates: Record<string, Partial<McpAppDisplay>> = {
        html: { html: '<main>Changed</main>' },
        csp: { csp: { connectDomains: ['https://example.test'] } },
        permissions: {
          permissions: { clipboardWrite: {} } as McpAppDisplay['permissions'],
        },
        arguments: { toolArguments: { workers: 9 } },
        result: {
          toolResult: { content: [{ type: 'text', text: 'Changed' }] },
        },
      };
      await h.render({
        source:
          change === 'epoch'
            ? { ...h.source, eventEpoch: 'epoch-b' }
            : h.source,
        cards: [
          {
            surface: 'main',
            toolId: 'call-a',
            display:
              change === 'epoch' ? h.display : appDisplay(updates[change]),
          },
        ],
      });
      expect(bridge.close).toHaveBeenCalledTimes(1);
      expect(frame!.isConnected).toBe(false);
      expect(h.surface().querySelector('iframe')).toBeNull();
      expect(h.surface().querySelector('button')?.textContent).toBe(
        'Reopen interactive view',
      );
    },
  );

  it('cleans both an attached and a parked runtime when the provider closes', async () => {
    const h = setup();
    await h.render({
      cards: [
        { surface: 'main', toolId: 'call-a' },
        { surface: 'second', toolId: 'call-b' },
      ],
    });
    const initial = [...activeBridges()];
    expect(initial).toHaveLength(2);
    for (const bridge of initial) await initialize(bridge);
    await h.render();
    expect(h.parking().querySelectorAll('iframe')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    await h.close();

    for (const bridge of initial) {
      expect(bridge.teardownResource).toHaveBeenCalledTimes(1);
      expect(bridge.close).toHaveBeenCalledTimes(1);
      expect(bridge.onmessage).toBeUndefined();
    }
    expect(activeBridges()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('GeneratedUiRuntimeProvider eligibility and authority', () => {
  it('keeps an ordinary MCP App outside retention and closes it on removal', async () => {
    const h = setup();
    await h.render({
      cards: [
        {
          surface: 'main',
          toolId: 'foreign-call',
          display: appDisplay({
            requiredFeature: undefined,
            serverName: 'foreign-server',
            resourceUri: 'ui://foreign/view.html',
          }),
        },
      ],
    });
    const bridge = activeBridges()[0];
    await initialize(bridge);
    expect(h.surface().querySelector('iframe')).not.toBeNull();
    expect(h.surface().querySelector('[data-generated-ui-slot]')).toBeNull();
    expect(h.store().getEntries()).toEqual([]);
    await h.render({ cards: [] });
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(h.parking().querySelector('iframe')).toBeNull();
    expect(activeBridges()).toEqual([]);
  });

  it('ignores size changes while parked and keeps the previous height on return', async () => {
    const h = setup();
    await h.render();
    const bridge = activeBridges()[0];
    const frame = h.surface().querySelector('iframe')!;
    await initialize(bridge);
    await act(async () => bridge.onsizechange!({ height: 400 }));
    expect(frame.style.height).toBe('400px');
    await h.render({ cards: [] });
    for (const height of [0, 500]) {
      await act(async () => bridge.onsizechange!({ height }));
      expect(frame.style.height).toBe('400px');
    }
    await h.render();
    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(frame.style.height).toBe('400px');
  });

  it.each(['missing', 'foreign'] as const)(
    'does not advertise message or tool capabilities for a %s host',
    async (hostKind) => {
      const h = setup();
      const requestMessage = vi.fn().mockResolvedValue({});
      const callTool = vi.fn().mockResolvedValue({ content: [] });
      await h.render({
        messages:
          hostKind === 'missing'
            ? null
            : { sessionId: 'other', requestMessage },
        tools:
          hostKind === 'missing' ? undefined : { sessionId: 'other', callTool },
      });
      expect(activeBridges()).toHaveLength(1);
      const bridge = activeBridges()[0];
      await initialize(bridge);

      expect(bridge.capabilities).not.toHaveProperty('message');
      expect(bridge.capabilities).not.toHaveProperty('serverTools');
      expect(bridge.onmessage).toBeUndefined();
      expect(bridge.oncalltool).toBeUndefined();
      expect(requestMessage).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it('advertises and routes matching host capabilities', async () => {
    const h = setup();
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'Calculated' }] });
    await h.render({ tools: { sessionId: h.source.sessionId, callTool } });
    const bridge = activeBridges()[0];
    await initialize(bridge);

    expect(bridge.capabilities).toMatchObject({
      message: { text: {} },
      serverTools: {},
    });
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    expect(bridge.oncalltool).toBeTypeOf('function');
    expect(
      await bridge.oncalltool!(
        { name: 'calculate', arguments: { workers: 8 } },
        { signal: new AbortController().signal },
      ),
    ).toEqual({ content: [{ type: 'text', text: 'Calculated' }] });
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      {
        serverName: h.display.serverName,
        resourceUri: h.display.resourceUri,
        name: 'calculate',
        arguments: { workers: 8 },
      },
      expect.any(AbortSignal),
    );
  });

  it.each(['message', 'serverTools'] as const)(
    'requires explicit reopening when a visible %s capability changes',
    async (capability) => {
      const h = setup();
      const tools = {
        sessionId: h.source.sessionId,
        callTool: vi.fn().mockResolvedValue({ content: [] }),
      };
      await h.render({ tools });
      const first = activeBridges()[0];
      await initialize(first);
      expect(first.capabilities).toHaveProperty(capability);
      expect(await message(first)).toEqual({});
      const signal = h.requestMessage.mock.calls[0][0].signal;

      await h.render({
        tools: capability === 'serverTools' ? undefined : tools,
        messages: capability === 'message' ? null : undefined,
      });

      expect(signal.aborted).toBe(true);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(h.surface().querySelector('iframe')).toBeNull();
      expect(activeBridges()).toHaveLength(0);
      await act(async () =>
        h.surface().querySelector<HTMLButtonElement>('button')!.click(),
      );
      const limited = activeBridges()[0];
      await initialize(limited);
      expect(limited.capabilities).not.toHaveProperty(capability);
      expect(
        capability === 'message' ? limited.onmessage : limited.oncalltool,
      ).toBeUndefined();

      await h.render({ tools });
      expect(limited.close).toHaveBeenCalledTimes(1);
      expect(h.surface().querySelector('iframe')).toBeNull();
      expect(activeBridges()).toHaveLength(0);
      await act(async () =>
        h.surface().querySelector<HTMLButtonElement>('button')!.click(),
      );
      const restored = activeBridges()[0];
      await initialize(restored);
      expect(restored.capabilities).toHaveProperty(capability);
      expect(await message(restored)).toEqual({});
      expect(h.requestMessage).toHaveBeenCalledTimes(2);
    },
  );

  it('parks a mounted card during an owner-session mismatch and restores it on return', async () => {
    const h = setup();
    await h.render();
    const bridge = activeBridges()[0];
    const frame = h.surface().querySelector('iframe');
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    await h.render({
      source: { ...h.source, sessionId: 'session-b', clientId: 'client-b' },
      messages: null,
    });

    expect(h.parking().contains(frame)).toBe(true);
    expect(bridge.close).not.toHaveBeenCalled();
    expect(await message(bridge)).toEqual({ isError: true });
    expect(activeBridges()).toHaveLength(2);
    const ordinary = activeBridges().find((other) => other !== bridge)!;
    expect(h.surface().querySelector('[data-generated-ui-slot]')).toBeNull();
    expect(h.surface().querySelector('iframe')).not.toBeNull();
    await h.render();
    expect(ordinary.close).toHaveBeenCalledTimes(1);
    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(activeBridges()).toEqual([bridge]);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
  });

  it('requires a fresh explicit open for saturated fallback visibility, resource, epoch and mount changes', async () => {
    const h = setup();
    await h.render({ cards: [] });
    const store = h.store();
    const filler = document.createElement('div');
    h.container.appendChild(filler);
    await act(async () => {
      for (let index = 0; index < 128; index++) {
        const key = instanceKey(h.source, `released-${index}`, h.display);
        expect(
          store.attach({
            key,
            resourceKey: resourceKey(h.display, h.source.eventEpoch),
            display: h.display,
            source: h.source,
            receipt: h.receipt,
            baseUrl: 'http://127.0.0.1:4170',
            element: filler,
            token: {},
            visible: true,
            reset: () => {},
          }),
        ).toBeDefined();
        store.dispose(key, 'evicted');
      }
    });
    filler.remove();
    expect(bridges.instances).toHaveLength(0);

    await h.render();
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(activeBridges()).toHaveLength(0);
    const openFallback = async () => {
      const button = h.surface().querySelector<HTMLButtonElement>('button');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(h.surface().querySelectorAll('iframe')).toHaveLength(1);
      expect(h.surface().querySelector('button')).toBeNull();
      expect(activeBridges()).toHaveLength(1);
      const bridge = activeBridges()[0];
      await initialize(bridge);
      expect(await message(bridge)).toEqual({});
      expect(store.getEntries()).toEqual([]);
      return bridge;
    };
    const first = await openFallback();
    expect(
      store.getRecord(instanceKey(h.source, 'call-a', h.display)),
    ).toBeUndefined();

    const beforeFold = h.requestMessage.mock.calls[0][0].signal;
    const beforeFoldMessage = first.onmessage!;
    await h.render({
      cards: [{ surface: 'main', toolId: 'call-a', visible: false }],
    });
    expect(beforeFold.aborted).toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(first.onmessage).toBeUndefined();
    expect(
      await beforeFoldMessage(
        { role: 'user', content: [{ type: 'text', text: 'Stale message' }] },
        { signal: new AbortController().signal },
      ),
    ).toEqual({ isError: true });
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    await h.render();
    expect(h.surface().querySelector('iframe')).toBeNull();
    const afterFold = await openFallback();

    const cards = [
      {
        surface: 'main',
        toolId: 'call-a',
        display: appDisplay({ html: '<main>Changed resource</main>' }),
      },
    ];
    await h.render({ cards });
    expect(afterFold.close).toHaveBeenCalledTimes(1);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(activeBridges()).toHaveLength(0);
    await h.render();
    expect(h.surface().querySelector('iframe')).toBeNull();
    await h.render({ cards });
    const second = await openFallback();

    const source = { ...h.source, eventEpoch: 'epoch-b' };
    await h.render({ cards, source });
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(activeBridges()).toHaveLength(0);
    await h.render({ cards });
    expect(h.surface().querySelector('iframe')).toBeNull();
    await h.render({ cards, source });
    const third = await openFallback();

    await h.render({ cards: [], source });
    expect(third.close).toHaveBeenCalledTimes(1);
    expect(h.parking().querySelector('iframe')).toBeNull();
    await h.render({ cards, source });
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(activeBridges()).toHaveLength(0);
    await openFallback();
    expect(h.requestMessage).toHaveBeenCalledTimes(5);
  });

  it('keeps a pending review during an equivalent owner and receipt rerender', async () => {
    const h = setup();
    let resolveRequest!: (result: { isError?: boolean }) => void;
    h.requestMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    await h.render();
    const bridge = activeBridges()[0];
    await initialize(bridge);
    const pending = message(bridge);
    const signal = h.requestMessage.mock.calls[0][0].signal;

    await h.render({
      source: { ...h.source },
      receipt: { ...h.receipt, status: { ...h.receipt.status } },
    });

    expect(signal.aborted).toBe(false);
    expect(activeBridges()).toEqual([bridge]);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    resolveRequest({});
    expect(await pending).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
  });

  it('uses the ordinary McpApp lifecycle when the producer epoch is unavailable', async () => {
    const h = setup();
    const unknown = { ...h.source, eventEpoch: undefined };
    await h.render({ source: unknown });
    const bridge = activeBridges()[0];
    await initialize(bridge);
    expect(h.surface().querySelector('iframe')).not.toBeNull();
    expect(h.surface().querySelector('[data-generated-ui-slot]')).toBeNull();
    expect(await message(bridge)).toEqual({});

    await h.render({ source: unknown, cards: [] });

    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(h.parking().querySelector('iframe')).toBeNull();
    await h.render({ source: unknown });
    expect(activeBridges()).toHaveLength(1);
    expect(activeBridges()[0]).not.toBe(bridge);
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
  });

  it('revokes on a missing receipt and uses a fresh lease when the receipt returns', async () => {
    const h = setup();
    await h.render();
    const bridge = activeBridges()[0];
    const frame = h.surface().querySelector('iframe');
    await initialize(bridge);
    expect(await message(bridge)).toEqual({});
    const before = h.requestMessage.mock.calls[0][0].signal;

    await h.render({ receipt: null });

    expect(before.aborted).toBe(true);
    expect(h.surface().querySelector('iframe')).toBeNull();
    expect(await message(bridge)).toEqual({ isError: true });
    expect(h.requestMessage).toHaveBeenCalledTimes(1);
    await h.render({
      receipt: { ...h.receipt, status: { ...h.receipt.status } },
    });
    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
    expect(h.requestMessage.mock.calls[1][0].signal.aborted).toBe(false);
    expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
  });

  it('revokes a missing source and removes the temporary ordinary runtime on return', async () => {
    const h = setup();
    await h.render();
    const retained = activeBridges()[0];
    const frame = h.surface().querySelector('iframe');
    await initialize(retained);
    expect(await message(retained)).toEqual({});
    const oldSignal = h.requestMessage.mock.calls[0][0].signal;

    await h.render({ source: null });

    expect(oldSignal.aborted).toBe(true);
    expect(h.parking().contains(frame)).toBe(true);
    expect(await message(retained)).toEqual({ isError: true });
    const ordinary = activeBridges().find((bridge) => bridge !== retained)!;
    expect(ordinary).toBeDefined();
    await h.render();
    expect(ordinary.close).toHaveBeenCalledTimes(1);
    expect(h.surface().querySelector('iframe')).toBe(frame);
    expect(activeBridges()).toEqual([retained]);
    expect(await message(retained)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
  });

  it('updates recovered owners without keeping stale in-flight authority', async () => {
    const h = setup();
    let resolveRequest!: (result: { isError?: boolean }) => void;
    h.requestMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    await h.render();
    const bridge = activeBridges()[0];
    await initialize(bridge);
    const old = message(bridge);
    const oldSignal = h.requestMessage.mock.calls[0][0].signal;

    h.recover();
    await h.render({ source: { ...h.source } });

    expect(oldSignal.aborted).toBe(true);
    resolveRequest({});
    expect(await old).toEqual({ isError: true });
    expect(await message(bridge)).toEqual({});
    expect(h.requestMessage).toHaveBeenCalledTimes(2);
    expect(activeBridges()).toEqual([bridge]);
    expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
  });

  it.each(['folded', 'hidden-surface'])(
    'revokes %s cards without remounting their runtime',
    async (visibility) => {
      const h = setup();
      await h.render();
      const bridge = activeBridges()[0];
      const frame = h.surface().querySelector('iframe');
      await initialize(bridge);
      expect(await message(bridge)).toEqual({});
      const oldSignal = h.requestMessage.mock.calls[0][0].signal;

      await h.render({
        cards: [
          {
            surface: 'main',
            toolId: 'call-a',
            visible: visibility !== 'folded',
          },
        ],
        surfaceVisible: visibility !== 'hidden-surface',
      });

      expect(oldSignal.aborted).toBe(true);
      expect(await message(bridge)).toEqual({ isError: true });
      expect(h.requestMessage).toHaveBeenCalledTimes(1);
      expect(
        (visibility === 'folded' ? h.surface() : h.parking()).querySelector(
          'iframe',
        ),
      ).toBe(frame);
      await h.render();
      expect(await message(bridge)).toEqual({});
      expect(h.requestMessage).toHaveBeenCalledTimes(2);
      expect(activeBridges()).toEqual([bridge]);
      expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
    },
  );
});
