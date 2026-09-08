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
import {
  MAX_CAPTURE_ASSET_BYTES,
  MAX_INPUT_IMAGE_FRAME_BYTES,
} from '../../shared/protocol.ts';

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
  it('performs one in-process capture and stores a private PNG', async () => {
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

    const result = await service.captureFrame();
    const screenshotPath = await service.storePng(result.screenshot);

    assert.equal(captures, 1);
    assert.equal(result.appName, 'TextEdit');
    assert.equal(result.windowTitle, 'LIVE_APP_A');
    assert.equal(result.accessibilityText, '- AXWindow title="LIVE_APP_A"');
    assert.deepEqual(await readFile(screenshotPath), PNG);
    const stat = await lstat(screenshotPath);
    assert.equal(stat.mode & 0o077, 0);
    service.dispose();
  });

  it('queues capture so one Live request cannot fan out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-appshot-busy-'));
    cleanup.push(directory);
    let finishFirst: (() => void) | undefined;
    let active = 0;
    let captures = 0;
    const native = fakeNative(async () => {
      captures += 1;
      active += 1;
      assert.equal(active, 1);
      if (captures === 1) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      active -= 1;
      return {
        appName: 'Safari',
        windowId: 7,
        accessibilityText: '- AXWindow',
        screenshot: PNG,
      };
    });
    const service = new AppshotCaptureService(directory, () => native);

    const first = service.captureFrame();
    const second = service.captureFrame();
    assert.equal(captures, 1);
    finishFirst?.();
    await Promise.all([first, second]);
    assert.equal(captures, 2);
    service.dispose();
  });

  it('continues the capture queue after an earlier request fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-appshot-queue-'));
    cleanup.push(directory);
    let captures = 0;
    const native = fakeNative(async () => {
      captures += 1;
      if (captures === 1) throw new Error('capture failed');
      return {
        appName: 'Safari',
        windowId: 7,
        accessibilityText: '- AXWindow',
        screenshot: PNG,
      };
    });
    const service = new AppshotCaptureService(directory, () => native);

    const first = service.captureFrame();
    const second = service.captureFrame();
    await assert.rejects(first, /capture failed/u);
    await assert.doesNotReject(second);
    assert.equal(captures, 2);
    service.dispose();
  });

  it('stores bounded JPEG and PNG assets as private files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-appshot-store-'));
    cleanup.push(directory);
    const service = new AppshotCaptureService(directory, () =>
      fakeNative(async () => {
        throw new Error('unused');
      }),
    );
    const jpeg = Buffer.alloc(MAX_INPUT_IMAGE_FRAME_BYTES + 1);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;

    const jpegPath = await service.storeJpeg(jpeg);
    const pngPath = await service.storePng(PNG);

    assert.deepEqual(await readFile(jpegPath), jpeg);
    assert.deepEqual(await readFile(pngPath), PNG);
    assert.equal((await lstat(jpegPath)).mode & 0o077, 0);
    assert.equal((await lstat(pngPath)).mode & 0o077, 0);
    await assert.rejects(service.storeJpeg(Buffer.from('invalid')), /JPEG/u);
    await assert.rejects(
      service.storeJpeg(Buffer.alloc(MAX_CAPTURE_ASSET_BYTES + 1)),
      /JPEG/u,
    );
    await assert.rejects(service.storePng(Buffer.from('invalid')), /PNG/u);

    const invalidPath = join(directory, 'invalid.png');
    const writer = service as unknown as {
      writePrivateCapture: (path: string, image: Uint8Array) => Promise<void>;
    };
    await assert.rejects(
      writer.writePrivateCapture(invalidPath, new Uint8Array()),
      /invalid screenshot file/u,
    );
    await assert.rejects(lstat(invalidPath), { code: 'ENOENT' });
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
