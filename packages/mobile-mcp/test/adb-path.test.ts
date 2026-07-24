import { test, expect } from '@playwright/test';
import path from 'node:path';
import { getAdbPath } from '../src/android';

// getAdbPath must key off `process.platform` (the real runtime platform),
// not `process.env.platform` (an env var that is essentially never set, so
// it always fell through to the non-Windows 'adb' name). On Windows with
// ANDROID_HOME set that produced a `.../platform-tools/adb` path with no
// `.exe`, which execFileSync cannot resolve (PATHEXT is not applied),
// breaking Android automation on Windows.

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  // Capture the full original descriptor so the restore preserves its
  // attributes (enumerable/writable), rather than leaving behind a plain
  // { configurable, value } descriptor that would leak to later tests.
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    fn();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    } else {
      delete (process as unknown as { platform?: NodeJS.Platform }).platform;
    }
  }
}

function withAndroidHome(value: string, fn: () => void): void {
  const original = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = value;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.ANDROID_HOME;
    } else {
      process.env.ANDROID_HOME = original;
    }
  }
}

test('resolves adb.exe under ANDROID_HOME on win32', () => {
  withAndroidHome(path.join('C:', 'Android', 'Sdk'), () => {
    withPlatform('win32', () => {
      const resolved = getAdbPath();
      expect(resolved.endsWith('adb.exe')).toBe(true);
    });
  });
});

test('resolves plain adb (no .exe) under ANDROID_HOME on non-win32', () => {
  withAndroidHome('/opt/android-sdk', () => {
    withPlatform('linux', () => {
      const resolved = getAdbPath();
      expect(resolved.endsWith('adb.exe')).toBe(false);
      expect(resolved.endsWith('adb')).toBe(true);
    });
  });
});

test('resolves adb.exe on the win32 fallthrough (no ANDROID_HOME, no LOCALAPPDATA)', () => {
  // With neither ANDROID_HOME nor LOCALAPPDATA set, getAdbPath falls through
  // to `return exeName`, which must be 'adb.exe' on win32 — guards the bare
  // executable name the fix produces on that path.
  const originalLocalAppData = process.env.LOCALAPPDATA;
  delete process.env.LOCALAPPDATA;
  try {
    withAndroidHome('', () => {
      withPlatform('win32', () => {
        expect(getAdbPath()).toBe('adb.exe');
      });
    });
  } finally {
    if (originalLocalAppData !== undefined) {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  }
});
