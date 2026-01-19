import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.resolve(__dirname, 'fixtures');
const baseURL = pathToFileURL(`${fixturesPath}${path.sep}`).toString();
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
      .replace(
        '/Chromium.app/Contents/MacOS/Chromium',
        '/chrome-headless-shell',
      ),
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
  outputDir: path.resolve(__dirname, '..', 'test-results'), // 输出到父级的 test-results 目录
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    headless: true,
    launchOptions,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [
    [
      'html',
      { outputFolder: path.resolve(__dirname, '..', 'playwright-report') },
    ], // 输出HTML报告到父级的 playwright-report 目录
  ],
  retries: process.env.CI ? 1 : 0,
});
