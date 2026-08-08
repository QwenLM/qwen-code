/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { RequestError } from '@agentclientprotocol/sdk';
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

  it('passes through agent-side RequestError JSON-RPC codes', () => {
    expect(
      toRpcError(
        RequestError.invalidParams(undefined, 'Unknown effort for m: high'),
      ),
    ).toEqual({
      code: RPC.INVALID_PARAMS,
      message: 'Invalid params: Unknown effort for m: high',
    });
  });

  it('passes through plain errors carrying a JSON-RPC code', () => {
    const err = new Error('semantic rejection');
    (err as Error & { code?: number }).code = RPC.INVALID_PARAMS;
    expect(toRpcError(err)).toEqual({
      code: RPC.INVALID_PARAMS,
      message: 'semantic rejection',
    });
  });

  it('does not pass through non-JSON-RPC numeric codes', () => {
    const err = new Error('rate limited');
    (err as Error & { code?: number }).code = 429;
    expect(toRpcError(err)).toEqual({
      code: RPC.INTERNAL_ERROR,
      message: 'Internal error',
      data: { errorKind: 'internal' },
    });
  });
});
