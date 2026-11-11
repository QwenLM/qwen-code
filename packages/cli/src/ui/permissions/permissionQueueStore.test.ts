/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The legacy suite's four `recheckAll` cases (fan-out over queued items,
 * `settleDeny` policy forwarding, iteration safety when a recheck removed its
 * own item, empty-queue no-op) were dropped: they bound to the removed
 * `push`/`remove`/`recheckAll` surface over `PermissionRequestItem`s, and the
 * store no longer initiates rechecks — the permission module re-runs checks
 * and delivers results through the handler's `onToolCheckResult`, whose
 * store-side effects the recheck cases below cover instead.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPermissionQueueStore } from './permissionQueueStore.js';
import type { PermissionQueueStore } from './permissionQueueStore.js';
import type { AskPrompt, PermissionUpdate } from '@qwen-code/core';

/** The context shape the permission module hands to the store's ask handler. */
type HostAskContext = Parameters<PermissionQueueStore['askHandler']>[0];

interface TestAskContext extends HostAskContext {
  /** Simulate the module delivering a fresh check result for this call. */
  deliverRecheck(result: HostAskContext['toolCheckResult']): void;
}

function makeReason(message: string) {
  return {
    message,
    attribution: { type: 'other', reason: 'test' },
  } as const;
}

function makePrompt(id: string): AskPrompt {
  return {
    toolUseId: id,
    toolName: `tool_${id}`,
    input: { arg: id },
    reason: makeReason(`Confirm ${id}`),
    skippable: true,
  };
}

function makeProxiedSettlements() {
  return {
    approve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
  };
}

function makeAskContext(
  id: string,
  suggestions?: PermissionUpdate[],
): TestAskContext {
  let listener:
    | ((result: HostAskContext['toolCheckResult']) => void)
    | undefined;

  return {
    toolUseId: id,
    toolName: `tool_${id}`,
    input: { arg: id },
    toolCheckResult: {
      kind: 'ask',
      reason: makeReason(`Confirm ${id}`),
      ...(suggestions ? { suggestions } : {}),
    },
    onToolCheckResult(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    deliverRecheck(result) {
      listener?.(result);
    },
  };
}

/** Let the handler reach the presenter, which it does across an await. */
async function untilQueued(
  store: PermissionQueueStore,
  toolUseId: string,
): Promise<void> {
  for (let i = 0; i < 50 && !store.getById(toolUseId); i++) {
    await Promise.resolve();
  }
}

const REMEMBER_RULE: PermissionUpdate = {
  type: 'addRules',
  destination: 'session',
  rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
  behavior: 'allow',
};

// A write-tool prompt appends its mode change at the end of the suggestion
// list; remembering has to report it together with the rule, not just the
// first suggestion.
const REMEMBER_MODE: PermissionUpdate = {
  type: 'setMode',
  destination: 'session',
  mode: 'acceptEdits',
};

function ids(store: PermissionQueueStore): string[] {
  return store.getSnapshot().map((prompt) => prompt.toolUseId);
}

describe('createPermissionQueueStore', () => {
  it('starts with empty queue', () => {
    const store = createPermissionQueueStore();
    expect(store.getSnapshot()).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('presentProxied adds prompts and updates snapshot', () => {
    const store = createPermissionQueueStore();

    store.presentProxied(makePrompt('a'), makeProxiedSettlements());
    expect(ids(store)).toEqual(['a']);
    expect(store.size).toBe(1);

    store.presentProxied(makePrompt('b'), makeProxiedSettlements());
    expect(ids(store)).toEqual(['a', 'b']);
    expect(store.size).toBe(2);
  });

  it('the presentProxied disposer removes its prompt', () => {
    const store = createPermissionQueueStore();
    const disposeA = store.presentProxied(
      makePrompt('a'),
      makeProxiedSettlements(),
    );
    store.presentProxied(makePrompt('b'), makeProxiedSettlements());

    disposeA();
    expect(ids(store)).toEqual(['b']);
    expect(store.size).toBe(1);
  });

  it('the disposer is a no-op once its prompt is gone', () => {
    const store = createPermissionQueueStore();
    const disposeA = store.presentProxied(
      makePrompt('a'),
      makeProxiedSettlements(),
    );
    store.presentProxied(makePrompt('b'), makeProxiedSettlements());

    disposeA();
    expect(() => disposeA()).not.toThrow();
    // The other prompt is untouched.
    expect(ids(store)).toEqual(['b']);
    expect(store.size).toBe(1);
  });

  it('notifies subscribers on presentProxied', () => {
    const store = createPermissionQueueStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.presentProxied(makePrompt('a'), makeProxiedSettlements());
    expect(listener).toHaveBeenCalledTimes(1);

    store.presentProxied(makePrompt('b'), makeProxiedSettlements());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers when a prompt is disposed', () => {
    const store = createPermissionQueueStore();
    const disposeA = store.presentProxied(
      makePrompt('a'),
      makeProxiedSettlements(),
    );

    const listener = vi.fn();
    store.subscribe(listener);

    disposeA();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify after unsubscribe', () => {
    const store = createPermissionQueueStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.presentProxied(makePrompt('a'), makeProxiedSettlements());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.presentProxied(makePrompt('b'), makeProxiedSettlements());
    expect(listener).toHaveBeenCalledTimes(1); // no additional call
  });

  it('returns new snapshot reference on each mutation', () => {
    const store = createPermissionQueueStore();
    store.presentProxied(makePrompt('a'), makeProxiedSettlements());
    const snap1 = store.getSnapshot();

    store.presentProxied(makePrompt('b'), makeProxiedSettlements());
    const snap2 = store.getSnapshot();

    expect(snap1).not.toBe(snap2);
  });

  it('exposes the queue store contract', () => {
    const store = createPermissionQueueStore();
    expect(typeof store.askHandler).toBe('function');
    expect(typeof store.presentProxied).toBe('function');
    expect(typeof store.getSnapshot).toBe('function');
    expect(typeof store.getById).toBe('function');
    expect(typeof store.subscribe).toBe('function');
    expect(store.size).toBe(0);
  });

  describe('getById', () => {
    it('returns the matching prompt by tool-use id', () => {
      const store = createPermissionQueueStore();
      store.presentProxied(makePrompt('other'), makeProxiedSettlements());
      store.presentProxied(makePrompt('target'), makeProxiedSettlements());

      const found = store.getById('target');
      expect(found?.toolUseId).toBe('target');
      // It is the queued prompt itself, the one the snapshot shows.
      expect(found).toBe(store.getSnapshot()[1]);
    });

    it('returns undefined for unknown id', () => {
      const store = createPermissionQueueStore();
      store.presentProxied(makePrompt('a'), makeProxiedSettlements());
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  // ==========================================================================
  // askHandler: the local module's path into the queue
  // ==========================================================================

  describe('askHandler', () => {
    it('enqueues the prompt and resolves approved when the user approves', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');
      expect(store.size).toBe(1);

      const queued = store.getById('a');
      expect(queued?.toolName).toBe('tool_a');
      expect(queued?.input).toEqual({ arg: 'a' });
      expect(queued?.reason.message).toBe('Confirm a');

      queued?.approve();
      await expect(pending).resolves.toEqual({ kind: 'approved' });
      // Settling took the prompt off screen.
      expect(store.size).toBe(0);
    });

    it('approve carries an amended input', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.approve({ input: { arg: 'amended' } });
      await expect(pending).resolves.toEqual({
        kind: 'approved',
        input: { arg: 'amended' },
      });
    });

    it('approve with a scope reports the scope and every suggestion via onRemember', async () => {
      const onRemember = vi.fn();
      const store = createPermissionQueueStore({ onRemember });
      const suggestions = [REMEMBER_RULE, REMEMBER_MODE];
      const ctx = makeAskContext('a', suggestions);

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.approve({ scope: 'session' });
      expect(onRemember).toHaveBeenCalledTimes(1);
      // The full list, the trailing setMode included — not just the first.
      expect(onRemember).toHaveBeenCalledWith('session', suggestions);
      await expect(pending).resolves.toEqual({ kind: 'approved' });
    });

    it('remembers only the exact MCP tool rule, not the server wildcard', async () => {
      const onRemember = vi.fn();
      const store = createPermissionQueueStore({ onRemember });
      const exact: PermissionUpdate = {
        type: 'addRules',
        destination: 'localSettings',
        rules: [{ toolName: 'mcp__project-feature__echo' }],
        behavior: 'allow',
      };
      const wildcard: PermissionUpdate = {
        type: 'addRules',
        destination: 'localSettings',
        rules: [{ toolName: 'mcp__project-feature__*' }],
        behavior: 'allow',
      };
      const ctx = {
        ...makeAskContext('mcp', [exact, wildcard]),
        toolName: 'mcp__project-feature__echo',
      };

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'mcp');

      store.getById('mcp')?.approve({ scope: 'persist' });
      expect(onRemember).toHaveBeenCalledWith('persist', [exact]);
      await expect(pending).resolves.toEqual({ kind: 'approved' });
    });

    it('approve without a scope reports nothing to onRemember', async () => {
      const onRemember = vi.fn();
      const store = createPermissionQueueStore({ onRemember });
      const ctx = makeAskContext('a', [REMEMBER_RULE]);

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.approve();
      expect(onRemember).not.toHaveBeenCalled();
      await expect(pending).resolves.toEqual({ kind: 'approved' });
    });

    it('reject settles rejected and clears the queue', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.reject();
      await expect(pending).resolves.toEqual({ kind: 'rejected' });
      expect(store.size).toBe(0);
    });

    it('reject with a reason settles rejected carrying the reason', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.reject('try a different approach');
      await expect(pending).resolves.toEqual({
        kind: 'rejected',
        reason: 'try a different approach',
      });
      expect(store.size).toBe(0);
    });

    it('abort settles aborted and clears the queue', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      store.getById('a')?.abort();
      await expect(pending).resolves.toEqual({ kind: 'aborted' });
      expect(store.size).toBe(0);
    });

    it('a recheck allow settles a prompt the user never answered', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      ctx.deliverRecheck({ kind: 'allow' });
      await expect(pending).resolves.toEqual({ kind: 'approved' });
      expect(store.size).toBe(0);
    });

    it('a recheck deny settles rejected', async () => {
      const store = createPermissionQueueStore();
      const ctx = makeAskContext('a');

      const pending = store.askHandler(ctx);
      await untilQueued(store, 'a');

      ctx.deliverRecheck({ kind: 'deny' });
      await expect(pending).resolves.toEqual({ kind: 'rejected' });
      expect(store.size).toBe(0);
    });

    it('a still-ask recheck refreshes the prompt in place, keeping its queue position', async () => {
      const store = createPermissionQueueStore();
      store.presentProxied(makePrompt('first'), makeProxiedSettlements());
      const ctx = makeAskContext('mid');
      const pending = store.askHandler(ctx);
      await untilQueued(store, 'mid');
      store.presentProxied(makePrompt('last'), makeProxiedSettlements());

      ctx.deliverRecheck({
        kind: 'ask',
        reason: makeReason('Updated copy'),
        extra: { promptInput: { arg: 'rewritten' } },
      });

      // Replaced in place: new copy and projection, same slot in the queue.
      expect(ids(store)).toEqual(['first', 'mid', 'last']);
      const refreshed = store.getById('mid');
      expect(refreshed?.reason.message).toBe('Updated copy');
      expect(refreshed?.input).toEqual({ arg: 'rewritten' });
      expect(store.size).toBe(3);

      // The prompt still settles normally after a refresh.
      refreshed?.approve();
      await expect(pending).resolves.toEqual({ kind: 'approved' });
      expect(ids(store)).toEqual(['first', 'last']);
    });
  });

  // ==========================================================================
  // presentProxied settlements (the remote-controller path)
  // ==========================================================================

  describe('presentProxied settlements', () => {
    it('forwards the user actions to the worker-side callbacks', () => {
      const store = createPermissionQueueStore();
      const settlements = makeProxiedSettlements();
      const dispose = store.presentProxied(makePrompt('r'), settlements);

      const queued = store.getById('r');
      expect(queued).toBeDefined();

      queued?.approve({ input: { arg: 'amended' } });
      expect(settlements.approve).toHaveBeenCalledWith(
        { arg: 'amended' },
        undefined,
      );

      queued?.reject();
      expect(settlements.reject).toHaveBeenCalledTimes(1);

      queued?.abort();
      expect(settlements.abort).toHaveBeenCalledTimes(1);

      // Only the disposer takes a proxied prompt off screen.
      expect(store.size).toBe(1);
      dispose();
      expect(store.size).toBe(0);
    });

    it('does not write a remembered choice locally for a proxied prompt', () => {
      const onRemember = vi.fn();
      const store = createPermissionQueueStore({ onRemember });
      const settlements = makeProxiedSettlements();
      store.presentProxied(makePrompt('r'), settlements);

      // The rule lives on the worker, so the remember travels in the approval,
      // not through the local onRemember hook.
      store.getById('r')?.approve({ scope: 'session' });
      expect(onRemember).not.toHaveBeenCalled();
      expect(settlements.approve).toHaveBeenCalledWith(undefined, 'session');
    });
  });
});

describe('non-persistable prompts', () => {
  function catastrophicContext(id: string): TestAskContext {
    const ctx = makeAskContext(id, [REMEMBER_RULE]);
    return {
      ...ctx,
      toolCheckResult: {
        kind: 'ask',
        reason: {
          message: `Dangerous rm operation detected: '~'`,
          attribution: {
            type: 'safetyCheck',
            reason: 'Dangerous rm operation on critical path: ~',
            safetyCheckKind: 'dangerousRemoval',
            bypassImmune: true,
          },
        },
        suggestions: [],
      },
    };
  }

  it('approve with a scope remembers nothing', async () => {
    const onRemember = vi.fn();
    const store = createPermissionQueueStore({ onRemember });
    const ctx = catastrophicContext('a');

    const pending = store.askHandler(ctx);
    await untilQueued(store, 'a');
    expect(store.getById('a')?.persistable).toBe(false);
    expect(store.getById('a')?.skippable).toBe(false);

    store.getById('a')?.approve({ scope: 'persist' });
    expect(onRemember).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ kind: 'approved' });
  });

  it('a recheck refresh keeps the prompt non-persistable', async () => {
    const store = createPermissionQueueStore();
    const ctx = catastrophicContext('a');
    const pending = store.askHandler(ctx);
    await untilQueued(store, 'a');

    ctx.deliverRecheck(ctx.toolCheckResult);

    expect(store.getById('a')?.persistable).toBe(false);
    store.getById('a')?.reject();
    await expect(pending).resolves.toEqual({ kind: 'rejected' });
  });
});
