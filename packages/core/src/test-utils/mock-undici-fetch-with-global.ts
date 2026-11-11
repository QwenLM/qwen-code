/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

// Business-level tests mock global fetch. Keep those tests transport-agnostic
// while Node dispatcher ownership is covered directly in fetch.test.ts.
vi.mock('undici/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici/index.js')>();
  return {
    ...actual,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const nativeInit = { ...(init ?? {}) } as RequestInit & {
        dispatcher?: unknown;
      };
      delete nativeInit.dispatcher;
      return globalThis.fetch(
        input instanceof URL ? input.href : input,
        nativeInit,
      );
    },
  };
});
