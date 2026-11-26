/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SDKAgentsMdSizeWarningMessageSchema,
  SDKMessageSchema,
} from './sdk-message.js';
describe('AGENTS.md size warning protocol', () => {
  const warning = {
    type: 'system',
    subtype: 'agents_md_size_warning',
    code: 'AGENTS_MD_SIZE_THRESHOLD_REACHED',
    severity: 'warning',
    total_bytes: 32768,
    threshold_bytes: 32768,
    threshold_source: 'qcs',
    files: [{ path: '/project/AGENTS.md', bytes: 32768 }],
    load_status: 'complete',
    truncated: false,
    uuid: 'warning',
    session_id: 'session',
  };
  it('accepts the same wire message in the specific schema and output union', () => {
    expect(SDKAgentsMdSizeWarningMessageSchema().parse(warning)).toEqual(
      warning,
    );
    expect(SDKMessageSchema().parse(warning)).toEqual(warning);
  });
  it('rejects wrong units/types and a false truncation claim', () => {
    expect(
      SDKAgentsMdSizeWarningMessageSchema().safeParse({
        ...warning,
        threshold_bytes: '32768',
      }).success,
    ).toBe(false);
    expect(
      SDKAgentsMdSizeWarningMessageSchema().safeParse({
        ...warning,
        truncated: true,
      }).success,
    ).toBe(false);
  });
});
