/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { LoadedSettings } from '../config/settings.js';
import { collectUserMcpRegistrations } from './framework.js';

function settingsWith(
  mcpServers: Record<string, Record<string, unknown>>,
): LoadedSettings {
  return {
    user: { settings: { mcpServers } },
  } as unknown as LoadedSettings;
}

describe('collectUserMcpRegistrations', () => {
  it('skips user servers disabled in settings', () => {
    const registrations = collectUserMcpRegistrations(
      settingsWith({
        enabled: { command: 'node' },
        disabled: { command: 'node', disabled: true },
      }),
    );

    expect(registrations.map((registration) => registration.key.name)).toEqual([
      'enabled',
    ]);
  });
});
