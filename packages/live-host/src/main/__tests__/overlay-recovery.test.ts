import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRecoverableOverlayLoadFailure,
  OverlayRecoveryController,
  type OverlayFailureReason,
  type OverlayRecoveryScheduler,
} from '../overlay-recovery.ts';

function fixture() {
  const failures: OverlayFailureReason[] = [];
  const recoveries: Array<() => void> = [];
  let recoveryCount = 0;
  const scheduler: OverlayRecoveryScheduler = (callback) => {
    recoveries.push(callback);
    return () => {
      const index = recoveries.indexOf(callback);
      if (index >= 0) recoveries.splice(index, 1);
    };
  };
  const controller = new OverlayRecoveryController(
    (reason) => failures.push(reason),
    () => {
      recoveryCount += 1;
    },
    scheduler,
  );
  return {
    controller,
    failures,
    pending: () => recoveries.length,
    recoveries: () => recoveryCount,
    runRecovery: () => {
      const callback = recoveries.shift();
      callback?.();
    },
  };
}

describe('Live Host overlay recovery', () => {
  it('fails closed immediately and keeps only one pending recovery', () => {
    const value = fixture();
    value.controller.handleFailure('renderer_unresponsive');
    value.controller.handleFailure('renderer_process_gone');

    assert.deepEqual(value.failures, [
      'renderer_unresponsive',
      'renderer_process_gone',
    ]);
    assert.equal(value.pending(), 1);
    value.runRecovery();
    assert.equal(value.recoveries(), 1);
  });

  it('cancels pending recovery after a successful load or stop', () => {
    const ready = fixture();
    ready.controller.handleFailure('renderer_load_failed');
    ready.controller.markReady();
    assert.equal(ready.pending(), 0);

    const stopped = fixture();
    stopped.controller.handleFailure('renderer_process_gone');
    stopped.controller.stop();
    assert.equal(stopped.pending(), 0);
  });

  it('ignores aborted and subframe load failures', () => {
    assert.equal(isRecoverableOverlayLoadFailure(-3, true), false);
    assert.equal(isRecoverableOverlayLoadFailure(-105, false), false);
    assert.equal(isRecoverableOverlayLoadFailure(-105, true), true);
  });

  it('recovers once for each distinct load-crash loop', () => {
    const value = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      value.controller.handleFailure('preload_failed');
      value.runRecovery();
    }
    assert.equal(value.recoveries(), 5);

    value.controller.markReady();
    value.controller.handleFailure('renderer_process_gone');
    value.runRecovery();
    assert.equal(value.recoveries(), 6);
  });
});
