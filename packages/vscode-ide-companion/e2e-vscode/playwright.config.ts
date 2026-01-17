import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chromiumExecutablePath = (() => {
  const defaultPath = chromium.executablePath();
  const candidates = [defaultPath];

  if (defaultPath.includes('mac-x64')) {
    candidates.push(defaultPath.replace('mac-x64', 'mac-arm64'));
  }

  const headlessCandidates = candidates.map((candidate) =>
    candidate
      .replace('/chromium-', '/chromium_headless_shell-')
      .replace('/chrome-mac-x64/', '/chrome-headless-shell-mac-x64/')
      .replace('/chrome-mac-arm64/', '/chrome-headless-shell-mac-arm64/')
      .replace(
        '/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/chrome-headless-shell',
      )
      .replace('/Chromium.app/Contents/MacOS/Chromium', '/chrome-headless-shell'),
  );

  for (const candidate of [...headlessCandidates, ...candidates]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
})();
const launchOptions = chromiumExecutablePath
  ? { executablePath: chromiumExecutablePath }
  : {};

export default defineConfig({
  testDir: path.resolve(__dirname, 'tests'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    launchOptions,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
});
