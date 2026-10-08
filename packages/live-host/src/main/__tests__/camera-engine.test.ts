import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HostCameraEngine } from '../../preload/camera-engine.ts';
import {
  MAX_INPUT_IMAGE_FRAME_BYTES,
  isValidInputImageFrame,
  isValidCameraSnapshotAsset,
} from '../../shared/protocol.ts';

function cameraEnvironment(
  options: {
    photoAvailable?: boolean;
    photoFailure?: boolean;
    nativeSizeAvailable?: boolean;
    automaticFrames?: boolean;
    takePhoto?: () => Promise<Blob>;
    restoreFailure?: boolean;
    negotiatedVideoSize?: { width: number; height: number };
    actualPhotoSize?: { width: number; height: number };
  } = {},
) {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  const photoSettings: PhotoSettings[] = [];
  const appliedConstraints: MediaTrackConstraints[] = [];
  const encodes: Array<{ width: number; height: number }> = [];
  const errors: string[] = [];
  let photoCaptures = 0;
  let bitmapCloses = 0;
  let cameraWidth = 1280;
  let cameraHeight = 720;
  let stopped = false;
  const previewConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
  const track = Object.assign(new EventTarget(), {
    getCapabilities: () =>
      options.nativeSizeAvailable === false
        ? {}
        : {
            width: { min: 640, max: 3840 },
            height: { min: 480, max: 2160 },
            resizeMode: ['none', 'crop-and-scale'],
          },
    getConstraints: () => structuredClone(previewConstraints),
    getSettings: () => ({ width: cameraWidth, height: cameraHeight }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedConstraints.push(structuredClone(constraints));
      if (options.restoreFailure && appliedConstraints.length > 1) {
        throw new Error('restore_failed');
      }
      cameraWidth = (constraints.width as ConstrainULongRange).ideal ?? 1280;
      cameraHeight = (constraints.height as ConstrainULongRange).ideal ?? 720;
      if (appliedConstraints.length === 1 && options.negotiatedVideoSize) {
        cameraWidth = options.negotiatedVideoSize.width;
        cameraHeight = options.negotiatedVideoSize.height;
      }
    },
    stop: () => {
      stopped = true;
      track.dispatchEvent(new Event('ended'));
    },
  });
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  let nextFrameId = 0;
  const frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  const presentFrame = (width: number, height: number) => {
    video.videoWidth = width;
    video.videoHeight = height;
    for (const [id, callback] of [...frameCallbacks]) {
      frameCallbacks.delete(id);
      callback(0, { width, height } as VideoFrameCallbackMetadata);
    }
  };
  const video = Object.assign(new EventTarget(), {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null as MediaStream | null,
    className: '',
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    parentElement: null,
    play: async () => undefined,
    remove: () => undefined,
    setAttribute: () => undefined,
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
      const id = ++nextFrameId;
      frameCallbacks.set(id, callback);
      if (options.automaticFrames !== false) {
        queueMicrotask(() => {
          if (frameCallbacks.has(id)) presentFrame(cameraWidth, cameraHeight);
        });
      }
      return id;
    },
    cancelVideoFrameCallback: (id: number) => frameCallbacks.delete(id),
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob: (callback: (blob: Blob) => void) => {
      encodes.push({ width: canvas.width, height: canvas.height });
      const jpeg = Buffer.alloc(
        Math.max(4, Math.round((canvas.width * canvas.height) / 12)),
      );
      jpeg[0] = 0xff;
      jpeg[1] = 0xd8;
      jpeg[jpeg.length - 2] = 0xff;
      jpeg[jpeg.length - 1] = 0xd9;
      callback(new Blob([jpeg], { type: 'image/jpeg' }));
    },
  };
  install('navigator', {
    mediaDevices: { getUserMedia: async () => stream },
  });
  install('document', {
    createElement: (tag: string) => (tag === 'video' ? video : canvas),
    querySelector: () => null,
  });
  install('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  install(
    'FileReader',
    class {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
          this.onload?.();
        });
      }
    },
  );
  install(
    'ImageCapture',
    options.photoAvailable === false
      ? undefined
      : class {
          getPhotoCapabilities() {
            return Promise.resolve({
              imageWidth: { max: 4032 },
              imageHeight: { max: 3024 },
            });
          }
          takePhoto(settings: PhotoSettings) {
            photoCaptures += 1;
            photoSettings.push(settings);
            if (options.photoFailure) {
              return Promise.reject(new Error('photo_not_supported'));
            }
            return options.takePhoto?.() ?? Promise.resolve(new Blob());
          }
        },
  );
  install('createImageBitmap', async (source: Blob | typeof video) => ({
    width:
      source instanceof Blob
        ? (options.actualPhotoSize?.width ?? 4032)
        : source.videoWidth,
    height:
      source instanceof Blob
        ? (options.actualPhotoSize?.height ?? 3024)
        : source.videoHeight,
    close: () => {
      bitmapCloses += 1;
    },
  }));
  const camera = new HostCameraEngine(
    () => undefined,
    () => undefined,
    (error) => errors.push(error),
  );
  return {
    camera,
    photoSettings,
    appliedConstraints,
    encodes,
    errors,
    video,
    presentFrame,
    photoCaptures: () => photoCaptures,
    bitmapCloses: () => bitmapCloses,
    stopped: () => stopped,
    start: () =>
      camera.setCapture(true, {
        epoch: 1,
        mode: 'on-demand',
        fps: 1,
        cameraWidth: 1280,
        cameraHeight: 720,
        liveWidth: 1280,
        liveHeight: 720,
      }),
    restore: () => {
      camera.dispose();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function flushCameraCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('HostCameraEngine', () => {
  it('rejects a native video snapshot negotiated below the advertised size and restores preview', async () => {
    const environment = cameraEnvironment({
      photoAvailable: false,
      negotiatedVideoSize: { width: 1280, height: 720 },
    });
    try {
      await environment.start();
      await assert.rejects(
        environment.camera.captureSnapshot(),
        /camera_snapshot_resolution_unavailable/,
      );
      assert.deepEqual(environment.encodes, []);
      assert.equal(environment.appliedConstraints.length, 2);
      assert.equal(environment.video.videoWidth, 1280);
    } finally {
      environment.restore();
    }
  });

  it('rejects an undersized native photo when native video fallback is also unavailable', async () => {
    const environment = cameraEnvironment({
      actualPhotoSize: { width: 1280, height: 720 },
      nativeSizeAvailable: false,
    });
    try {
      await environment.start();
      await assert.rejects(
        environment.camera.captureSnapshot(),
        /camera_snapshot_resolution_unavailable/,
      );
      assert.deepEqual(environment.encodes, []);
      assert.equal(environment.bitmapCloses(), 1);
    } finally {
      environment.restore();
    }
  });

  it('accepts full native dimensions rotated by 90 degrees', async () => {
    for (const options of [
      { actualPhotoSize: { width: 3024, height: 4032 } },
      {
        photoAvailable: false,
        negotiatedVideoSize: { width: 2160, height: 3840 },
      },
    ]) {
      const environment = cameraEnvironment(options);
      try {
        await environment.start();
        assert.ok((await environment.camera.captureSnapshot()).assetImage);
      } finally {
        environment.restore();
      }
    }
  });

  it('keeps explicitly bounded snapshots as aspect-preserving upper bounds', async () => {
    const environment = cameraEnvironment({
      photoAvailable: false,
      negotiatedVideoSize: { width: 1600, height: 1200 },
    });
    try {
      await environment.start();
      await environment.camera.captureSnapshot({
        snapshotWidth: 1920,
        snapshotHeight: 1080,
      });
      assert.deepEqual(environment.encodes[0], { width: 1440, height: 1080 });
    } finally {
      environment.restore();
    }
  });
  it('keeps a native still asset separately from its provider-size preview', async () => {
    const environment = cameraEnvironment();
    try {
      await environment.start();
      const result = await environment.camera.captureSnapshot();
      assert.equal(environment.photoCaptures(), 1);
      assert.deepEqual(environment.photoSettings, [
        { imageWidth: 4032, imageHeight: 3024 },
      ]);
      assert.deepEqual(environment.encodes[0], { width: 4032, height: 3024 });
      assert.ok(result.assetImage);
      assert.ok(isValidCameraSnapshotAsset(result.assetImage));
      assert.ok(
        Buffer.byteLength(result.assetImage, 'base64') >
          MAX_INPUT_IMAGE_FRAME_BYTES,
      );
      assert.ok(isValidInputImageFrame(result.image));
      assert.ok(result.width <= 1920 && result.height <= 1080);
      assert.equal(environment.bitmapCloses(), 1);
      assert.deepEqual(environment.appliedConstraints, []);
      assert.equal(environment.video.videoWidth, 1280);
    } finally {
      environment.restore();
    }
  });

  it('fits a still to snapshot bounds independently of the preview stream', async () => {
    const environment = cameraEnvironment();
    try {
      await environment.start();
      await environment.camera.captureSnapshot({
        snapshotWidth: 2560,
        snapshotHeight: 1440,
      });
      assert.deepEqual(environment.encodes[0], { width: 1920, height: 1440 });
      assert.equal(environment.video.videoWidth, 1280);
      assert.equal(environment.video.videoHeight, 720);
    } finally {
      environment.restore();
    }
  });

  it('samples private monitoring frames without taking photos or changing constraints', async () => {
    const environment = cameraEnvironment();
    try {
      await environment.start();
      const result = await environment.camera.captureSnapshot({
        persistAsset: false,
        snapshotWidth: 3840,
        snapshotHeight: 2160,
      });
      assert.equal(environment.photoCaptures(), 0);
      assert.deepEqual(environment.appliedConstraints, []);
      assert.equal(result.assetImage, undefined);
      assert.equal(result.width, 1280);
      assert.equal(result.height, 720);
      assert.ok(isValidInputImageFrame(result.image));
    } finally {
      environment.restore();
    }
  });

  it('falls back to a native video frame and restores preview constraints', async () => {
    const environment = cameraEnvironment({ photoFailure: true });
    try {
      await environment.start();
      const result = await environment.camera.captureSnapshot();
      assert.deepEqual(environment.encodes[0], { width: 3840, height: 2160 });
      assert.ok(result.assetImage);
      assert.deepEqual(environment.appliedConstraints, [
        {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          resizeMode: 'none',
        },
        { width: { ideal: 1280 }, height: { ideal: 720 } },
      ]);
      assert.equal(environment.video.videoWidth, 1280);
      assert.equal(environment.video.videoHeight, 720);
    } finally {
      environment.restore();
    }
  });

  it('waits for a fresh still frame and then a restored preview frame', async () => {
    const environment = cameraEnvironment({
      photoAvailable: false,
      automaticFrames: false,
    });
    try {
      await environment.start();
      let completed = false;
      const capture = environment.camera.captureSnapshot().then((frame) => {
        completed = true;
        return frame;
      });
      await flushCameraCallbacks();
      environment.presentFrame(1280, 720);
      await flushCameraCallbacks();
      assert.equal(completed, false);
      assert.deepEqual(environment.encodes, []);
      environment.presentFrame(3840, 2160);
      await flushCameraCallbacks();
      assert.equal(environment.appliedConstraints.length, 2);
      assert.equal(completed, false);
      environment.presentFrame(1280, 720);
      await capture;
      assert.equal(completed, true);
      assert.deepEqual(environment.encodes[0], { width: 3840, height: 2160 });
    } finally {
      environment.restore();
    }
  });

  it('rejects a native snapshot when neither photo nor native video size is available', async () => {
    const environment = cameraEnvironment({
      photoAvailable: false,
      nativeSizeAvailable: false,
    });
    try {
      await environment.start();
      await assert.rejects(
        environment.camera.captureSnapshot(),
        /camera_snapshot_resolution_unavailable/u,
      );
      assert.deepEqual(environment.encodes, []);
      assert.deepEqual(environment.appliedConstraints, []);
    } finally {
      environment.restore();
    }
  });

  it('discards a photo that completes after the camera is stopped', async () => {
    let finishPhoto: ((photo: Blob) => void) | undefined;
    const environment = cameraEnvironment({
      takePhoto: () =>
        new Promise<Blob>((resolve) => {
          finishPhoto = resolve;
        }),
    });
    try {
      await environment.start();
      const capture = environment.camera.captureSnapshot();
      await flushCameraCallbacks();
      environment.camera.dispose();
      finishPhoto?.(new Blob());
      await assert.rejects(capture, /camera_not_ready/u);
      assert.deepEqual(environment.encodes, []);
      assert.deepEqual(environment.errors, []);
    } finally {
      environment.restore();
    }
  });

  it('stops capture if fallback cannot restore the preview', async () => {
    const environment = cameraEnvironment({
      photoAvailable: false,
      restoreFailure: true,
    });
    try {
      await environment.start();
      await assert.rejects(
        environment.camera.captureSnapshot(),
        /restore_failed/u,
      );
      assert.deepEqual(environment.errors, ['camera_preview_restore_failed']);
      assert.equal(environment.stopped(), true);
      assert.equal(environment.bitmapCloses(), 1);
      assert.deepEqual(environment.encodes, []);
    } finally {
      environment.restore();
    }
  });

  it('deduplicates identical settings while camera permission is pending', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator',
    );
    let rejectOpen: ((error: Error) => void) | undefined;
    let openCount = 0;
    let requestedConstraints: MediaStreamConstraints | undefined;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: (constraints: MediaStreamConstraints) => {
            openCount += 1;
            requestedConstraints = constraints;
            return new Promise<MediaStream>((_resolve, reject) => {
              rejectOpen = reject;
            });
          },
        },
      },
    });

    try {
      const camera = new HostCameraEngine(
        () => undefined,
        () => undefined,
        () => undefined,
      );
      const settings = {
        epoch: 1,
        mode: 'on-demand' as const,
        fps: 1,
        cameraWidth: 960,
        cameraHeight: 540,
        liveWidth: 1280,
        liveHeight: 720,
      };

      const first = camera.setCapture(true, settings);
      await camera.setCapture(true, settings);

      assert.equal(openCount, 1);
      assert.deepEqual(requestedConstraints, {
        audio: false,
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
        },
      });
      rejectOpen?.(new Error('permission_pending'));
      await assert.rejects(first, /permission_pending/u);
      camera.dispose();
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  it('signals ready only after the camera has a decodable frame', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator',
    );
    const originalDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const track = Object.assign(new EventTarget(), { stop: () => undefined });
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const video = Object.assign(new EventTarget(), {
      autoplay: false,
      muted: false,
      playsInline: false,
      srcObject: null as MediaStream | null,
      className: '',
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      parentElement: null,
      play: () => Promise.resolve(),
      remove: () => undefined,
      setAttribute: () => undefined,
    }) as unknown as HTMLVideoElement;
    const canvas = {} as HTMLCanvasElement;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => (tag === 'video' ? video : canvas),
        querySelector: () => null,
      },
    });

    try {
      let ready = false;
      const camera = new HostCameraEngine(
        () => undefined,
        () => {
          ready = true;
        },
        () => undefined,
      );
      const started = camera.setCapture(true, {
        epoch: 1,
        mode: 'on-demand',
        fps: 1,
        cameraWidth: 1280,
        cameraHeight: 720,
        liveWidth: 1280,
        liveHeight: 720,
      });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(ready, false);

      Object.assign(video, {
        readyState: 2,
        videoWidth: 1280,
        videoHeight: 720,
      });
      video.dispatchEvent(new Event('loadeddata'));
      await started;
      assert.equal(ready, true);
      camera.dispose();
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    }
  });
});
