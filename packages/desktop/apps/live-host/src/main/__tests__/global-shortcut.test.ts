import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LiveGlobalShortcut,
  type GlobalShortcutBackend,
  type GlobalShortcutState,
  type ShortcutRetryScheduler,
} from '../global-shortcut.ts';

function fixture(registerResult: boolean | (() => boolean) = true) {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const callbacks = new Map<string, () => void>();
  const states: GlobalShortcutState[] = [];
  const retryDelays: number[] = [];
  const retries = new Set<() => void>();
  const backend: GlobalShortcutBackend = {
    register: (accelerator, callback) => {
      registered.push(accelerator);
      const registeredSuccessfully =
        typeof registerResult === 'function'
          ? registerResult()
          : registerResult;
      if (registeredSuccessfully) callbacks.set(accelerator, callback);
      return registeredSuccessfully;
    },
    unregister: (accelerator) => {
      unregistered.push(accelerator);
      callbacks.delete(accelerator);
    },
  };
  const retryScheduler: ShortcutRetryScheduler = (callback, delayMs) => {
    retryDelays.push(delayMs);
    retries.add(callback);
    return () => retries.delete(callback);
  };
  let toggles = 0;
  const shortcut = new LiveGlobalShortcut(
    backend,
    () => {
      toggles += 1;
    },
    (state) => states.push(state),
    retryScheduler,
  );
  return {
    callbacks,
    pendingRetries: () => retries.size,
    registered,
    retryDelays,
    runRetry: () => {
      const callback = retries.values().next().value;
      if (!callback) return;
      retries.delete(callback);
      callback();
    },
    shortcut,
    states,
    toggles: () => toggles,
    unregistered,
  };
}

describe('LiveGlobalShortcut', () => {
  it('registers an ordinary Electron accelerator and dispatches toggles', () => {
    const value = fixture();
    value.shortcut.replace('Command+Q');
    value.callbacks.get('Command+Q')?.();

    assert.deepEqual(value.registered, ['Command+Q']);
    assert.equal(value.toggles(), 1);
    assert.deepEqual(value.states, [
      { accelerator: 'Command+Q', healthy: true },
    ]);
  });

  it('unregisters the previous accelerator before replacing it', () => {
    const value = fixture();
    value.shortcut.replace('Command+Q');
    value.shortcut.replace('Command+Shift+Q');

    assert.deepEqual(value.registered, ['Command+Q', 'Command+Shift+Q']);
    assert.deepEqual(value.unregistered, ['Command+Q']);
  });

  it('reports registration failure and unregisters on stop', () => {
    const failed = fixture(false);
    failed.shortcut.replace('Command+Q');
    assert.deepEqual(failed.states, [
      { accelerator: 'Command+Q', healthy: false },
    ]);
    assert.equal(failed.pendingRetries(), 1);
    failed.shortcut.replace('Command+Q');
    assert.deepEqual(failed.registered, ['Command+Q']);
    assert.equal(failed.pendingRetries(), 1);
    failed.shortcut.stop();
    assert.equal(failed.pendingRetries(), 0);

    const active = fixture();
    active.shortcut.replace('Command+Q');
    active.shortcut.stop();
    assert.deepEqual(active.unregistered, ['Command+Q']);
    assert.deepEqual(active.states.at(-1), { healthy: false });
  });

  it('recovers after the conflicting application releases the shortcut', () => {
    let conflicted = true;
    const value = fixture(() => !conflicted);
    value.shortcut.replace('Command+Q');

    assert.equal(value.pendingRetries(), 1);
    assert.deepEqual(value.retryDelays, [5_000]);
    conflicted = false;
    value.runRetry();

    assert.deepEqual(value.registered, ['Command+Q', 'Command+Q']);
    assert.deepEqual(value.states.at(-1), {
      accelerator: 'Command+Q',
      healthy: true,
    });
    assert.equal(value.pendingRetries(), 0);
  });
});
