import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LiveGlobalShortcut,
  type GlobalShortcutBackend,
  type GlobalShortcutState,
} from '../global-shortcut.ts';

function fixture(registerResult: boolean | (() => boolean) = true) {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const callbacks = new Map<string, () => void>();
  const states: GlobalShortcutState[] = [];
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
  let toggles = 0;
  const shortcut = new LiveGlobalShortcut(
    backend,
    () => {
      toggles += 1;
    },
    (state) => states.push(state),
  );
  return {
    callbacks,
    registered,
    shortcut,
    states,
    toggles: () => toggles,
    unregistered,
  };
}

describe('LiveGlobalShortcut', () => {
  it('registers an ordinary Electron accelerator and dispatches toggles', () => {
    const value = fixture();
    value.shortcut.replace('Command+E');
    value.callbacks.get('Command+E')?.();

    assert.deepEqual(value.registered, ['Command+E']);
    assert.equal(value.toggles(), 1);
    assert.deepEqual(value.states, [
      { accelerator: 'Command+E', healthy: true },
    ]);
  });

  it('registers the replacement before unregistering the previous shortcut', () => {
    const value = fixture();
    value.shortcut.replace('Command+E');
    value.shortcut.replace('Command+Shift+E');

    assert.deepEqual(value.registered, ['Command+E', 'Command+Shift+E']);
    assert.deepEqual(value.unregistered, ['Command+E']);
  });

  it('preserves the previous shortcut when a replacement conflicts', () => {
    let calls = 0;
    const value = fixture(() => ++calls === 1);
    value.shortcut.replace('Command+E');

    const state = value.shortcut.replace('Command+Shift+E');

    assert.deepEqual(state, {
      accelerator: 'Command+Shift+E',
      healthy: false,
      error: 'That shortcut is already in use.',
    });
    assert.deepEqual(value.unregistered, []);
    value.callbacks.get('Command+E')?.();
    assert.equal(value.toggles(), 1);
    assert.deepEqual(value.states, [
      { accelerator: 'Command+E', healthy: true },
    ]);
  });

  it('reports initial registration failure and unregisters on stop', () => {
    const failed = fixture(false);
    failed.shortcut.replace('Command+E');
    assert.deepEqual(failed.states, [
      {
        accelerator: 'Command+E',
        healthy: false,
        error: 'That shortcut is already in use.',
      },
    ]);
    failed.shortcut.replace('Command+E');
    assert.deepEqual(failed.registered, ['Command+E', 'Command+E']);
    failed.shortcut.stop();

    const active = fixture();
    active.shortcut.replace('Command+E');
    active.shortcut.stop();
    assert.deepEqual(active.unregistered, ['Command+E']);
    assert.deepEqual(active.states.at(-1), { healthy: false });
  });

  it('supports Off without making the Host self-check unhealthy', () => {
    const value = fixture();
    value.shortcut.replace('Command+E');

    const state = value.shortcut.replace('');

    assert.deepEqual(state, { accelerator: '', healthy: true });
    assert.deepEqual(value.unregistered, ['Command+E']);
    assert.equal(value.callbacks.size, 0);
  });

  it('retries only when registration is explicitly synchronized again', () => {
    let conflicted = true;
    const value = fixture(() => !conflicted);
    value.shortcut.replace('Command+E');

    assert.deepEqual(value.registered, ['Command+E']);
    conflicted = false;
    value.shortcut.replace('Command+E');

    assert.deepEqual(value.registered, ['Command+E', 'Command+E']);
    assert.deepEqual(value.states.at(-1), {
      accelerator: 'Command+E',
      healthy: true,
    });
  });
});
