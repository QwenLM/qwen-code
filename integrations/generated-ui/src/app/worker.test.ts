/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiWorkerRequest, UiWorkerResponse } from './runtime-contract.js';

vi.mock(
  '@jitl/quickjs-singlefile-browser-release-sync',
  () => import('@jitl/quickjs-singlefile-mjs-release-sync'),
);

function createWorkerScope() {
  return {
    onmessage: undefined as
      | ((event: MessageEvent<UiWorkerRequest>) => Promise<void>)
      | undefined,
    postMessage: vi.fn<(response: UiWorkerResponse) => void>(),
    close: vi.fn<() => void>(),
  };
}

let worker: ReturnType<typeof createWorkerScope>;

beforeEach(async () => {
  vi.resetModules();
  worker = createWorkerScope();
  vi.stubGlobal('self', worker);
  await import('./worker.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function send(request: UiWorkerRequest) {
  await worker.onmessage!(new MessageEvent('message', { data: request }));
}

describe('Generated UI worker execution outcomes', () => {
  it('reports initialization, an empty handled round and an unmatched event', async () => {
    await send({
      type: 'init',
      sequence: 1,
      javascript: `ui.text('out', 'initial');
        ui.on('run', 'click', () => {});`,
      inputs: {},
    });
    await send({
      type: 'event',
      sequence: 2,
      event: { id: 'run', type: 'click', value: '', checked: false },
      inputs: {},
    });
    await send({
      type: 'event',
      sequence: 3,
      event: { id: 'run', type: 'input', value: '', checked: false },
      inputs: {},
    });

    expect(worker.postMessage.mock.calls.map(([response]) => response)).toEqual(
      [
        {
          sequence: 1,
          patches: [{ kind: 'text', id: 'out', value: 'initial' }],
          execution: 'initialized',
        },
        { sequence: 2, patches: [], execution: 'handled' },
        { sequence: 3, patches: [], execution: 'unhandled' },
      ],
    );
    expect(worker.close).not.toHaveBeenCalled();

    await send({ type: 'init', sequence: 4, javascript: '', inputs: {} });
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it.each(['init', 'event'] as const)(
    'keeps the error response terminal when %s execution fails',
    async (failure) => {
      await send({
        type: 'init',
        sequence: 1,
        javascript:
          failure === 'init'
            ? `throw new Error('failure');`
            : `ui.on('run', 'click', () => { throw new Error('failure'); });`,
        inputs: {},
      });
      const request: UiWorkerRequest = {
        type: 'event',
        sequence: 2,
        event: { id: 'run', type: 'click', value: '', checked: false },
        inputs: {},
      };
      if (failure === 'event') await send(request);

      const calls = worker.postMessage.mock.calls.length;
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        sequence: failure === 'init' ? 1 : 2,
        error:
          failure === 'init'
            ? 'Script error: failure (line 1, column 16).'
            : 'Script error: failure (line 1, column 46).',
      });
      expect(worker.close).toHaveBeenCalledOnce();
      await send(request);
      expect(worker.postMessage).toHaveBeenCalledTimes(calls);
    },
  );
});
