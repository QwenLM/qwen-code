#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const baseUrl =
  process.argv[2] || process.env.QWEN_WEB_SMOKE_URL || 'http://127.0.0.1:5174';
const endpoints = ['/capabilities', '/workspace/providers'];

try {
  new URL(baseUrl);
} catch {
  console.error(`[web-smoke] Invalid base URL: ${baseUrl}`);
  process.exit(1);
}

let failed = false;

for (const endpoint of endpoints) {
  const url = new URL(endpoint, baseUrl);
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error(
        `expected JSON, got ${contentType || 'missing content-type'}`,
      );
    }
    await response.json();
    console.log(`[web-smoke] ${url.href} OK`);
  } catch (error) {
    failed = true;
    console.error(
      `[web-smoke] ${url.href} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

if (failed) {
  console.error(
    '[web-smoke] Web dev server is not proxying daemon JSON endpoints. Start from the repo root with npm run dev:web, or pass the correct web URL.',
  );
  process.exit(1);
}

console.log(`[web-smoke] ${baseUrl} proxy checks passed.`);
