import { defineConfig } from 'vitest/config';
import { unhandledErrorExemption } from '../../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
  },
});
