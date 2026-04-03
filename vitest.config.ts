import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/cli',
      'packages/core',
      'packages/sdk-typescript',
      'integration-tests',
      'scripts',
    ],
  },
});
