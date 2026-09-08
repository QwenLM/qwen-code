import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CAPTURE_ASSET_BYTES } from '../shared/protocol.ts';
import {
  loadNativeAppshot,
  type NativeAppshot,
  type NativeAppshotCapture,
} from './native-appshot.ts';

const MAX_APP_NAME_CHARS = 512;
const MAX_WINDOW_TITLE_CHARS = 2_048;
const MAX_ACCESSIBILITY_TEXT_CHARS = 32_000;
const MAX_SCREENSHOT_BYTES = MAX_CAPTURE_ASSET_BYTES;
const CAPTURE_FILE_TTL_MS = 60_000;

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

export class AppshotCaptureService {
  private captureTail?: Promise<void>;
  private readonly cleanupTimers = new Map<NodeJS.Timeout, string>();

  constructor(
    private readonly captureDirectory = join(tmpdir(), 'qwen-live-appshot'),
    private readonly native: () => NativeAppshot = loadNativeAppshot,
  ) {}

  captureFrame(): Promise<AppshotFrame> {
    const capture = this.captureTail
      ? this.captureTail.then(() => this.captureFrameNow())
      : this.captureFrameNow();
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
