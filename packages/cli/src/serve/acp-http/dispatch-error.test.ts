/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonDrainingError } from '../server/session-archive.js';
import { toRpcError } from './dispatch.js';
import { RPC } from './json-rpc.js';

describe('toRpcError', () => {
  it('maps sealed maintenance to a JSON-RPC server error', () => {
    expect(toRpcError(new DaemonDrainingError())).toEqual({
      code: RPC.INTERNAL_ERROR,
      message:
        'The daemon is draining and no longer accepts session maintenance.',
      data: { errorKind: 'daemon_draining' },
    });
  });
});
