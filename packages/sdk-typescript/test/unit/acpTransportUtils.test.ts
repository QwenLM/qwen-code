/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { jsonRpcErrorToHttpStatusWithData } from '../../src/daemon/acpTransportUtils.js';

describe('jsonRpcErrorToHttpStatusWithData', () => {
  it.each(['session_archived', 'session_conflict', 'session_archiving'])(
    'maps %s to HTTP 409',
    (errorKind) => {
      expect(
        jsonRpcErrorToHttpStatusWithData(-32603, {
          errorKind,
          sessionId: 's-1',
        }),
      ).toBe(409);
    },
  );
});
