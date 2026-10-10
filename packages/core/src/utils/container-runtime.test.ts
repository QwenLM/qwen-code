/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { hasRootlessMarker } from './container-runtime.js';

describe('rootless runtime metadata', () => {
  it.each([
    { SecurityOptions: ['name=seccomp', 'name=rootless'] },
    { Host: { Security: { Rootless: true } } },
    { host: { security: { rootless: true } } },
  ])('accepts authoritative rootless fields: %j', (info) => {
    expect(hasRootlessMarker(JSON.stringify(info, null, 2))).toBe(true);
  });

  it.each([
    '',
    'not JSON',
    'null',
    '[]',
    '{}',
    '{"Labels":["name=rootless"],"SecurityOptions":["name=seccomp"]}',
    '{"Plugins":{"Rootless":true}}',
    '{"Registries":{"rootless":true}}',
    '{"SecurityOptions":"name=rootless"}',
    '{"Host":{"Security":{"Rootless":"true"}}}',
    '{"host":{"security":{"rootless":false}}}',
  ])('retains UID mapping for absent or unrelated markers: %s', (info) => {
    expect(hasRootlessMarker(info)).toBe(false);
  });
});
