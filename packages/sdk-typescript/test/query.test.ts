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

/**
 * Transport whose read loop crashes (throws) after the initialize handshake
 * instead of closing cleanly via EOF. It replies to the INITIALIZE control
 * request so `query.initialized` resolves, then — once the next control request
 * has been written (e.g. continue_last_turn) — throws from `readMessages`,
 * exercising the message-router catch path that calls `finishTransportRead(err)`.
 */
class ThrowingTransport implements Transport {
  readonly isReady = true;
  readonly exitError = null;
  readonly writes: CLIControlRequest[] = [];

  private readonly writeWaiters: Array<() => void> = [];

  constructor(private readonly readError: Error) {}

  close(): Promise<void> {
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

  private waitForWrite(index: number): Promise<CLIControlRequest> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.writes.length > index) {
          resolve(this.writes[index]!);
          return;
        }
        this.writeWaiters.push(check);
      };
      check();
    });
  }

  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    // Reply to INITIALIZE so the handshake completes.
    const initializeRequest = await this.waitForWrite(0);
    yield controlSuccess(initializeRequest, null);

    // Wait until the caller's follow-up control request is in flight, then
    // crash the read loop instead of returning (clean EOF).
    await this.waitForWrite(1);
    throw this.readError;
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

    await expect(continuePromise).rejects.toThrow(
      'Transport closed before control response',
    );
    await query.close();
  });

  it('rejects continueLastTurn when the transport read loop throws', async () => {
    const readError = new Error('transport read crashed');
    const transport = new ThrowingTransport(readError);
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    await query.initialized;

    // The control request write unblocks the read loop, which then throws and
    // rejects this pending request via finishTransportRead(err).
    const continuePromise = query.continueLastTurn();

    await expect(continuePromise).rejects.toThrow('transport read crashed');
    await query.close();
  });

  it('rejects pending MCP responses when the transport read loop ends', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    // ponytail: inject a pending MCP response directly instead of standing up a
    // full SDK MCP server + tool-call handshake — finishTransportRead drains
    // pendingMcpResponses the same way regardless of how the entry got there.
    let rejectMcp!: (error: Error) => void;
    const mcpPending = new Promise<never>((_resolve, reject) => {
      rejectMcp = reject;
    });
    (
      query as unknown as {
        pendingMcpResponses: Map<string, { reject: (error: Error) => void }>;
      }
    ).pendingMcpResponses.set('server:1', { reject: rejectMcp });

    // Transport EOF ends the read loop, which calls finishTransportRead().
    await transport.close();

    await expect(mcpPending).rejects.toThrow(
      'Transport closed before control response',
    );
    await query.close();
  });

  it('does not close the query when the transport output ends', async () => {
    const transport = new MockTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 1000 },
    });

    const initializeRequest = await transport.waitForWrite(0);
    transport.pushMessage(controlSuccess(initializeRequest, null));
    await query.initialized;

    await transport.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(() => query.endInput()).not.toThrow();
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
