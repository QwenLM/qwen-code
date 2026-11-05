// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAppDisplay } from '../components/messages/McpApp';
import type { McpAppGeneratedUiOwnerSource } from '../mcpAppHostContext';
import {
  GeneratedUiInstanceStore,
  instanceKey,
  MAX_INSTANCE_RECORDS,
  MAX_PARKED_INSTANCES,
  PARKED_INSTANCE_TTL,
  resourceKey,
  type InstanceSlot,
} from './instance-store';

const moveBeforeDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'moveBefore',
);
const stores: GeneratedUiInstanceStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  // This stub only tests the store's DOM operations. jsdom cannot establish
  // that a browser move preserves an iframe realm or Worker.
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', {
    configurable: true,
    value(this: HTMLElement, node: Node, before: Node | null) {
      this.insertBefore(node, before);
    },
  });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.clear();
  document.body.replaceChildren();
  if (moveBeforeDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      'moveBefore',
      moveBeforeDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function display(overrides: Partial<McpAppDisplay> = {}): McpAppDisplay {
  return {
    type: 'mcp_app',
    requiredFeature: 'generated-ui',
    serverName: 'qwen-code-generated-ui',
    resourceUri: 'ui://qwen-code-generated-ui/view-v1.html',
    html: '<main>Simulation</main>',
    toolResult: { content: [{ type: 'text', text: 'Ready' }] },
    toolArguments: { workers: 8 },
    fallbackText: 'Simulation',
    ...overrides,
  };
}

function source(overrides: Partial<McpAppGeneratedUiOwnerSource> = {}) {
  let owner = {};
  const value: McpAppGeneratedUiOwnerSource = {
    scopeId: 'daemon-a',
    sessionId: 'session-a',
    clientId: 'client-a',
    workspaceCwd: '/workspace/a',
    eventEpoch: 'epoch-a',
    captureOwner: () => {
      const captured = owner;
      return { isCurrent: () => captured === owner };
    },
    ...overrides,
  };
  return {
    value,
    recover: () => {
      owner = {};
    },
  };
}

function slot(toolId = 'call-a', owner = source().value, app = display()) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const callTool = vi
    .fn<NonNullable<InstanceSlot['tools']>['callTool']>()
    .mockResolvedValue({ content: [{ type: 'text', text: 'Calculated' }] });
  const requestMessage = vi
    .fn<NonNullable<InstanceSlot['messages']>['requestMessage']>()
    .mockResolvedValue({});
  const reset = vi.fn();
  const value: InstanceSlot = {
    key: instanceKey(owner, toolId, app),
    resourceKey: resourceKey(app, owner.eventEpoch),
    display: app,
    source: owner,
    receipt: {
      sessionId: owner.sessionId,
      status: { version: 1, enabled: true },
    },
    tools: { sessionId: owner.sessionId, callTool },
    messages: { sessionId: owner.sessionId, requestMessage },
    baseUrl: 'http://127.0.0.1:4170',
    token: {},
    element,
    visible: true,
    reset,
  };
  return { value, callTool, requestMessage, reset };
}

function setup() {
  const store = new GeneratedUiInstanceStore();
  const parking = document.createElement('div');
  parking.hidden = true;
  parking.setAttribute('inert', '');
  document.body.appendChild(parking);
  store.parking = parking;
  stores.push(store);
  return { store, parking };
}

function shadowParking(store: GeneratedUiInstanceStore) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const parking = document.createElement('div');
  root.appendChild(parking);
  return { root, parking, unregister: store.registerParking(parking) };
}

function toolRequest() {
  return {
    serverName: 'qwen-code-generated-ui',
    resourceUri: 'ui://qwen-code-generated-ui/view-v1.html',
    name: 'calculate',
    arguments: { workers: 8 },
  };
}

function messageRequest() {
  return {
    serverName: 'qwen-code-generated-ui',
    resourceUri: 'ui://qwen-code-generated-ui/view-v1.html',
    text: 'Continue with 8 workers',
    signal: new AbortController().signal,
  };
}

describe('Generated UI instance identity', () => {
  it('keeps identical documents from different tool calls independent', () => {
    const { store } = setup();
    const owner = source().value;
    const app = display();
    const first = slot('call-a', owner, app);
    const second = slot('call-b', owner, app);
    const firstEntry = store.attach(first.value)!;
    const secondEntry = store.attach(second.value)!;

    expect(first.value.resourceKey).toBe(second.value.resourceKey);
    expect(first.value.key).not.toBe(second.value.key);
    expect(firstEntry.id).not.toBe(secondEntry.id);
    expect(firstEntry.container).not.toBe(secondEntry.container);
    const input = document.createElement('input');
    input.value = 'Unapplied draft';
    firstEntry.container.appendChild(input);
    expect(secondEntry.container.querySelector('input')).toBeNull();
    expect(store.getEntries()).toHaveLength(2);
  });

  it.each([
    { sessionId: 'session-b' },
    { workspaceCwd: '/workspace/b' },
    { scopeId: 'daemon-b' },
  ])('separates the same tool ID by owner scope %j', (difference) => {
    const original = source().value;
    const other = source(difference).value;
    expect(instanceKey(original, 'call-a', display())).not.toBe(
      instanceKey(other, 'call-a', display()),
    );
  });

  it('compares nested resource objects by value instead of insertion order', () => {
    const first = display({
      toolArguments: { workers: 8, limits: { low: 1, high: 20 } },
    });
    const same = display({
      toolArguments: { limits: { high: 20, low: 1 }, workers: 8 },
    });
    expect(resourceKey(first, 'epoch-a')).toBe(resourceKey(same, 'epoch-a'));
    expect(resourceKey(first, 'epoch-a')).not.toBe(
      resourceKey(first, 'epoch-b'),
    );
  });

  it.each(['html', 'epoch'] as const)(
    'requires explicit reopening when %s changes under the same logical key',
    (change) => {
      const { store } = setup();
      const first = slot();
      const entry = store.attach(first.value)!;
      const oldSignal = entry.runtime.getSignal();
      store.release(first.value.key, first.value.token);
      const next = slot(
        'call-a',
        source({ eventEpoch: change === 'epoch' ? 'epoch-b' : 'epoch-a' })
          .value,
        display(change === 'html' ? { html: '<main>Changed</main>' } : {}),
      );

      expect(next.value.key).toBe(first.value.key);
      expect(store.attach(next.value)).toBeUndefined();
      expect(oldSignal.aborted).toBe(true);
      expect(entry.container.isConnected).toBe(false);
      const replacement = store.attach(next.value, true)!;
      expect(replacement.id).not.toBe(entry.id);
      expect(replacement.container.parentElement).toBe(next.value.element);
    },
  );
});

describe('Generated UI active leases', () => {
  it('preserves an in-flight request across same-slot rerenders', async () => {
    const { store } = setup();
    const first = slot();
    const pending = deferred<{ isError?: boolean }>();
    first.requestMessage.mockReturnValueOnce(pending.promise);
    const entry = store.attach(first.value)!;
    const signal = entry.runtime.getSignal();
    const request = entry.messages.requestMessage(messageRequest());
    const freshHost = slot('call-a', first.value.source);
    const rerender = {
      ...freshHost.value,
      token: first.value.token,
      element: first.value.element,
    };

    store.update(rerender);
    expect(store.attach(rerender)).toBe(entry);
    expect(entry.runtime.getSignal()).toBe(signal);
    expect(first.requestMessage.mock.calls[0][0].signal.aborted).toBe(false);
    pending.resolve({});
    expect(await request).toEqual({});
    expect(first.requestMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'Continue with 8 workers' }),
    );
    await entry.messages.requestMessage(messageRequest());
    expect(freshHost.requestMessage).toHaveBeenCalledTimes(1);
    entry.runtime.reset();
    expect(freshHost.reset).toHaveBeenCalledTimes(1);
    expect(first.reset).not.toHaveBeenCalled();
  });

  it('aborts synchronously on park and permits no hidden host actions', async () => {
    const { store, parking } = setup();
    const host = slot();
    const entry = store.attach(host.value)!;
    await expect(
      entry.tools.callTool(toolRequest(), new AbortController().signal),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'Calculated' }] });
    await expect(
      entry.messages.requestMessage(messageRequest()),
    ).resolves.toEqual({});
    const signal = entry.runtime.getSignal();

    store.release(host.value.key, host.value.token);

    expect(signal.aborted).toBe(true);
    expect(entry.runtime.isVisible()).toBe(false);
    expect(entry.runtime.getSignal().aborted).toBe(true);
    expect(entry.container.parentElement).toBe(parking);
    await expect(
      entry.tools.callTool(toolRequest(), new AbortController().signal),
    ).rejects.toThrow('inactive');
    await expect(
      entry.messages.requestMessage(messageRequest()),
    ).resolves.toEqual({ isError: true });
    entry.runtime.reset();
    expect(host.callTool).toHaveBeenCalledTimes(1);
    expect(host.requestMessage).toHaveBeenCalledTimes(1);
    expect(host.reset).not.toHaveBeenCalled();
  });

  it('rejects old completions without revoking a newly attached lease', async () => {
    const { store } = setup();
    const first = slot();
    const pendingMessage = deferred<{ isError?: boolean }>();
    const pendingTool = deferred<{ content: [] }>();
    first.requestMessage.mockReturnValue(pendingMessage.promise);
    first.callTool.mockReturnValue(pendingTool.promise);
    const entry = store.attach(first.value)!;
    const oldMessage = entry.messages.requestMessage(messageRequest());
    const oldTool = entry.tools.callTool(
      toolRequest(),
      new AbortController().signal,
    );
    const oldToolFailure = oldTool.catch((error: unknown) => error);

    store.release(first.value.key, first.value.token);
    expect(first.requestMessage.mock.calls[0][0].signal.aborted).toBe(true);
    expect(first.callTool.mock.calls[0][1].aborted).toBe(true);
    const second = slot('call-a', first.value.source);
    expect(store.attach(second.value)).toBe(entry);
    const newSignal = entry.runtime.getSignal();
    await expect(
      entry.messages.requestMessage(messageRequest()),
    ).resolves.toEqual({});
    await entry.tools.callTool(toolRequest(), new AbortController().signal);
    pendingMessage.resolve({});
    pendingTool.resolve({ content: [] });

    expect(await oldMessage).toEqual({ isError: true });
    expect(await oldToolFailure).toEqual(
      expect.objectContaining({ message: 'Generated UI owner changed' }),
    );
    expect(newSignal.aborted).toBe(false);
    expect(entry.runtime.getSignal()).toBe(newSignal);
    expect(second.callTool).toHaveBeenCalledTimes(1);
    expect(second.requestMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the review outcome when the lease ends before the review settles', async () => {
    const { store } = setup();
    const host = slot();
    const pending = deferred<{
      isError?: boolean;
      _meta?: { 'qwen-code/message-review'?: 'cancelled' };
    }>();
    host.requestMessage.mockReturnValue(pending.promise);
    const entry = store.attach(host.value)!;
    const request = entry.messages.requestMessage(messageRequest());

    store.release(host.value.key, host.value.token);
    pending.resolve({
      isError: false,
      _meta: { 'qwen-code/message-review': 'cancelled' },
    });

    expect(await request).toEqual({
      isError: true,
      _meta: { 'qwen-code/message-review': 'cancelled' },
    });
  });

  it('refreshes the owner after recovery and revokes the former signal', async () => {
    const { store } = setup();
    const owner = source();
    const host = slot('call-a', owner.value);
    const entry = store.attach(host.value)!;
    await entry.messages.requestMessage(messageRequest());
    const oldSignal = entry.runtime.getSignal();

    owner.recover();
    expect(entry.runtime.isVisible()).toBe(false);
    expect(await entry.messages.requestMessage(messageRequest())).toEqual({
      isError: true,
    });
    expect(host.requestMessage).toHaveBeenCalledTimes(1);
    store.update(host.value);

    expect(oldSignal.aborted).toBe(true);
    expect(entry.runtime.getSignal()).not.toBe(oldSignal);
    expect(entry.runtime.isVisible()).toBe(true);
    await entry.messages.requestMessage(messageRequest());
    expect(host.requestMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate slot and ignores its cleanup and the former slot cleanup', () => {
    const { store } = setup();
    const first = slot();
    const duplicate = slot('call-a', first.value.source);
    const entry = store.attach(first.value)!;
    const originalSignal = entry.runtime.getSignal();

    expect(store.attach(duplicate.value)).toBeUndefined();
    store.release(duplicate.value.key, duplicate.value.token);
    expect(entry.container.parentElement).toBe(first.value.element);
    expect(originalSignal.aborted).toBe(false);
    store.release(first.value.key, first.value.token);
    expect(store.attach(duplicate.value)).toBe(entry);
    const activeSignal = entry.runtime.getSignal();
    store.release(first.value.key, first.value.token);
    expect(entry.container.parentElement).toBe(duplicate.value.element);
    expect(activeSignal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revokes folded slots and resumes them without replacing the instance', async () => {
    const { store } = setup();
    const host = slot();
    const entry = store.attach(host.value)!;
    const signal = entry.runtime.getSignal();
    store.update({ ...host.value, visible: false });
    expect(signal.aborted).toBe(true);
    expect(await entry.messages.requestMessage(messageRequest())).toEqual({
      isError: true,
    });
    expect(host.requestMessage).not.toHaveBeenCalled();
    store.update(host.value);
    expect(store.getEntries()).toEqual([entry]);
    expect(entry.runtime.isVisible()).toBe(true);
    await entry.messages.requestMessage(messageRequest());
    expect(host.requestMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['missing-epoch', 'stale-owner', 'disabled', 'foreign-receipt'])(
    'denies admission for %s',
    (reason) => {
      const { store } = setup();
      const host = slot();
      if (reason === 'missing-epoch') host.value.source.eventEpoch = undefined;
      if (reason === 'stale-owner') {
        host.value.source.captureOwner = () => ({ isCurrent: () => false });
      }
      if (reason === 'disabled') host.value.receipt.status.enabled = false;
      if (reason === 'foreign-receipt') host.value.receipt.sessionId = 'other';
      expect(store.attach(host.value)).toBeUndefined();
      expect(store.getEntries()).toEqual([]);
      expect(host.callTool).not.toHaveBeenCalled();
      expect(host.requestMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['stale-owner', 'disabled', 'foreign-receipt'])(
    'releases an existing activation when admission becomes %s',
    (reason) => {
      const { store } = setup();
      const host = slot();
      const entry = store.attach(host.value)!;
      const signal = entry.runtime.getSignal();
      if (reason === 'stale-owner')
        host.value.source.captureOwner = () => ({ isCurrent: () => false });
      if (reason === 'disabled') host.value.receipt.status.enabled = false;
      if (reason === 'foreign-receipt') host.value.receipt.sessionId = 'other';

      expect(store.attach(host.value)).toBeUndefined();
      expect(store.getRecord(host.value.key)?.entry).toBeUndefined();
      expect(store.getRecord(host.value.key)?.reason).toBe('unavailable');
      expect(entry.container.isConnected).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(store.getEntries()).toEqual([]);
    },
  );
});

describe('Generated UI shadow parking', () => {
  it('parks a populated shadow instance and reattaches the same entry within its root', () => {
    const { store, parking } = setup();
    const shadow = shadowParking(store);
    const host = slot();
    shadow.root.appendChild(host.value.element);
    const entry = store.attach(host.value)!;
    const frame = document.createElement('iframe');
    entry.container.appendChild(frame);
    const signal = entry.runtime.getSignal();
    const nativeMove = vi.spyOn(
      HTMLElement.prototype as HTMLElement & {
        moveBefore(node: Node, before: Node | null): void;
      },
      'moveBefore',
    );

    store.release(host.value.key, host.value.token);

    expect(entry.container.parentElement).toBe(shadow.parking);
    expect(entry.container.getRootNode()).toBe(shadow.root);
    expect(entry.parkedAt).toBe(Date.now());
    expect(frame.isConnected).toBe(true);
    expect(parking.childElementCount).toBe(0);
    expect(signal.aborted).toBe(true);
    expect(store.getRecord(host.value.key)?.entry).toBe(entry);
    expect(store.attach(host.value)).toBe(entry);
    expect(entry.container.parentElement).toBe(host.value.element);
    expect(entry.container.firstChild).toBe(frame);
    expect(entry.runtime.getSignal().aborted).toBe(false);
    expect(nativeMove.mock.contexts).toEqual([
      shadow.parking,
      host.value.element,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one four-card budget and expiry timers across main and shadow parking', () => {
    const { store, parking } = setup();
    const shadow = shadowParking(store);
    const cards = Array.from(
      { length: MAX_PARKED_INSTANCES + 1 },
      (_, index) => {
        const host = slot(`mixed-${index}`);
        if (index % 2 === 0) shadow.root.appendChild(host.value.element);
        const entry = store.attach(host.value)!;
        entry.container.appendChild(document.createElement('iframe'));
        store.release(host.value.key, host.value.token);
        vi.advanceTimersByTime(1);
        return { host, entry };
      },
    );

    expect(store.getRecord(cards[0].host.value.key)?.reason).toBe('evicted');
    expect(cards[0].entry.container.isConnected).toBe(false);
    expect(store.getEntries()).toEqual(
      cards.slice(1).map(({ entry }) => entry),
    );
    expect(parking.childElementCount).toBe(2);
    expect(shadow.parking.childElementCount).toBe(2);
    expect(vi.getTimerCount()).toBe(MAX_PARKED_INSTANCES);
    const restored = cards[2];
    expect(store.attach(restored.host.value)).toBe(restored.entry);

    vi.advanceTimersByTime(PARKED_INSTANCE_TTL);

    expect(store.getEntries()).toEqual([restored.entry]);
    expect(restored.entry.container.parentElement).toBe(
      restored.host.value.element,
    );
    expect(restored.entry.runtime.isVisible()).toBe(true);
    for (const index of [1, 3, 4]) {
      expect(store.getRecord(cards[index].host.value.key)?.reason).toBe(
        'expired',
      );
      expect(cards[index].entry.container.isConnected).toBe(false);
    }
    expect(parking.childElementCount).toBe(0);
    expect(shadow.parking.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unregisters only its parked shadow entries and refuses later moves without a matching host', () => {
    const { store, parking } = setup();
    const shadow = shadowParking(store);
    const main = slot('main');
    const parked = slot('shadow-parked');
    const attached = slot('shadow-attached');
    shadow.root.append(parked.value.element, attached.value.element);
    const mainEntry = store.attach(main.value)!;
    const parkedEntry = store.attach(parked.value)!;
    const attachedEntry = store.attach(attached.value)!;
    for (const entry of [mainEntry, parkedEntry, attachedEntry])
      entry.container.appendChild(document.createElement('iframe'));
    store.release(main.value.key, main.value.token);
    store.release(parked.value.key, parked.value.token);

    shadow.unregister();

    expect(store.getRecord(parked.value.key)?.reason).toBe('parking-removed');
    expect(parkedEntry.container.isConnected).toBe(false);
    expect(store.getEntries()).toEqual([mainEntry, attachedEntry]);
    expect(mainEntry.container.parentElement).toBe(parking);
    expect(attachedEntry.runtime.isVisible()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    store.release(attached.value.key, attached.value.token);
    expect(store.getRecord(attached.value.key)?.reason).toBe('move-failed');
    expect(attachedEntry.container.isConnected).toBe(false);
    expect(store.getEntries()).toEqual([mainEntry]);
  });
});

describe('Generated UI retention budgets', () => {
  it('evicts only the least recently parked runtime when a fifth is parked', () => {
    expect(MAX_PARKED_INSTANCES).toBe(4);
    const { store } = setup();
    const attached = slot('visible');
    const attachedEntry = store.attach(attached.value)!;
    const parked = Array.from({ length: MAX_PARKED_INSTANCES }, (_, index) => {
      const host = slot(`parked-${index}`);
      const entry = store.attach(host.value)!;
      store.release(host.value.key, host.value.token);
      vi.advanceTimersByTime(1);
      return { host, entry };
    });
    expect(store.attach(parked[0].host.value)).toBe(parked[0].entry);
    store.release(parked[0].host.value.key, parked[0].host.value.token);
    vi.advanceTimersByTime(1);
    const fifth = slot('parked-fifth');
    store.attach(fifth.value);
    store.release(fifth.value.key, fifth.value.token);

    expect(store.getRecord(parked[1].host.value.key)?.reason).toBe('evicted');
    expect(parked[1].entry.container.isConnected).toBe(false);
    expect(store.getRecord(parked[0].host.value.key)?.entry).toBe(
      parked[0].entry,
    );
    expect(store.getRecord(attached.value.key)?.entry).toBe(attachedEntry);
    expect(attachedEntry.runtime.isVisible()).toBe(true);
    expect(store.getEntries()).toHaveLength(MAX_PARKED_INSTANCES + 1);
    expect(vi.getTimerCount()).toBe(MAX_PARKED_INSTANCES);
  });

  it('expires at 15 minutes, while remount cancels the old expiry timer', () => {
    expect(PARKED_INSTANCE_TTL).toBe(15 * 60_000);
    const { store } = setup();
    const host = slot();
    const entry = store.attach(host.value)!;
    store.release(host.value.key, host.value.token);
    vi.advanceTimersByTime(PARKED_INSTANCE_TTL - 1);
    expect(store.getRecord(host.value.key)?.entry).toBe(entry);
    expect(store.attach(host.value)).toBe(entry);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PARKED_INSTANCE_TTL);
    expect(store.getRecord(host.value.key)?.entry).toBe(entry);

    store.release(host.value.key, host.value.token);
    vi.advanceTimersByTime(PARKED_INSTANCE_TTL - 1);
    expect(store.getRecord(host.value.key)?.entry).toBe(entry);
    vi.advanceTimersByTime(1);
    expect(store.getRecord(host.value.key)?.entry).toBeUndefined();
    expect(store.getRecord(host.value.key)?.reason).toBe('expired');
    expect(entry.container.isConnected).toBe(false);
    expect(store.attach(host.value)).toBeUndefined();
  });

  it('uses absolute parked age when background expiry timers have not run', () => {
    const { store } = setup();
    const host = slot();
    const entry = store.attach(host.value)!;
    const parkedAt = Date.now();
    store.release(host.value.key, host.value.token);
    vi.setSystemTime(parkedAt + PARKED_INSTANCE_TTL);
    expect(store.getRecord(host.value.key)?.entry).toBe(entry);

    expect(store.attach(host.value)).toBeUndefined();
    expect(store.getRecord(host.value.key)?.reason).toBe('expired-or-changed');
    expect(entry.container.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const replacement = store.attach(host.value, true);
    expect(replacement).toBeDefined();
    expect(replacement!.id).not.toBe(entry.id);
  });

  it('bounds released metadata and leaves saturated unknown keys for outer fallback', () => {
    expect(MAX_INSTANCE_RECORDS).toBe(128);
    const { store } = setup();
    const retained = slot('retained');
    const retainedEntry = store.attach(retained.value)!;
    const releasedKeys: string[] = [];
    for (let index = 1; index < MAX_INSTANCE_RECORDS; index++) {
      const host = slot(`released-${index}`);
      store.attach(host.value);
      store.dispose(host.value.key, 'reset');
      releasedKeys.push(host.value.key);
    }
    const overflow = slot('overflow');

    expect(store.attach(overflow.value)).toBeUndefined();
    expect(store.attach(overflow.value, true)).toBeUndefined();
    expect(store.getRecord(overflow.value.key)).toBeUndefined();
    expect(store.getEntries()).toEqual([retainedEntry]);
    expect(retainedEntry.runtime.isVisible()).toBe(true);
    for (const key of releasedKeys) {
      expect(store.getRecord(key)).toEqual({
        scopeId: 'daemon-a',
        sessionId: 'session-a',
        entry: undefined,
        reason: 'reset',
      });
    }
    store.invalidate({ scopeId: 'daemon-a', reason: 'scope-changed' });
    expect(store.getRecord(retained.value.key)).toBeUndefined();
    expect(store.attach(overflow.value)).toBeDefined();
  });
});

describe('Generated UI invalidation and cleanup', () => {
  it('parks cleared attachments without losing parked or released records', async () => {
    const { store, parking } = setup();
    const attached = slot('attached');
    const parked = slot('parked');
    const released = slot('released');
    const attachedEntry = store.attach(attached.value)!;
    attachedEntry.container.appendChild(document.createElement('iframe'));
    const parkedEntry = store.attach(parked.value)!;
    store.release(parked.value.key, parked.value.token);
    const parkedAt = parkedEntry.parkedAt;
    store.attach(released.value);
    store.dispose(released.value.key, 'reset');
    const signal = attachedEntry.runtime.getSignal();

    store.invalidate({
      scopeId: 'daemon-a',
      sessionId: 'session-a',
      reason: 'cleared',
    });

    expect(signal.aborted).toBe(true);
    expect(attachedEntry.container.parentElement).toBe(parking);
    expect(store.getRecord(attached.value.key)?.entry).toBe(attachedEntry);
    expect(parkedEntry.parkedAt).toBe(parkedAt);
    expect(store.getRecord(released.value.key)?.reason).toBe('reset');
    expect(
      await attachedEntry.messages.requestMessage(messageRequest()),
    ).toEqual({ isError: true });
    expect(store.attach(attached.value)).toBe(attachedEntry);
    expect(attachedEntry.runtime.getSignal().aborted).toBe(false);
    expect(store.attach(released.value)).toBeUndefined();
  });

  it('keeps explicit-reopen records after scope-wide authentication failure', () => {
    const { store } = setup();
    const host = slot();
    const stopped = slot('stopped');
    const entry = store.attach(host.value)!;
    store.attach(stopped.value);
    store.release(stopped.value.key, stopped.value.token);

    store.invalidate({ scopeId: 'daemon-a', reason: 'auth-failed' });

    expect(entry.container.isConnected).toBe(false);
    expect(store.getEntries()).toEqual([]);
    for (const card of [host, stopped]) {
      expect(store.getRecord(card.value.key)?.reason).toBe('auth-failed');
      expect(store.attach(card.value)).toBeUndefined();
      expect(store.attach(card.value, true)?.runtime.reopened).toBe(true);
    }
  });

  it('invalidates only the requested owner and drops released payload references', async () => {
    const { store } = setup();
    const target = slot();
    const sameScopeOtherSession = slot(
      'call-a',
      source({ sessionId: 'b' }).value,
    );
    const otherScope = slot('call-a', source({ scopeId: 'daemon-b' }).value);
    const targetEntry = store.attach(target.value)!;
    const otherSessionEntry = store.attach(sameScopeOtherSession.value)!;
    const otherScopeEntry = store.attach(otherScope.value)!;
    await targetEntry.messages.requestMessage(messageRequest());
    const targetSignal = targetEntry.runtime.getSignal();

    store.invalidate({
      scopeId: 'daemon-a',
      sessionId: 'session-a',
      reason: 'deleted',
    });

    expect(targetSignal.aborted).toBe(true);
    expect(targetEntry.container.isConnected).toBe(false);
    expect(store.getRecord(target.value.key)).toEqual({
      scopeId: 'daemon-a',
      sessionId: 'session-a',
      entry: undefined,
      reason: 'deleted',
    });
    expect(await targetEntry.messages.requestMessage(messageRequest())).toEqual(
      {
        isError: true,
      },
    );
    expect(target.requestMessage).toHaveBeenCalledTimes(1);
    expect(store.getEntries()).toEqual([otherSessionEntry, otherScopeEntry]);
    expect(store.attach(target.value)).toBeUndefined();
  });

  it('clears attached and parked entries, timers and subsequent host access', async () => {
    const { store, parking } = setup();
    const attached = slot('attached');
    const parked = slot('parked');
    const attachedEntry = store.attach(attached.value)!;
    const parkedEntry = store.attach(parked.value)!;
    const attachedSignal = attachedEntry.runtime.getSignal();
    store.release(parked.value.key, parked.value.token);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.clear();

    expect(attachedSignal.aborted).toBe(true);
    expect(attachedEntry.container.isConnected).toBe(false);
    expect(parkedEntry.container.isConnected).toBe(false);
    expect(parking.children).toHaveLength(0);
    expect(store.getEntries()).toEqual([]);
    expect(store.getRecord(attached.value.key)).toBeUndefined();
    expect(store.getRecord(parked.value.key)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(
      await attachedEntry.messages.requestMessage(messageRequest()),
    ).toEqual({
      isError: true,
    });
    expect(attached.requestMessage).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['missing', 'throwing', 'detached', 'different-root'])(
    'disposes instead of claiming retention when a DOM move is %s',
    (failure) => {
      const { store, parking } = setup();
      const host = slot();
      const entry = store.attach(host.value)!;
      entry.container.appendChild(document.createElement('iframe'));
      const signal = entry.runtime.getSignal();
      if (failure === 'missing') {
        Reflect.deleteProperty(HTMLElement.prototype, 'moveBefore');
      } else if (failure === 'throwing') {
        Object.defineProperty(parking, 'moveBefore', {
          value: () => {
            throw new DOMException('Cannot move', 'HierarchyRequestError');
          },
        });
      } else if (failure === 'detached') {
        host.value.element.remove();
      } else {
        const shadowHost = document.createElement('div');
        document.body.appendChild(shadowHost);
        shadowHost.attachShadow({ mode: 'open' }).appendChild(parking);
      }

      store.release(host.value.key, host.value.token);

      expect(signal.aborted).toBe(true);
      expect(entry.container.isConnected).toBe(false);
      expect(store.getRecord(host.value.key)?.reason).toBe('move-failed');
      expect(store.getRecord(host.value.key)?.entry).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(store.attach(host.value)).toBeUndefined();
    },
  );
});
