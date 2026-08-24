/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { QWEN_SERVER_TOKEN_ENV } from './channel-worker-env.js';

export function resolveServeToken(
  optionToken: string | undefined,
  environmentToken: string | undefined = process.env[QWEN_SERVER_TOKEN_ENV],
): string | undefined {
  // Select before trimming so an explicitly supplied empty option continues
  // to shadow the environment, matching the existing daemon contract.
  const selected = optionToken ?? environmentToken;
  const trimmed = selected?.trim();
  return trimmed ? trimmed : undefined;
}
