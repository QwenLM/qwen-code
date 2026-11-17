/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export function isScreenDisplayId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'primary' ||
      (value.length === 36 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          value,
        )))
  );
}
