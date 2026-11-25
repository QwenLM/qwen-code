/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { deterministicUUID } from './deterministicUuid.js';

describe('deterministicUUID', () => {
  it('preserves the existing AI event ID encoding', () => {
    expect(deterministicUUID(['ai_code.change', 'change-1'])).toBe(
      '42724fa9-0a31-5d3d-9bef-37b05a02d8f8',
    );
  });

  it('frames parts and emits an RFC 4122 v5-shaped UUID', () => {
    const id = deterministicUUID(['a', 'bc']);

    expect(id).not.toBe(deterministicUUID(['ab', 'c']));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
