/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PendingRequestManager } from './pending-requests.js';

describe('PendingRequestManager', () => {
  it('uses a caller-provided correlation id', async () => {
    const manager = new PendingRequestManager();
    const pending = manager.createRequestWithId<string>('tool-call-1');

    expect(pending.requestId).toBe('tool-call-1');
    expect(manager.resolve('tool-call-1', 'allowed')).toBe(true);
    await expect(pending.promise).resolves.toBe('allowed');
  });

  it('rejects duplicate caller-provided ids while the first is pending', () => {
    const manager = new PendingRequestManager();
    manager.createRequestWithId('tool-call-1');

    expect(() => manager.createRequestWithId('tool-call-1')).toThrow(
      'Pending request id is invalid or duplicated: tool-call-1',
    );
  });
});
