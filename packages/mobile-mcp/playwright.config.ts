import { defineConfig } from '@playwright/test';

// These are plain Node tests (no browser). Playwright is used purely as the
// test runner, so no browser projects are configured.
export default defineConfig({
  testDir: './test',
  testMatch: '*.ts',

  // Device tests (android/ios/iphone-simulator) mutate real device state and
  // must run serially, exactly as they did under mocha's single process.
  workers: 1,
  fullyParallel: false,

  // Device operations include several multi-second sleeps; the 30s default is
  // too tight.
  timeout: 60_000,
});
