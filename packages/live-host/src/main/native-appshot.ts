import { createRequire } from 'node:module';
import { join } from 'node:path';

export type NativeAppshotPermissions = {
  accessibility: boolean;
  screenRecording: boolean;
};

export type NativeAppshotCapture = {
  appName: string;
  bundleIdentifier?: string;
  windowTitle?: string;
  windowId: number;
  accessibilityText: string;
  screenshot: Uint8Array;
};

export type NativeAppshot = {
  getPermissionState: () => NativeAppshotPermissions;
  requestAccessibility: () => boolean;
  requestScreenRecording: () => boolean;
  captureAppshot: () => Promise<NativeAppshotCapture>;
};

let loaded: NativeAppshot | undefined;
const moduleDirectory =
  typeof __dirname === 'string'
    ? __dirname
    : join(process.cwd(), 'src', 'main');
const require = createRequire(join(moduleDirectory, 'main.cjs'));

function addonPath(): string {
  const { app } = require('electron') as typeof import('electron');
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'qwen-live-appshot.node')
    : join(moduleDirectory, 'native', 'qwen-live-appshot.node');
}

export function loadNativeAppshot(): NativeAppshot {
  if (loaded) return loaded;
  loaded = require(addonPath()) as NativeAppshot;
  return loaded;
}
