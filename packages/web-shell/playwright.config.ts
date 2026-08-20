import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['PLAYWRIGHT_PORT'] ?? 5174);
const baseURL =
  process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './client/e2e',
  // The visuals suite (screenshot/video capture) runs under its own
  // playwright.visuals.config.ts; keep it out of the smoke/e2e runs.
  testIgnore: '**/visuals/**',
  outputDir: './client/e2e/test-results',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: [
    ['line'],
    ['html', { outputFolder: 'client/e2e/playwright-report', open: 'never' }],
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/visuals/**', '**/*.mobile.spec.ts'],
    },
    {
      // Touch-device emulation for the mobile composer backend (#5958):
      // coarse pointer + no hover + touch points, which flips the composer
      // to the plain-textarea path.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      testMatch: '**/*.mobile.spec.ts',
    },
  ],
});
