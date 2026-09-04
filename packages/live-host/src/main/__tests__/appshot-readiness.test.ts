import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppshotReadinessMonitor } from '../appshot-readiness.ts';
import type { NativeAppshot } from '../native-appshot.ts';

function fakeNative(overrides: Partial<NativeAppshot> = {}): NativeAppshot {
  return {
    getPermissionState: () => ({
      accessibility: false,
      screenRecording: false,
    }),
    requestAccessibility: () => false,
    requestScreenRecording: () => false,
    captureAppshot: async () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

describe('AppshotReadinessMonitor', () => {
  it('checks the in-process native module once without polling', async () => {
    let checks = 0;
    const states: unknown[] = [];
    const native = fakeNative({
      getPermissionState: () => {
        checks += 1;
        return { accessibility: true, screenRecording: true };
      },
    });
    const monitor = new AppshotReadinessMonitor(
      (state) => states.push(state),
      () => native,
    );

    monitor.start();
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(checks, 1);
    assert.deepEqual(states, [
      {
        accessibility: 'granted',
        screenRecording: 'granted',
        appshot: true,
      },
    ]);
    monitor.stop();
  });

  it('requests only the selected Host permission and rechecks explicitly', () => {
    let accessibilityRequests = 0;
    let screenRecordingRequests = 0;
    let checks = 0;
    const native = fakeNative({
      getPermissionState: () => {
        checks += 1;
        return {
          accessibility: accessibilityRequests > 0,
          screenRecording: screenRecordingRequests > 0,
        };
      },
      requestAccessibility: () => {
        accessibilityRequests += 1;
        return true;
      },
      requestScreenRecording: () => {
        screenRecordingRequests += 1;
        return true;
      },
    });
    const states: unknown[] = [];
    const monitor = new AppshotReadinessMonitor(
      (state) => states.push(state),
      () => native,
    );

    monitor.start();
    monitor.requestPermission('accessibility');
    monitor.requestPermission('screenRecording');

    assert.equal(accessibilityRequests, 1);
    assert.equal(screenRecordingRequests, 1);
    assert.equal(checks, 3);
    assert.deepEqual(states.at(-1), {
      accessibility: 'granted',
      screenRecording: 'granted',
      appshot: true,
    });
    monitor.stop();
  });

  it('fails closed when the built-in module cannot load', () => {
    const states: unknown[] = [];
    const monitor = new AppshotReadinessMonitor(
      (state) => states.push(state),
      () => {
        throw new Error('missing native module');
      },
    );

    monitor.start();

    assert.deepEqual(states, [
      {
        accessibility: 'not_determined',
        screenRecording: 'not_determined',
        appshot: false,
      },
    ]);
    monitor.stop();
  });

  it('does nothing after the monitor stops', () => {
    let requests = 0;
    const native = fakeNative({
      requestAccessibility: () => {
        requests += 1;
        return true;
      },
    });
    const monitor = new AppshotReadinessMonitor(
      () => undefined,
      () => native,
    );
    monitor.start();
    monitor.stop();

    monitor.requestPermission('accessibility');
    monitor.refresh();

    assert.equal(requests, 0);
  });
});
