import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadNativeAppshot,
  type NativeAppshot,
  type NativeAppshotCapture,
} from './native-appshot.ts';

const MAX_APP_NAME_CHARS = 512;
const MAX_WINDOW_TITLE_CHARS = 2_048;
const MAX_ACCESSIBILITY_TEXT_CHARS = 32_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const CAPTURE_FILE_TTL_MS = 60_000;

export interface AppshotCapture {
  appName: string;
  windowTitle?: string;
  accessibilityText: string;
  screenshotPath: string;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Native Appshot returned no ${field}.`);
  }
  return value.trim().slice(0, maximum);
}

export function validateNativeCapture(
  value: NativeAppshotCapture,
): Omit<AppshotCapture, 'screenshotPath'> & { screenshot: Uint8Array } {
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
  private capturing = false;
  private readonly cleanupTimers = new Map<NodeJS.Timeout, string>();

  constructor(
    private readonly captureDirectory = join(tmpdir(), 'qwen-live-appshot'),
    private readonly native: () => NativeAppshot = loadNativeAppshot,
  ) {}

  async capture(): Promise<AppshotCapture> {
    if (this.capturing) {
      throw new Error('An Appshot capture is already in progress.');
    }
    this.capturing = true;
    let screenshotPath: string | undefined;
    try {
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

      const capture = validateNativeCapture(
        await this.native().captureAppshot(),
      );
      screenshotPath = join(this.captureDirectory, `${randomUUID()}.png`);
      await writeFile(screenshotPath, capture.screenshot, {
        flag: 'wx',
        mode: 0o600,
      });
      const stat = await lstat(screenshotPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > MAX_SCREENSHOT_BYTES ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error('Native Appshot wrote an invalid screenshot file.');
      }
      const result: AppshotCapture = {
        appName: capture.appName,
        ...(capture.windowTitle ? { windowTitle: capture.windowTitle } : {}),
        accessibilityText: capture.accessibilityText,
        screenshotPath,
      };
      this.scheduleCleanup(screenshotPath);
      screenshotPath = undefined;
      return result;
    } finally {
      this.capturing = false;
      if (screenshotPath) await unlink(screenshotPath).catch(() => undefined);
    }
  }

  dispose(): void {
    for (const [timer, path] of this.cleanupTimers) {
      clearTimeout(timer);
      void unlink(path).catch(() => undefined);
    }
    this.cleanupTimers.clear();
  }

  private scheduleCleanup(path: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      void unlink(path).catch(() => undefined);
    }, CAPTURE_FILE_TTL_MS);
    timer.unref?.();
    this.cleanupTimers.set(timer, path);
  }

  private async removeStaleCaptures(): Promise<void> {
    const entries = await readdir(this.captureDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.png')) return;
        const path = join(this.captureDirectory, entry.name);
        const stat = await lstat(path).catch(() => undefined);
        if (stat && now - stat.mtimeMs > CAPTURE_FILE_TTL_MS) {
          await unlink(path).catch(() => undefined);
        }
      }),
    );
  }
}
