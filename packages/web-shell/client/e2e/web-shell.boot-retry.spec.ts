import { test } from '@playwright/test';
import { bootRetryScenarios } from './utils/bootRetryScenarios';

for (const scenario of bootRetryScenarios) {
  test(scenario.title, async ({ page }, testInfo) => {
    await scenario.run(page, testInfo);
  });
}
