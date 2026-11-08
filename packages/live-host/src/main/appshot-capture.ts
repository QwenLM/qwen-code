import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveMessage } from '@qwen-code/qwen-live/i18n';
import { MAX_CAPTURE_ASSET_BYTES } from '../shared/protocol.ts';
import {
  loadNativeAppshot,
  type NativeAppshot,
  type NativeAppshotCapture,
  type NativeDisplay,
  type NativeDisplayCapture,
} from './native-appshot.ts';

const MAX_APP_NAME_CHARS = 512;
const MAX_WINDOW_TITLE_CHARS = 2_048;
const MAX_ACCESSIBILITY_TEXT_CHARS = 32_000;
const MAX_SCREENSHOT_BYTES = MAX_CAPTURE_ASSET_BYTES;
const CAPTURE_FILE_TTL_MS = 60_000;
const DISPLAY_UUID =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

function isDisplayUuid(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === 36 && DISPLAY_UUID.test(value)
  );
}

export interface AppshotFrame {
  appName: string;
  windowTitle?: string;
  accessibilityText: string;
  screenshot: Uint8Array;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Native Appshot returned no ${field}.`);
  }
  return value.trim().slice(0, maximum);
}

export function validateNativeCapture(
  value: NativeAppshotCapture,
): AppshotFrame {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.windowId) ||
    value.windowId <= 0 ||
    !(value.screenshot instanceof Uint8Array) ||
    value.screenshot.byteLength <= 0 ||
    value.screenshot.byteLength > MAX_SCREENSHOT_BYTES
  ) {
    throw new Error('Native Appshot returned an invalid screenshot.');
  }
  const windowTitle =
    typeof value.windowTitle === 'string' && value.windowTitle.trim()
      ? value.windowTitle.trim().slice(0, MAX_WINDOW_TITLE_CHARS)
      : undefined;
  return {
    appName: boundedText(value.appName, MAX_APP_NAME_CHARS, 'application'),
    ...(windowTitle ? { windowTitle } : {}),
    accessibilityText: boundedText(
      value.accessibilityText,
      MAX_ACCESSIBILITY_TEXT_CHARS,
      'accessibility tree',
    ),
    screenshot: value.screenshot,
  };
}

export function validateNativeDisplayCapture(
  value: NativeDisplayCapture,
  requestedDisplay: string,
): NativeDisplayCapture {
  if (
    !value ||
    !isDisplayUuid(value.displayId) ||
    (requestedDisplay !== 'primary' &&
      value.displayId.toLowerCase() !== requestedDisplay.toLowerCase())
  )
    throw new Error(liveMessage('host.error.displayUnavailable'));
  const screenshot = value.screenshot;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    !(screenshot instanceof Uint8Array) ||
    screenshot.byteLength < 33 ||
    screenshot.byteLength > MAX_SCREENSHOT_BYTES ||
    signature.some((byte, index) => screenshot[index] !== byte)
  )
    throw new Error(liveMessage('host.error.displayCapture'));
  const header = new DataView(
    screenshot.buffer,
    screenshot.byteOffset,
    screenshot.byteLength,
  );
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) < 1 ||
    header.getUint32(16) > 1920 ||
    header.getUint32(20) < 1 ||
    header.getUint32(20) > 1080
  )
    throw new Error(liveMessage('host.error.displayCapture'));
  return { displayId: value.displayId.toLowerCase(), screenshot };
}

export class AppshotCaptureService {
  private captureTail?: Promise<void>;
  private readonly cleanupTimers = new Map<NodeJS.Timeout, string>();

  constructor(
    private readonly captureDirectory = join(tmpdir(), 'qwen-live-appshot'),
    private readonly native: () => NativeAppshot = loadNativeAppshot,
  ) {}

  captureFrame(): Promise<AppshotFrame> {
    return this.queueCapture(() => this.captureFrameNow());
  }

  listDisplays(): NativeDisplay[] {
    try {
      const displays = this.native().listDisplays();
      if (!Array.isArray(displays)) throw new Error('Invalid display list');
      const seen = new Set<string>();
      let primary = false;
      return displays.map((display) => {
        if (
          !display ||
          !isDisplayUuid(display.id) ||
          seen.has(display.id.toLowerCase()) ||
          typeof display.name !== 'string' ||
          !display.name.trim() ||
          !Number.isSafeInteger(display.width) ||
          display.width < 1 ||
          !Number.isSafeInteger(display.height) ||
          display.height < 1 ||
          typeof display.primary !== 'boolean' ||
          (display.primary && primary)
        )
          throw new Error('Invalid display');
        seen.add(display.id.toLowerCase());
        primary ||= display.primary;
        return {
          ...display,
          id: display.id.toLowerCase(),
          name: display.name.trim().slice(0, 256),
        };
      });
    } catch {
      throw new Error(liveMessage('host.error.displayList'));
    }
  }

  captureDisplayFrame(displayId = 'primary'): Promise<NativeDisplayCapture> {
    return this.queueCapture(async () => {
      if (displayId !== 'primary' && !isDisplayUuid(displayId))
        throw new Error(liveMessage('host.error.displayUnavailable'));
      let capture: NativeDisplayCapture;
      try {
        capture = await this.native().captureDisplay(displayId.toLowerCase());
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        throw new Error(
          liveMessage(
            code === 'DISPLAY_UNAVAILABLE'
              ? 'host.error.displayUnavailable'
              : code === 'DISPLAY_PERMISSION'
                ? 'runtime.screenPermission'
                : 'host.error.displayCapture',
          ),
        );
      }
      return validateNativeDisplayCapture(capture, displayId);
    });
  }

  private queueCapture<T>(captureNow: () => Promise<T>): Promise<T> {
    const capture = this.captureTail
      ? this.captureTail.then(captureNow)
      : captureNow();
    const tail = capture.then(
      () => undefined,
      () => undefined,
    );
    this.captureTail = tail;
    void tail.then(() => {
      if (this.captureTail === tail) this.captureTail = undefined;
    });
    return capture;
  }

  async storeJpeg(image: Uint8Array): Promise<string> {
    if (
      image.byteLength < 4 ||
      image.byteLength > MAX_SCREENSHOT_BYTES ||
      image[0] !== 0xff ||
      image[1] !== 0xd8 ||
      image[image.byteLength - 2] !== 0xff ||
      image[image.byteLength - 1] !== 0xd9
    ) {
      throw new Error('Camera returned an invalid JPEG screenshot.');
    }
    await this.prepareCaptureDirectory();
    const path = join(this.captureDirectory, `${randomUUID()}.jpg`);
    await this.writePrivateCapture(path, image);
    this.scheduleCleanup(path);
    return path;
  }

  async storePng(image: Uint8Array): Promise<string> {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      image.byteLength <= signature.length ||
      image.byteLength > MAX_SCREENSHOT_BYTES ||
      signature.some((byte, index) => image[index] !== byte)
    ) {
      throw new Error('Appshot returned an invalid PNG screenshot.');
    }
    await this.prepareCaptureDirectory();
    const path = join(this.captureDirectory, `${randomUUID()}.png`);
    await this.writePrivateCapture(path, image);
    this.scheduleCleanup(path);
    return path;
  }

  dispose(): void {
    for (const [timer, path] of this.cleanupTimers) {
      clearTimeout(timer);
      void unlink(path).catch(() => undefined);
    }
    this.cleanupTimers.clear();
  }

  private async captureFrameNow(): Promise<AppshotFrame> {
    return validateNativeCapture(await this.native().captureAppshot());
  }

  private scheduleCleanup(path: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      void unlink(path).catch(() => undefined);
    }, CAPTURE_FILE_TTL_MS);
    timer.unref?.();
    this.cleanupTimers.set(timer, path);
  }

  private async prepareCaptureDirectory(): Promise<void> {
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.captureDirectory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error('The Appshot capture directory is not private.');
    }
    await this.removeStaleCaptures();
  }

  private async writePrivateCapture(
    path: string,
    image: Uint8Array,
  ): Promise<void> {
    try {
      await writeFile(path, image, { flag: 'wx', mode: 0o600 });
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > MAX_SCREENSHOT_BYTES ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error('Appshot wrote an invalid screenshot file.');
      }
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  private async removeStaleCaptures(): Promise<void> {
    const entries = await readdir(this.captureDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (
          !entry.isFile() ||
          (!entry.name.endsWith('.png') && !entry.name.endsWith('.jpg'))
        )
          return;
        const path = join(this.captureDirectory, entry.name);
        const stat = await lstat(path).catch(() => undefined);
        if (stat && now - stat.mtimeMs > CAPTURE_FILE_TTL_MS) {
          await unlink(path).catch(() => undefined);
        }
      }),
    );
  }
}
