import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HostAudioLifecycle } from '../../preload/audio-lifecycle.ts';

describe('Live Host audio lifecycle', () => {
  it('finishes delayed deactivation before initializing replacement resources', async () => {
    let finishClose: (() => void) | undefined;
    const closePending = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const events: string[] = [];
    let contextOwner: 'old' | 'new' | undefined = 'old';
    let listenerOwner: 'old' | 'new' | undefined = 'old';
    const lifecycle = new HostAudioLifecycle();

    const deactivate = lifecycle.deactivate(
      () => {
        events.push('deactivate');
      },
      async () => {
        events.push('cleanup:start');
        await closePending;
        contextOwner = undefined;
        listenerOwner = undefined;
        events.push('cleanup:end');
      },
    );
    const initialize = lifecycle.activate(async () => {
      events.push('initialize');
      contextOwner = 'new';
      listenerOwner = 'new';
    });
    const capture = lifecycle.runIfCurrent(async () => {
      events.push('capture');
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(events, ['deactivate', 'cleanup:start']);
    assert.equal(contextOwner, 'old');
    assert.equal(listenerOwner, 'old');

    finishClose?.();
    await Promise.all([deactivate, initialize, capture]);

    assert.deepEqual(events, [
      'deactivate',
      'cleanup:start',
      'cleanup:end',
      'initialize',
      'capture',
    ]);
    assert.equal(contextOwner, 'new');
    assert.equal(listenerOwner, 'new');
  });
});
