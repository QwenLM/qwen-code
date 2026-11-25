/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { managedCommandId } from './managed-command-id.js';

describe('managedCommandId', () => {
  it('preserves short identities and deterministically bounds long identities', () => {
    const short = 'assistant-delta:turn:message:0';
    expect(managedCommandId(short)).toBe(short);
    const long = `harness:await_runtime:${'a'.repeat(36)}:${'b'.repeat(128)},${'c'.repeat(128)}:42`;
    const bounded = managedCommandId(long);
    expect(bounded).toHaveLength(128);
    expect(bounded).toMatch(/^harness:await_runtime:.*:sha256:[0-9a-f]{64}$/);
    expect(managedCommandId(long)).toBe(bounded);
    expect(managedCommandId(`${long}x`)).not.toBe(bounded);

    const surrogateBoundary = `assistant-delta:${'z'.repeat(39)}😀${'q'.repeat(90)}:0`;
    const surrogateBounded = managedCommandId(surrogateBoundary);
    expect(surrogateBounded).toHaveLength(127);
    expect(Buffer.from(surrogateBounded, 'utf8').toString('utf8')).toBe(
      surrogateBounded,
    );

    const longAscii = `${'z'.repeat(39)}😀${'q'.repeat(39)}`;
    expect(managedCommandId(`wake-recovery:${longAscii}`)).toHaveLength(128);
  });
});
