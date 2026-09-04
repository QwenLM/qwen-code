/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function isValidServerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 256 &&
    VALID_SERVER_NAME.test(name) &&
    !RESERVED_SERVER_NAMES.has(name)
  );
}
