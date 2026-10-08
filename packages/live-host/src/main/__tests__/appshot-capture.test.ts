import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AppshotCaptureService,
  validateNativeCapture,
  validateNativeDisplayCapture,
} from '../appshot-capture.ts';
import type { NativeAppshot } from '../native-appshot.ts';
import {
  MAX_CAPTURE_ASSET_BYTES,
  MAX_INPUT_IMAGE_FRAME_BYTES,
} from '../../shared/protocol.ts';

const cleanup: string[] = [];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const DISPLAY_ID = '11223344-5566-7788-99aa-bbccddeeff00';
const OTHER_DISPLAY_ID = '11223344-5566-7788-99aa-bbccddeeff11';
const DISPLAY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=',
  'base64',
);

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
    listDisplays: () => [],
    captureDisplay: async () => {
      throw new Error('not used');
    },
  };
}

describe('AppshotCaptureService', () => {
  it('lists display identities without invoking capture or permission requests', () => {
    const native = fakeNative(async () => {
      throw new Error('Appshot should not run');
    });
    native.listDisplays = () => [
      {
        id: DISPLAY_ID.toUpperCase(),
        name: '  Studio Display  ',
        width: 5120,
        height: 2880,
        primary: true,
      },
    ];
    native.requestAccessibility = () => {
      throw new Error('No AX prompt');
    };
    native.requestScreenRecording = () => {
      throw new Error('No recording prompt');
    };
    const service = new AppshotCaptureService(undefined, () => native);
    assert.deepEqual(service.listDisplays(), [
      {
        id: DISPLAY_ID,
        name: 'Studio Display',
        width: 5120,
        height: 2880,
        primary: true,
      },
    ]);
    native.listDisplays = () => [
      {
        id: DISPLAY_ID,
        name: 'Display',
        width: 5120,
        height: 2880,
        primary: true,
      },
      {
        id: DISPLAY_ID.toUpperCase(),
        name: 'Duplicate',
        width: 1920,
        height: 1080,
        primary: false,
      },
    ];
    assert.throws(() => service.listDisplays(), /host.error.displayList/u);
    service.dispose();
  });

  it('captures the exact display with no AX/window fallback and canonical identity', async () => {
    const selections: string[] = [];
    const native = fakeNative(async () => {
      throw new Error('No window fallback');
    });
    native.getPermissionState = () => {
      throw new Error('No AX readiness gate');
    };
    native.captureDisplay = async (selection) => {
      selections.push(selection);
      return { displayId: DISPLAY_ID.toUpperCase(), screenshot: DISPLAY_PNG };
    };
    const service = new AppshotCaptureService(undefined, () => native);
    assert.deepEqual(
      await service.captureDisplayFrame(DISPLAY_ID.toUpperCase()),
      { displayId: DISPLAY_ID, screenshot: DISPLAY_PNG },
    );
    assert.deepEqual(await service.captureDisplayFrame(), {
      displayId: DISPLAY_ID,
      screenshot: DISPLAY_PNG,
    });
    assert.deepEqual(selections, [DISPLAY_ID, 'primary']);
    await assert.rejects(
      service.captureDisplayFrame('foreground'),
      /host.error.displayUnavailable/u,
    );
    await assert.rejects(
      service.captureDisplayFrame(`${DISPLAY_ID}\n`),
      /host.error.displayUnavailable/u,
    );
    await assert.rejects(
      service.captureDisplayFrame(OTHER_DISPLAY_ID),
      /host.error.displayUnavailable/u,
    );
    assert.equal(selections.length, 3);
    service.dispose();
  });

  it('shares one capture queue between display frames and original Appshot, including rejection', async () => {
    let finish!: () => void;
    const order: string[] = [];
    const native = fakeNative(async () => {
      order.push('window');
      return {
        appName: 'Editor',
        windowId: 1,
        accessibilityText: '- AXWindow',
        screenshot: PNG,
      };
    });
    native.captureDisplay = async () => {
      order.push('display');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw Object.assign(new Error('No display'), {
        code: 'DISPLAY_UNAVAILABLE',
      });
    };
    const service = new AppshotCaptureService(undefined, () => native);
    const first = service.captureDisplayFrame(DISPLAY_ID);
    const second = service.captureFrame();
    assert.deepEqual(order, ['display']);
    finish();
    await assert.rejects(first, /host.error.displayUnavailable/u);
    assert.equal((await second).appName, 'Editor');
    assert.deepEqual(order, ['display', 'window']);
    service.dispose();
  });

  it('returns localized display errors without leaking native messages', async () => {
    const native = fakeNative(async () => {
      throw new Error('No fallback');
    });
    const service = new AppshotCaptureService(undefined, () => native);
    for (const [code, expected] of [
      ['DISPLAY_PERMISSION', 'runtime.screenPermission'],
      ['DISPLAY_UNAVAILABLE', 'host.error.displayUnavailable'],
      ['unknown', 'host.error.displayCapture'],
    ]) {
      native.captureDisplay = async () => {
        throw Object.assign(new Error('private backend detail'), { code });
      };
      await assert.rejects(
        service.captureDisplayFrame(),
        (error: Error) =>
          error.message.includes(expected!) &&
          !error.message.includes('private'),
      );
    }
    service.dispose();
  });

  it('rejects invalid display PNGs and dimensions before passing them to image decoding', () => {
    assert.deepEqual(
      validateNativeDisplayCapture(
        { displayId: DISPLAY_ID, screenshot: DISPLAY_PNG },
        'primary',
      ).screenshot,
      DISPLAY_PNG,
    );
    const oversizedDimensions = Buffer.from(DISPLAY_PNG);
    oversizedDimensions.writeUInt32BE(1921, 16);
    for (const screenshot of [
      PNG,
      Buffer.alloc(MAX_CAPTURE_ASSET_BYTES + 1),
      oversizedDimensions,
    ])
      assert.throws(
        () =>
          validateNativeDisplayCapture(
            { displayId: DISPLAY_ID, screenshot },
            DISPLAY_ID,
          ),
        /host.error.displayCapture/u,
      );
    assert.throws(
      () =>
        validateNativeDisplayCapture(
          { displayId: OTHER_DISPLAY_ID, screenshot: DISPLAY_PNG },
          DISPLAY_ID,
        ),
      /host.error.displayUnavailable/u,
    );
    assert.throws(
      () =>
        validateNativeDisplayCapture(
          { displayId: `${DISPLAY_ID}\n`, screenshot: DISPLAY_PNG },
          'primary',
        ),
      /host.error.displayUnavailable/u,
    );
  });

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
