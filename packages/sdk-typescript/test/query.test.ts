import { describe, expect, it } from 'vitest';
import { Query } from '../src/query/Query.js';
import type { Transport } from '../src/transport/Transport.js';
import {
  ControlRequestType,
  type CLIControlRequest,
  type CLIControlResponse,
} from '../src/types/protocol.js';

const CLOSED = Symbol('closed');

class MockTransport implements Transport {
  readonly isReady = true;
  readonly exitError = null;
  readonly writes: CLIControlRequest[] = [];

  private closed = false;
  private readonly messages: unknown[] = [];
  private readonly messageWaiters: Array<
    (message: unknown | typeof CLOSED) => void
  > = [];
  private readonly writeWaiters: Array<() => void> = [];

  close(): Promise<void> {
    this.closed = true;
    for (const resolve of this.messageWaiters.splice(0)) {
      resolve(CLOSED);
    }
    return Promise.resolve();
  }

  waitForExit(): Promise<void> {
    return Promise.resolve();
  }

  write(message: string): void {
    this.writes.push(JSON.parse(message) as CLIControlRequest);
    for (const resolve of this.writeWaiters.splice(0)) {
      resolve();
    }
  }

  pushMessage(message: unknown): void {
    const resolve = this.messageWaiters.shift();
    if (resolve) {
      resolve(message);
      return;
    }
    this.messages.push(message);
  }

  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    while (true) {
      if (this.messages.length > 0) {
        yield this.messages.shift();
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<unknown | typeof CLOSED>((resolve) => {
        this.messageWaiters.push(resolve);
      });
      if (next === CLOSED) {
        return;
      }
      yield next;
    }
  }

  async waitForWrite(index: number): Promise<CLIControlRequest> {
    while (this.writes.length <= index) {
      await new Promise<void>((resolve) => {
        this.writeWaiters.push(resolve);
      });
    }
    return this.writes[index]!;
  }
}

function controlSuccess(
  request: CLIControlRequest,
  response: Record<string, unknown> | null,
): CLIControlResponse {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.request_id,
      response,
    },
  };
}

function controlError(
  request: CLIControlRequest,
  error: string,
): CLIControlResponse {
  return {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: request.request_id,
      error,
    },
  };
}

describe('Query', () => {
  it('sends continue_last_turn control request and returns the payload', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    expect(initializeRequest.request.subtype).toBe(
      ControlRequestType.INITIALIZE,
    );
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    const continuePromise = query.continueLastTurn();
    const continueRequest = await transport.waitForWrite(1);
    expect(continueRequest.request).toEqual({
      subtype: ControlRequestType.CONTINUE_LAST_TURN,
    });

    const payload = {
      accepted: true,
      interruption: 'interrupted_prompt',
    };
    transport.pushMessage(controlSuccess(continueRequest, payload));

    await expect(continuePromise).resolves.toEqual(payload);
    await query.close();
  });

  it('rejects continueLastTurn when the transport closes before the response', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    const continuePromise = query.continueLastTurn();
    await transport.waitForWrite(1);
    await transport.close();

    await expect(continuePromise).rejects.toThrow('Query is closed');
    await query.close();
  });

  it('rejects continueLastTurn when the CLI returns a control error', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    const continuePromise = query.continueLastTurn();
    const continueRequest = await transport.waitForWrite(1);
    transport.pushMessage(controlError(continueRequest, 'no turn to continue'));

    await expect(continuePromise).rejects.toThrow('no turn to continue');
    await query.close();
  });

  it('rejects continueLastTurn when the control request times out', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 25 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    const continuePromise = query.continueLastTurn();
    await transport.waitForWrite(1);

    await expect(continuePromise).rejects.toThrow(
      'Control request timeout: continue_last_turn',
    );
    await query.close();
  });
});
