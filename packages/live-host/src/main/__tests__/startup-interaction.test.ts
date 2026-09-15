import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  StartupInteraction,
  type StartupInteractionState,
} from '../startup-interaction.ts';

const ready: StartupInteractionState = {
  connectionReady: true,
  rendererReady: true,
  hostReady: true,
  startPending: false,
  live: { available: true, state: 'idle' },
};

describe('Host startup interaction', () => {
  it('waits for every startup readiness gate before consuming the intention', () => {
    for (const key of [
      'connectionReady',
      'rendererReady',
      'hostReady',
    ] as const) {
      const startup = new StartupInteraction();
      assert.equal(startup.shouldStart({ ...ready, [key]: false }), false);
      assert.equal(startup.shouldStart({ ...ready, [key]: false }), false);
      assert.equal(startup.shouldStart(ready), true);
      assert.equal(startup.shouldStart(ready), false);
    }
  });

  it('waits for provider availability and idle state', () => {
    const startup = new StartupInteraction();
    assert.equal(
      startup.shouldStart({
        ...ready,
        live: { available: false, state: 'idle' },
      }),
      false,
    );
    assert.equal(
      startup.shouldStart({
        ...ready,
        live: { available: false, state: 'unavailable' },
      }),
      false,
    );
    assert.equal(
      startup.shouldStart({
        ...ready,
        live: { available: true, state: 'error' },
      }),
      false,
    );
    assert.equal(startup.shouldStart(ready), true);
  });

  it('treats an existing call as fulfilled intent even before renderer readiness', () => {
    for (const state of [
      'starting',
      'listening',
      'thinking',
      'speaking',
      'stopping',
    ] as const) {
      const startup = new StartupInteraction();
      assert.equal(
        startup.shouldStart({
          ...ready,
          rendererReady: false,
          live: { available: true, state },
        }),
        false,
      );
      assert.equal(startup.shouldStart(ready), false);
    }
  });

  it('does not duplicate an already pending start', () => {
    const startup = new StartupInteraction();
    assert.equal(startup.shouldStart({ ...ready, startPending: true }), false);
    assert.equal(startup.shouldStart(ready), false);
  });

  it('lets explicit user actions cancel startup before it becomes ready', () => {
    const startup = new StartupInteraction();
    assert.equal(
      startup.shouldStart({ ...ready, connectionReady: false }),
      false,
    );
    startup.cancel();
    startup.cancel();
    assert.equal(startup.shouldStart(ready), false);
    assert.equal(
      startup.shouldStart({ ...ready, rendererReady: false }),
      false,
    );
    assert.equal(startup.shouldStart(ready), false);
  });

  it('consumes before dispatch so failure, reconnect and a later idle state never retry', () => {
    const startup = new StartupInteraction();
    assert.equal(startup.shouldStart(ready), true);
    assert.equal(
      startup.shouldStart({
        ...ready,
        live: { available: false, state: 'error' },
      }),
      false,
    );
    assert.equal(
      startup.shouldStart({ ...ready, connectionReady: false }),
      false,
    );
    assert.equal(
      startup.shouldStart({ ...ready, rendererReady: false }),
      false,
    );
    assert.equal(startup.shouldStart(ready), false);
    startup.cancel();
    assert.equal(startup.shouldStart(ready), false);
  });

  it('gives each new Host process its own single startup intention', () => {
    const previous = new StartupInteraction();
    previous.cancel();
    assert.equal(previous.shouldStart(ready), false);
    const restarted = new StartupInteraction();
    assert.equal(restarted.shouldStart(ready), true);
    assert.equal(restarted.shouldStart(ready), false);
  });
});
