import type { ContextType } from 'react';
import type { McpAppDisplay } from '../components/messages/McpApp';
import type {
  McpAppGeneratedUi,
  McpAppGeneratedUiInvalidation,
  McpAppGeneratedUiOwnerSource,
  McpAppMessages,
  McpAppToolsContext,
} from '../mcpAppHostContext';

export const MAX_PARKED_INSTANCES = 4;
export const PARKED_INSTANCE_TTL = 15 * 60_000;
export const MAX_INSTANCE_RECORDS = 128;

type ToolHost = NonNullable<ContextType<typeof McpAppToolsContext>>;

export interface InstanceHost {
  source: McpAppGeneratedUiOwnerSource;
  receipt: McpAppGeneratedUi;
  tools?: ToolHost;
  messages?: McpAppMessages;
  baseUrl: string;
}

export interface InstanceSlot extends InstanceHost {
  key: string;
  resourceKey: string;
  display: McpAppDisplay;
  element: HTMLElement;
  token: object;
  visible: boolean;
  reset(): void;
}

interface Lease {
  generation: number;
  controller: AbortController;
  owner: ReturnType<McpAppGeneratedUiOwnerSource['captureOwner']>;
  host: InstanceHost;
  reset(): void;
}

export interface GeneratedUiInstance {
  id: number;
  key: string;
  scopeId: string;
  sessionId: string;
  resourceKey: string;
  display: McpAppDisplay;
  baseUrl: string;
  container: HTMLDivElement;
  canCallTool: boolean;
  canMessage: boolean;
  token?: object;
  lease?: Lease;
  leaseGeneration?: number;
  parkedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  tools: ToolHost;
  messages: McpAppMessages;
  runtime: {
    reopened: boolean;
    getSignal(): AbortSignal;
    isVisible(): boolean;
    reset(): void;
  };
}

interface InstanceRecord {
  scopeId: string;
  sessionId: string;
  entry?: GeneratedUiInstance;
  reason?: string;
}

export function instanceKey(
  source: McpAppGeneratedUiOwnerSource,
  toolId: string,
  display: McpAppDisplay,
) {
  return JSON.stringify([
    source.scopeId,
    source.workspaceCwd,
    source.sessionId,
    toolId,
    display.serverName,
    display.resourceUri,
  ]);
}

export function resourceKey(
  display: McpAppDisplay,
  eventEpoch?: string,
  capabilities?: { tools: boolean; messages: boolean },
) {
  return JSON.stringify(
    [
      display.requiredFeature,
      display.serverName,
      display.resourceUri,
      display.html,
      display.csp,
      display.permissions,
      display.toolArguments,
      display.toolResult,
      eventEpoch,
      capabilities,
    ],
    (_key, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    },
  );
}

function move(container: HTMLElement, target: HTMLElement) {
  const parent = target as HTMLElement & {
    moveBefore?: (node: Node, before: Node | null) => void;
  };
  if (
    !container.isConnected ||
    !target.isConnected ||
    container.getRootNode() !== target.getRootNode()
  )
    return false;
  // StrictMode can release a new slot before its portal first renders. Moving
  // that empty container cannot reset a frame; live Runtime DOM always needs
  // the native state-preserving operation below.
  if (!container.hasChildNodes()) {
    target.appendChild(container);
    return true;
  }
  if (!parent.moveBefore) return false;
  try {
    parent.moveBefore(container, null);
    return true;
  } catch {
    return false;
  }
}

export class GeneratedUiInstanceStore {
  private records = new Map<string, InstanceRecord>();
  private listeners = new Set<() => void>();
  private version = 0;
  private generation = 0;
  private snapshot: GeneratedUiInstance[] = [];
  private revoked = AbortSignal.abort();
  private parkingHosts = new Set<HTMLElement>();
  parking?: HTMLElement;

  registerParking(element: HTMLElement) {
    this.parkingHosts.add(element);
    return () => {
      this.parkingHosts.delete(element);
      for (const [key, { entry }] of this.records) {
        if (
          entry?.parkedAt !== undefined &&
          entry.container.parentElement === element
        )
          this.dispose(key, 'parking-removed');
      }
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.version;
  getEntries = () => this.snapshot;
  getRecord = (key: string) => this.records.get(key);

  private changed() {
    this.snapshot = [...this.records.values()].flatMap(({ entry }) =>
      entry ? [entry] : [],
    );
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private current(
    entry: GeneratedUiInstance,
    lease = entry.lease,
  ): lease is Lease {
    return (
      !!lease &&
      entry.lease === lease &&
      entry.leaseGeneration === lease.generation &&
      this.records.get(entry.key)?.entry === entry &&
      !!entry.token &&
      !lease.controller.signal.aborted &&
      lease.owner.isCurrent() &&
      lease.host.receipt.sessionId === entry.sessionId &&
      lease.host.receipt.status.version === 1 &&
      lease.host.receipt.status.enabled
    );
  }

  private revoke(entry: GeneratedUiInstance) {
    const lease = entry.lease;
    entry.lease = undefined;
    entry.leaseGeneration = ++this.generation;
    lease?.controller.abort();
  }

  private grant(entry: GeneratedUiInstance, slot: InstanceSlot) {
    if (!slot.visible) {
      this.revoke(entry);
      return;
    }
    const existing = entry.lease;
    if (
      this.current(entry, existing) &&
      existing.host.source.clientId === slot.source.clientId
    ) {
      existing.host = slot;
      existing.reset = slot.reset;
      return;
    }
    this.revoke(entry);
    const owner = slot.source.captureOwner();
    if (!owner.isCurrent()) return;
    entry.lease = {
      generation: ++this.generation,
      controller: new AbortController(),
      owner,
      host: slot,
      reset: slot.reset,
    };
    entry.leaseGeneration = entry.lease.generation;
  }

  attach(
    slot: InstanceSlot,
    explicit = false,
  ): GeneratedUiInstance | undefined {
    let record = this.records.get(slot.key);
    let entry = record?.entry;
    if (entry?.token && entry.token !== slot.token) return undefined;
    if (
      entry &&
      (entry.resourceKey !== slot.resourceKey ||
        (entry.parkedAt !== undefined &&
          Date.now() - entry.parkedAt >= PARKED_INSTANCE_TTL))
    ) {
      this.dispose(slot.key, 'expired-or-changed');
      entry = undefined;
    }
    if (
      !slot.element.isConnected ||
      !slot.source.eventEpoch ||
      !slot.source.captureOwner().isCurrent() ||
      slot.receipt.sessionId !== slot.source.sessionId ||
      slot.receipt.status.version !== 1 ||
      !slot.receipt.status.enabled
    ) {
      if (entry) this.dispose(slot.key, 'unavailable');
      return undefined;
    }
    if (!entry) {
      if (
        (!explicit && record) ||
        (!record && this.records.size >= MAX_INSTANCE_RECORDS)
      )
        return undefined;
      const container = document.createElement('div');
      slot.element.appendChild(container);
      entry = {
        id: ++this.generation,
        key: slot.key,
        scopeId: slot.source.scopeId,
        sessionId: slot.source.sessionId,
        resourceKey: slot.resourceKey,
        display: slot.display,
        baseUrl: slot.baseUrl,
        container,
        canCallTool: slot.tools?.sessionId === slot.source.sessionId,
        canMessage: slot.messages?.sessionId === slot.source.sessionId,
        tools: undefined!,
        messages: undefined!,
        runtime: undefined!,
      };
      const instance = entry;
      entry.tools = {
        sessionId: entry.sessionId,
        callTool: async (request, signal) => {
          const lease = instance.lease;
          if (
            !this.current(instance, lease) ||
            !lease.host.tools ||
            lease.host.tools.sessionId !== instance.sessionId
          )
            throw new Error('Generated UI is inactive');
          const result = await lease.host.tools.callTool(
            request,
            AbortSignal.any([signal, lease.controller.signal]),
          );
          if (!this.current(instance, lease))
            throw new Error('Generated UI owner changed');
          return result;
        },
      };
      entry.messages = {
        sessionId: entry.sessionId,
        requestMessage: async (request) => {
          const lease = instance.lease;
          if (
            !this.current(instance, lease) ||
            !lease.host.messages ||
            lease.host.messages.sessionId !== instance.sessionId
          )
            return { isError: true };
          const result = await lease.host.messages.requestMessage({
            ...request,
            signal: AbortSignal.any([request.signal, lease.controller.signal]),
          });
          // A card that lost its lease gets no live result, only the
          // outcome that says whether anything was sent.
          return this.current(instance, lease)
            ? result
            : {
                isError: true,
                ...(result._meta ? { _meta: result._meta } : {}),
              };
        },
      };
      entry.runtime = {
        reopened: explicit,
        getSignal: () =>
          this.current(instance)
            ? instance.lease!.controller.signal
            : this.revoked,
        isVisible: () => this.current(instance),
        reset: () => {
          if (this.current(instance)) instance.lease!.reset();
        },
      };
      record = { scopeId: entry.scopeId, sessionId: entry.sessionId, entry };
      this.records.set(slot.key, record);
    } else if (!entry.token && !move(entry.container, slot.element)) {
      this.dispose(slot.key, 'move-failed');
      return undefined;
    }
    const wasParked = entry.parkedAt !== undefined;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.parkedAt = undefined;
    entry.token = slot.token;
    this.grant(entry, slot);
    if (wasParked || !this.snapshot.includes(entry)) this.changed();
    return entry;
  }

  update(slot: InstanceSlot) {
    const entry = this.records.get(slot.key)?.entry;
    if (entry?.token === slot.token) this.grant(entry, slot);
  }

  release(key: string, token: object) {
    const entry = this.records.get(key)?.entry;
    if (!entry || entry.token !== token) return;
    this.revoke(entry);
    entry.token = undefined;
    const focused = entry.container.ownerDocument.activeElement;
    if (focused && entry.container.contains(focused))
      (focused as HTMLElement).blur();
    const root = entry.container.getRootNode();
    const parking = [this.parking, ...this.parkingHosts].find(
      (element) => element?.isConnected && element.getRootNode() === root,
    );
    if (!parking || !move(entry.container, parking)) {
      this.dispose(key, 'move-failed');
      return;
    }
    entry.parkedAt = Date.now();
    entry.timer = setTimeout(() => {
      if (this.records.get(key)?.entry === entry && !entry.token)
        this.dispose(key, 'expired');
    }, PARKED_INSTANCE_TTL);
    const parked = [...this.records.values()]
      .flatMap(({ entry }) => (entry?.parkedAt !== undefined ? [entry] : []))
      .sort((a, b) => a.parkedAt! - b.parkedAt!);
    while (parked.length > MAX_PARKED_INSTANCES)
      this.dispose(parked.shift()!.key, 'evicted');
    this.changed();
  }

  dispose(key: string, reason: string) {
    const record = this.records.get(key);
    if (!record) return;
    const entry = record.entry;
    record.entry = undefined;
    record.reason = reason;
    if (entry) {
      this.revoke(entry);
      clearTimeout(entry.timer);
      entry.token = undefined;
      entry.container.remove();
    }
    this.changed();
  }

  invalidate = (event: McpAppGeneratedUiInvalidation) => {
    for (const [key, record] of this.records) {
      if (
        record.scopeId === event.scopeId &&
        (!event.sessionId || event.sessionId === record.sessionId)
      ) {
        if (event.reason === 'cleared') {
          if (record.entry?.token) this.release(key, record.entry.token);
          continue;
        }
        this.dispose(key, event.reason);
        if (event.reason === 'scope-changed') this.records.delete(key);
      }
    }
    this.changed();
  };

  clear() {
    for (const key of this.records.keys()) this.dispose(key, 'closed');
    this.records.clear();
    this.changed();
  }
}
