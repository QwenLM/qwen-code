/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CustomRequest } from '../request/customRequest.js';
import { CustomResponse } from '../response/customResponse.js';
import { CustomOutboundPipeline } from './customOutboundPipeline.js';
import { BaseValve } from './valve/valve.js';

class RecordingValve extends BaseValve {
  constructor(
    private readonly name: string,
    private readonly calls: string[],
  ) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    this.calls.push(this.name);
    const next = this.getNext();
    if (next) await next.invoke(input, output);
  }
}

function makeRequest(): CustomRequest {
  return new CustomRequest({
    url: 'https://example.com/v1/chat',
    method: 'POST',
    headers: {},
    streamResponse: false,
  });
}

describe('CustomOutboundPipeline', () => {
  it('creates and returns output when executing the chain', async () => {
    const pipeline = new CustomOutboundPipeline(() => CustomResponse.initial());
    const calls: string[] = [];
    pipeline.append('first', new RecordingValve('first', calls));
    pipeline.append('second', new RecordingValve('second', calls));

    await expect(pipeline.execute(makeRequest())).resolves.toBeInstanceOf(
      CustomResponse,
    );

    expect(calls).toEqual(['first', 'second']);
  });

  it('rejects execute when no initial output is configured', async () => {
    const pipeline = new CustomOutboundPipeline();

    await expect(pipeline.execute(makeRequest())).rejects.toThrow(
      'pipeline has no initial output',
    );
  });

  it('inserts a valve after the named valve', async () => {
    const pipeline = new CustomOutboundPipeline(() => CustomResponse.initial());
    const calls: string[] = [];
    pipeline.append('first', new RecordingValve('first', calls));
    pipeline.append('last', new RecordingValve('last', calls));
    pipeline.insert('middle', new RecordingValve('middle', calls), 'first');

    await pipeline.invoke(makeRequest(), CustomResponse.initial());

    expect(calls).toEqual(['first', 'middle', 'last']);
  });

  it('inserts without an anchor at the head', async () => {
    const pipeline = new CustomOutboundPipeline(() => CustomResponse.initial());
    const calls: string[] = [];
    pipeline.append('last', new RecordingValve('last', calls));
    pipeline.insert('first', new RecordingValve('first', calls));

    await pipeline.invoke(makeRequest(), CustomResponse.initial());

    expect(calls).toEqual(['first', 'last']);
  });
});
