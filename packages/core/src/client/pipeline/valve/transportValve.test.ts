/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Transport } from '../../transport/transport.js';
import { CustomRequest } from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { TransportValve } from './transportValve.js';

class RecordingTransport implements Transport {
  seen?: string;

  constructor(
    private readonly status: number,
    private readonly protocol = 'test',
  ) {}

  async invoke(request: CustomRequest, output: CustomResponse): Promise<void> {
    this.seen = request.headers['x-seen'];
    output.raw = new Response(null, { status: this.status });
  }

  /** The registry key this transport answers to. */
  get key(): string {
    return this.protocol;
  }
}

function request(): CustomRequest {
  return new CustomRequest({
    url: 'test://request',
    method: 'GET',
    headers: { 'x-seen': 'prepared request' },
    streamResponse: false,
  });
}

describe('TransportValve', () => {
  it('delegates the request to the protocol transport', async () => {
    const transport = new RecordingTransport(200);
    const valve = new TransportValve({ http: transport });
    const output = CustomResponse.initial();

    await valve.invoke(request(), output);

    expect(transport.seen).toBe('prepared request');
    expect(output.raw!.status).toBe(200);
  });

  it('rejects an unsupported protocol', async () => {
    const valve = new TransportValve({});

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toThrow('Unsupported transport protocol: http');
  });
});
