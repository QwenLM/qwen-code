import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AppshotCaptureService,
  validateNativeCapture,
} from '../appshot-capture.ts';
import type { NativeAppshot } from '../native-appshot.ts';

const cleanup: string[] = [];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fakeNative(
  captureAppshot: NativeAppshot['captureAppshot'],
): NativeAppshot {
  return {
    getPermissionState: () => ({
      accessibility: true,
      screenRecording: true,
    }),
    requestAccessibility: () => true,
    requestScreenRecording: () => true,
    captureAppshot,
  };
}

describe('AppshotCaptureService', () => {
  it('performs one in-process capture and returns a private PNG path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-appshot-test-'));
    cleanup.push(directory);
    let captures = 0;
    const native = fakeNative(async () => {
      captures += 1;
      return {
        appName: 'TextEdit',
        bundleIdentifier: 'com.apple.TextEdit',
        windowTitle: 'LIVE_APP_A',
        windowId: 42,
        accessibilityText: '- AXWindow title="LIVE_APP_A"',
        screenshot: PNG,
      };
    });
    const service = new AppshotCaptureService(directory, () => native);

    const result = await service.capture();

    assert.equal(captures, 1);
    assert.equal(result.appName, 'TextEdit');
    assert.equal(result.windowTitle, 'LIVE_APP_A');
    assert.equal(result.accessibilityText, '- AXWindow title="LIVE_APP_A"');
    assert.deepEqual(await readFile(result.screenshotPath), PNG);
    const stat = await lstat(result.screenshotPath);
    assert.equal(stat.mode & 0o077, 0);
    service.dispose();
  });

  it('serializes capture so one Live request cannot fan out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-appshot-busy-'));
    cleanup.push(directory);
    const native = fakeNative(async () => ({
      appName: 'Safari',
      windowId: 7,
      accessibilityText: '- AXWindow',
      screenshot: PNG,
    }));
    const service = new AppshotCaptureService(directory, () => native);

    const first = service.capture();
    await assert.rejects(service.capture(), /already in progress/u);
    await first;
    service.dispose();
  });

  it('rejects malformed native results before writing them', () => {
    assert.throws(
      () =>
        validateNativeCapture({
          appName: 'Safari',
          windowId: 0,
          accessibilityText: '- AXWindow',
          screenshot: PNG,
        }),
      /invalid screenshot/u,
    );
    assert.throws(
      () =>
        validateNativeCapture({
          appName: 'Safari',
          windowId: 7,
          accessibilityText: '',
          screenshot: PNG,
        }),
      /accessibility tree/u,
    );
  });
});
