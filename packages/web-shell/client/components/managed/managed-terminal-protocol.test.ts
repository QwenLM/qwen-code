/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  managedTerminalProtocols,
  newManagedTerminalId,
} from './managed-terminal-protocol';

describe('managed terminal protocol', () => {
  it('offers the raw base64url ticket without re-encoding it', () => {
    const ticket = 'eyJhbGciOiJub25lIn0-_abc123';
    expect(managedTerminalProtocols(ticket)).toEqual([
      'qwen-ws',
      `qwen-bearer.${ticket}`,
    ]);
  });

  it('generates terminal IDs the relay path accepts', () => {
    const first = newManagedTerminalId(1_700_000_000_000);
    const second = newManagedTerminalId(1_700_000_000_000);
    expect(first).toMatch(/^[A-Za-z0-9._-]{1,256}$/);
    expect(second).toMatch(/^[A-Za-z0-9._-]{1,256}$/);
    expect(first).not.toBe(second);
  });
});
