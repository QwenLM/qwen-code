import {
  MAX_INPUT_IMAGE_FRAME_BYTES,
  MAX_CAPTURE_ASSET_BYTES,
  MAX_VISUAL_HEIGHT,
  MAX_VISUAL_WIDTH,
  MIN_VISUAL_HEIGHT,
  MIN_VISUAL_WIDTH,
  fitRealtimeVisualDimensions,
  type VisualMode,
} from '../shared/protocol.ts';

const LIVE_JPEG_ATTEMPTS = [
  { scale: 1, quality: 0.65 },
  { scale: 1, quality: 0.45 },
  { scale: 1, quality: 0.3 },
  { scale: 0.75, quality: 0.55 },
  { scale: 0.75, quality: 0.35 },
  { scale: 0.5, quality: 0.5 },
  { scale: 0.5, quality: 0.3 },
] as const;
const SNAPSHOT_JPEG_QUALITIES = [0.9, 0.8, 0.65, 0.5, 0.35, 0.2, 0.1] as const;
const CAMERA_PREVIEW_SELECTOR = '[data-live-camera-preview]';
const CAMERA_READY_TIMEOUT_MS = 10_000;
const HAVE_CURRENT_DATA = 2;

type CameraDiagnosticDetails = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface CameraCaptureSettings {
  epoch: number;
  mode: VisualMode;
  fps: number;
  cameraWidth: number;
  cameraHeight: number;
  liveWidth: number;
  liveHeight: number;
}

export interface CameraSnapshotOptions {
  persistAsset?: boolean;
  snapshotWidth?: number;
  snapshotHeight?: number;
}

export interface CameraFrame {
  epoch: number;
  image: string;
  width: number;
  height: number;
}

export interface CameraSnapshot extends CameraFrame {
  assetImage?: string;
}

function cameraErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name;
  if (error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)) {
    return error.message.slice(0, 128);
  }
  return 'camera_unavailable';
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error('jpeg_read_failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator < 0) {
        reject(new Error('jpeg_encode_failed'));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function cameraFrameReady(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

function waitForCameraFrame(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  if (cameraFrameReady(video)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const tracks = stream.getVideoTracks();
    const cleanup = () => {
      clearTimeout(timer);
      for (const event of ['loadeddata', 'canplay', 'playing', 'resize']) {
        video.removeEventListener(event, check);
      }
      video.removeEventListener('error', fail);
      for (const track of tracks) {
        track.removeEventListener('ended', ended);
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (cameraFrameReady(video)) finish();
    };
    const fail = () => finish(new Error('camera_video_unavailable'));
    const ended = () => finish(new Error('camera_track_ended'));
    const timer = setTimeout(
      () => finish(new Error('camera_ready_timeout')),
      CAMERA_READY_TIMEOUT_MS,
    );
    for (const event of ['loadeddata', 'canplay', 'playing', 'resize']) {
      video.addEventListener(event, check);
    }
    video.addEventListener('error', fail, { once: true });
    for (const track of tracks) {
      track.addEventListener('ended', ended, { once: true });
    }
    check();
  });
}

function waitForFreshCameraFrame(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const track = stream.getVideoTracks()[0];
    let callbackId: number;
    const cleanup = () => {
      clearTimeout(timer);
      video.cancelVideoFrameCallback(callbackId);
      track?.removeEventListener('ended', ended);
    };
    const ended = () => {
      cleanup();
      reject(new Error('camera_track_ended'));
    };
    const check = () => {
      const settings = track?.getSettings();
      if (
        cameraFrameReady(video) &&
        (!settings?.width || settings.width === video.videoWidth) &&
        (!settings?.height || settings.height === video.videoHeight)
      ) {
        cleanup();
        resolve();
      } else {
        callbackId = video.requestVideoFrameCallback(check);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('camera_snapshot_frame_timeout'));
    }, 2_000);
    track?.addEventListener('ended', ended, { once: true });
    callbackId = video.requestVideoFrameCallback(check);
  });
}

function fitSnapshotDimensions(
  width: number,
  height: number,
  options: CameraSnapshotOptions,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    (options.snapshotWidth ?? width) / width,
    (options.snapshotHeight ?? height) / height,
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function matchesNativeDimensions(
  image: ImageBitmap,
  width: number,
  height: number,
): boolean {
  return (
    (image.width === width && image.height === height) ||
    (image.width === height && image.height === width)
  );
}

export class HostCameraEngine {
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private captureInFlight = false;
  private generation = 0;
  private settings: CameraCaptureSettings | undefined;

  constructor(
    private readonly onFrame: (frame: CameraFrame) => void,
    private readonly onReady: (epoch: number) => void,
    private readonly onError: (code: string) => void,
    private readonly onDiagnostic: (
      event: string,
      details: CameraDiagnosticDetails,
    ) => void = () => {},
  ) {}

  attachPreview(): void {
    const slot = document.querySelector<HTMLElement>(CAMERA_PREVIEW_SELECTOR);
    if (!slot || !this.video) return;
    if (this.video.parentElement !== slot) slot.replaceChildren(this.video);
  }

  async setCapture(
    enabled: boolean,
    settings?: CameraCaptureSettings,
  ): Promise<void> {
    if (!enabled) {
      this.dispose();
      return;
    }
    if (!settings || !this.isValidSettings(settings)) {
      throw new Error('camera_capture_configuration_invalid');
    }
    if (this.sameSettings(settings)) return;

    this.dispose();
    const generation = this.generation;
    this.settings = { ...settings };
    const requestedWidth = settings.cameraWidth;
    const requestedHeight = settings.cameraHeight;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: requestedWidth },
          height: { ideal: requestedHeight },
        },
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.settings = undefined;
      throw error;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.className = 'camera-preview-video';
    this.stream = stream;
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.attachPreview();
    try {
      await video.play();
      await waitForCameraFrame(video, stream);
    } catch (error) {
      if (generation !== this.generation) return;
      this.dispose();
      throw error;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    video.setAttribute('aria-hidden', 'true');
    this.onDiagnostic('camera_capture_started', {
      epoch: settings.epoch,
      mode: settings.mode,
      fps: settings.fps,
      requestedWidth,
      requestedHeight,
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
    });
    this.onReady(settings.epoch);
    for (const track of stream.getVideoTracks()) {
      track.addEventListener(
        'ended',
        () => this.fail(generation, 'camera_track_ended'),
        { once: true },
      );
    }
    if (settings.mode === 'live-feed') {
      const emit = () => {
        void this.encodeFrame(generation, true)
          .then((frame) => {
            if (frame) this.onFrame(frame);
          })
          .catch((error: unknown) => {
            this.fail(generation, cameraErrorCode(error));
          });
      };
      emit();
      this.timer = setInterval(emit, Math.round(1000 / settings.fps));
    }
  }

  async captureSnapshot(
    options: CameraSnapshotOptions = {},
  ): Promise<CameraSnapshot> {
    const settings = this.settings;
    if (!settings || settings.mode !== 'on-demand') {
      throw new Error('camera_not_in_on_demand_mode');
    }
    if (options.persistAsset === false) {
      const frame = await this.encodeFrame(this.generation, false);
      if (!frame) throw new Error('camera_not_ready');
      return frame;
    }
    if (!this.isValidSnapshotSize(options)) {
      throw new Error('camera_snapshot_configuration_invalid');
    }
    if (this.captureInFlight || !this.stream || !this.video) {
      throw new Error('camera_not_ready');
    }
    this.captureInFlight = true;
    const generation = this.generation;
    let photo: ImageBitmap | undefined;
    try {
      photo = await this.captureStill(generation, options);
      this.assertCurrent(generation);
      const size = fitSnapshotDimensions(photo.width, photo.height, options);
      const asset = await this.encodeJpeg(
        generation,
        photo,
        size.width,
        size.height,
        MAX_CAPTURE_ASSET_BYTES,
        SNAPSHOT_JPEG_QUALITIES.map((quality) => ({ scale: 1, quality })),
      );
      const previewSize = fitRealtimeVisualDimensions(size.width, size.height);
      const frame = await this.encodeJpeg(
        generation,
        photo,
        previewSize.width,
        previewSize.height,
        MAX_INPUT_IMAGE_FRAME_BYTES,
        LIVE_JPEG_ATTEMPTS,
      );
      this.onDiagnostic('camera_snapshot_encoded', {
        epoch: settings.epoch,
        width: size.width,
        height: size.height,
        bytes: Math.floor((asset.image.length * 3) / 4),
        previewWidth: frame.width,
        previewHeight: frame.height,
      });
      return { epoch: settings.epoch, ...frame, assetImage: asset.image };
    } finally {
      photo?.close();
      if (generation === this.generation) this.captureInFlight = false;
    }
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.stream = undefined;
    this.video = undefined;
    this.canvas = undefined;
    this.captureInFlight = false;
    this.settings = undefined;
  }

  private async encodeFrame(
    generation: number,
    liveFeed: boolean,
  ): Promise<CameraFrame | undefined> {
    const video = this.video;
    const canvas = this.canvas;
    const settings = this.settings;
    if (
      generation !== this.generation ||
      this.captureInFlight ||
      !video ||
      !canvas ||
      !settings ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return undefined;
    }

    this.captureInFlight = true;
    try {
      const { width: baseWidth, height: baseHeight } =
        fitRealtimeVisualDimensions(
          video.videoWidth,
          video.videoHeight,
          settings.liveWidth,
          settings.liveHeight,
        );
      const frame = await this.encodeJpeg(
        generation,
        video,
        baseWidth,
        baseHeight,
        MAX_INPUT_IMAGE_FRAME_BYTES,
        LIVE_JPEG_ATTEMPTS,
      );
      this.onDiagnostic('camera_frame_encoded', {
        epoch: settings.epoch,
        mode: liveFeed ? 'live-feed' : 'on-demand',
        width: frame.width,
        height: frame.height,
        bytes: Math.floor((frame.image.length * 3) / 4),
      });
      return { epoch: settings.epoch, ...frame };
    } finally {
      if (generation === this.generation) this.captureInFlight = false;
    }
  }

  private async encodeJpeg(
    generation: number,
    source: CanvasImageSource,
    width: number,
    height: number,
    maximumBytes: number,
    attempts: ReadonlyArray<{ scale: number; quality: number }>,
  ): Promise<{ image: string; width: number; height: number }> {
    const canvas = this.canvas;
    if (!canvas) throw new Error('camera_not_ready');
    for (const attempt of attempts) {
      this.assertCurrent(generation);
      canvas.width = Math.max(1, Math.round(width * attempt.scale));
      canvas.height = Math.max(1, Math.round(height * attempt.scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('camera_canvas_unavailable');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', attempt.quality);
      });
      this.assertCurrent(generation);
      if (!jpeg || jpeg.size === 0) throw new Error('jpeg_encode_failed');
      if (jpeg.size > maximumBytes) continue;
      const image = await blobBase64(jpeg);
      this.assertCurrent(generation);
      return { image, width: canvas.width, height: canvas.height };
    }
    throw new Error('camera_frame_too_large');
  }

  private async captureStill(
    generation: number,
    options: CameraSnapshotOptions,
  ): Promise<ImageBitmap> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) throw new Error('camera_not_ready');
    if (typeof ImageCapture !== 'undefined') {
      let photo: ImageBitmap | undefined;
      try {
        const capture = new ImageCapture(track);
        const capabilities = await capture.getPhotoCapabilities();
        this.assertCurrent(generation);
        const width = capabilities.imageWidth?.max;
        const height = capabilities.imageHeight?.max;
        if (
          typeof width !== 'number' ||
          !Number.isFinite(width) ||
          width <= 0 ||
          typeof height !== 'number' ||
          !Number.isFinite(height) ||
          height <= 0
        ) {
          throw new Error('camera_photo_resolution_unavailable');
        }
        const blob = await capture.takePhoto({
          imageWidth: width,
          imageHeight: height,
        });
        this.assertCurrent(generation);
        photo = await createImageBitmap(blob);
        this.assertCurrent(generation);
        if (
          options.snapshotWidth === undefined &&
          options.snapshotHeight === undefined &&
          !matchesNativeDimensions(photo, width, height)
        ) {
          throw new Error('camera_snapshot_resolution_unavailable');
        }
        return photo;
      } catch (error) {
        photo?.close();
        this.assertCurrent(generation);
        this.onDiagnostic('camera_photo_fallback', {
          code: cameraErrorCode(error),
        });
      }
    }
    return this.captureVideoStill(generation, track, options);
  }

  private async captureVideoStill(
    generation: number,
    track: MediaStreamTrack,
    options: CameraSnapshotOptions,
  ): Promise<ImageBitmap> {
    const video = this.video;
    const stream = this.stream;
    if (!video || !stream) throw new Error('camera_not_ready');
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & {
      resizeMode?: string[];
    };
    const width = options.snapshotWidth ?? capabilities.width?.max;
    const height = options.snapshotHeight ?? capabilities.height?.max;
    if (!width || !height) {
      throw new Error('camera_snapshot_resolution_unavailable');
    }
    const previewConstraints = track.getConstraints();
    let photo: ImageBitmap | undefined;
    try {
      await track.applyConstraints({
        ...previewConstraints,
        width: { ideal: width },
        height: { ideal: height },
        ...(capabilities.resizeMode?.includes('none')
          ? { resizeMode: 'none' }
          : {}),
      });
      this.assertCurrent(generation);
      await waitForFreshCameraFrame(video, stream);
      this.assertCurrent(generation);
      photo = await createImageBitmap(video);
      this.assertCurrent(generation);
      if (
        options.snapshotWidth === undefined &&
        options.snapshotHeight === undefined &&
        !matchesNativeDimensions(photo, width, height)
      ) {
        throw new Error('camera_snapshot_resolution_unavailable');
      }
      return photo;
    } catch (error) {
      photo?.close();
      throw error;
    } finally {
      if (generation === this.generation) {
        try {
          await track.applyConstraints(previewConstraints);
          this.assertCurrent(generation);
          await waitForFreshCameraFrame(video, stream);
          this.assertCurrent(generation);
        } catch (error) {
          photo?.close();
          this.fail(generation, 'camera_preview_restore_failed');
          throw error;
        }
      }
    }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('camera_not_ready');
  }

  private isValidSnapshotSize(options: CameraSnapshotOptions): boolean {
    return (
      (options.snapshotWidth === undefined &&
        options.snapshotHeight === undefined) ||
      (Number.isInteger(options.snapshotWidth) &&
        Number.isInteger(options.snapshotHeight) &&
        Number(options.snapshotWidth) >= MIN_VISUAL_WIDTH &&
        Number(options.snapshotWidth) <= MAX_VISUAL_WIDTH &&
        Number(options.snapshotHeight) >= MIN_VISUAL_HEIGHT &&
        Number(options.snapshotHeight) <= MAX_VISUAL_HEIGHT)
    );
  }

  private isValidSettings(settings: CameraCaptureSettings): boolean {
    return (
      Number.isSafeInteger(settings.epoch) &&
      settings.epoch >= 0 &&
      (settings.mode === 'on-demand' || settings.mode === 'live-feed') &&
      Number.isFinite(settings.fps) &&
      settings.fps >= 0.1 &&
      settings.fps <= 10 &&
      Number.isInteger(settings.cameraWidth) &&
      settings.cameraWidth >= MIN_VISUAL_WIDTH &&
      settings.cameraWidth <= 3840 &&
      Number.isInteger(settings.cameraHeight) &&
      settings.cameraHeight >= MIN_VISUAL_HEIGHT &&
      settings.cameraHeight <= 2160 &&
      Number.isInteger(settings.liveWidth) &&
      settings.liveWidth >= MIN_VISUAL_WIDTH &&
      settings.liveWidth <= 3840 &&
      Number.isInteger(settings.liveHeight) &&
      settings.liveHeight >= MIN_VISUAL_HEIGHT &&
      settings.liveHeight <= 2160
    );
  }

  private sameSettings(settings: CameraCaptureSettings): boolean {
    const current = this.settings;
    return Boolean(
      current &&
        current.epoch === settings.epoch &&
        current.mode === settings.mode &&
        current.fps === settings.fps &&
        current.cameraWidth === settings.cameraWidth &&
        current.cameraHeight === settings.cameraHeight &&
        current.liveWidth === settings.liveWidth &&
        current.liveHeight === settings.liveHeight,
    );
  }

  private fail(generation: number, code: string): void {
    if (generation !== this.generation) return;
    this.dispose();
    this.onError(code);
  }
}
