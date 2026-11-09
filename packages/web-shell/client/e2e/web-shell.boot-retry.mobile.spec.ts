import { test } from '@playwright/test';
import { bootRetryScenarios } from './utils/bootRetryScenarios';

// The mobile projects collect only `*.mobile.spec.ts`, and the retry's whole
// justification is engine independence: WebKit and device emulation are where
// the boot failures that motivated it were observed.
for (const scenario of bootRetryScenarios) {
  test(scenario.title, async ({ page }, testInfo) => {
    await scenario.run(page, testInfo);
  });
}
