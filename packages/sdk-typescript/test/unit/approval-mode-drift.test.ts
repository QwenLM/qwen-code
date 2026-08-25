/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_APPROVAL_MODES } from '@qwen-code/acp-bridge/bridgeClient';
import { APPROVAL_MODES } from '@qwen-code/qwen-code-core';
import { DAEMON_APPROVAL_MODES, PERMISSION_MODES } from '../../src/index.js';

const crossLanguageContract = JSON.parse(
  readFileSync(
    new URL('../../../core/src/config/approval-modes.json', import.meta.url),
    'utf8',
  ),
) as string[];

describe('approval-mode SDK ↔ core drift detection', () => {
  it('keeps core and SDK contracts synchronized', () => {
    expect([...APPROVAL_MODES]).toEqual(crossLanguageContract);
    expect([...PERMISSION_MODES]).toEqual(crossLanguageContract);
    expect([...KNOWN_APPROVAL_MODES]).toEqual(crossLanguageContract);
    expect(DAEMON_APPROVAL_MODES).toBe(PERMISSION_MODES);
  });
});
