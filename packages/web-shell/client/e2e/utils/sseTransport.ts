import type { Page } from '@playwright/test';

export interface SseConnectionRecord {
  url: string;
  sessionId: string;
  headers: Record<string, string>;
  connectedAt: number;
}

export interface SseTransport<TEvent> {
  waitForConnection(
    sessionId?: string,
    options?: { timeout?: number },
  ): Promise<SseConnectionRecord>;
  connections(): Promise<SseConnectionRecord[]>;
  send(event: TEvent): Promise<void>;
  burst(events: readonly TEvent[]): Promise<void>;
  split(event: TEvent, chunkSizes?: readonly number[]): Promise<void>;
  close(): Promise<void>;
  error(message?: string): Promise<void>;
}

interface BrowserSseHarness {
  connections: SseConnectionRecord[];
  writeFrame: (frame: string) => void;
  writeSplitFrame: (frame: string, chunkSizes: readonly number[]) => void;
  close: () => void;
  error: (message: string) => void;
}

declare global {
  interface Window {
    __webShellSseHarness?: BrowserSseHarness;
  }
}

export async function installSseTransport<TEvent>(
  page: Page,
  options: { baseURL: string },
): Promise<SseTransport<TEvent>> {
  await page.addInitScript(({ baseURL }) => {
    const baseOrigin = new URL(baseURL, window.location.href).origin;
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const connections: SseConnectionRecord[] = [];

    function removeController(
      target: ReadableStreamDefaultController<Uint8Array>,
    ) {
      const index = controllers.indexOf(target);
      if (index >= 0) {
        controllers.splice(index, 1);
      }
    }

    function removeConnection(target: SseConnectionRecord) {
      const index = connections.indexOf(target);
      if (index >= 0) {
        connections.splice(index, 1);
      }
    }

    function activeControllers() {
      const active: ReadableStreamDefaultController<Uint8Array>[] = [];
      for (const controller of controllers) {
        try {
          const _desiredSize = controller.desiredSize;
          active.push(controller);
        } catch {
          continue;
        }
      }
      if (active.length !== controllers.length) {
        controllers.splice(0, controllers.length, ...active);
      }
      return active;
    }

    function writeBytes(bytes: Uint8Array) {
      for (const controller of activeControllers()) {
        controller.enqueue(bytes);
      }
    }

    window.__webShellSseHarness = {
      connections,
      writeFrame(frame: string) {
        writeBytes(encoder.encode(frame));
      },
      writeSplitFrame(frame: string, chunkSizes: readonly number[]) {
        const bytes = encoder.encode(frame);
        let offset = 0;
        for (const size of chunkSizes) {
          const nextOffset = Math.min(bytes.length, offset + Math.max(1, size));
          writeBytes(bytes.slice(offset, nextOffset));
          offset = nextOffset;
          if (offset >= bytes.length) return;
        }
        writeBytes(bytes.slice(offset));
      },
      close() {
        const active = activeControllers();
        controllers.length = 0;
        for (const controller of active) {
          controller.close();
        }
      },
      error(message: string) {
        const active = activeControllers();
        controllers.length = 0;
        for (const controller of active) {
          controller.error(new Error(message));
        }
      },
    };

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url, window.location.href);
      const match =
        url.origin === baseOrigin &&
        /^\/session\/[^/]+\/events\/?$/.test(url.pathname);

      if (!match) return originalFetch(input, init);

      const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
      let streamController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      let connectionRecord: SseConnectionRecord | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controllers.push(controller);
          connectionRecord = {
            url: url.href,
            sessionId,
            headers: Object.fromEntries(request.headers.entries()),
            connectedAt: Date.now(),
          };
          connections.push(connectionRecord);
        },
        cancel() {
          if (streamController) {
            removeController(streamController);
          }
          if (connectionRecord) {
            removeConnection(connectionRecord);
          }
        },
      });

      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: {
            'cache-control': 'no-cache',
            'content-type': 'text/event-stream',
          },
        }),
      );
    };
  }, options);

  const frameFor = (event: TEvent) => `data: ${JSON.stringify(event)}\n\n`;

  const transport: SseTransport<TEvent> = {
    async waitForConnection(sessionId, { timeout = 10_000 } = {}) {
      await page.waitForFunction(
        ({ targetSessionId }) => {
          const harness = window.__webShellSseHarness;
          if (!harness) return false;
          return harness.connections.some(
            (connection) =>
              !targetSessionId || connection.sessionId === targetSessionId,
          );
        },
        { targetSessionId: sessionId },
        { timeout },
      );
      const connections = await transport.connections();
      const match = [...connections]
        .reverse()
        .find((connection) => !sessionId || connection.sessionId === sessionId);
      if (!match) throw new Error('SSE connection was not recorded.');
      return match;
    },
    connections() {
      return page.evaluate(
        () => window.__webShellSseHarness?.connections ?? [],
      );
    },
    send(event) {
      return page.evaluate((frame) => {
        window.__webShellSseHarness?.writeFrame(frame);
      }, frameFor(event));
    },
    async burst(events) {
      for (const event of events) {
        await transport.send(event);
      }
    },
    split(event, chunkSizes = [7, 3, 11]) {
      return page.evaluate(
        ({ frame, sizes }) => {
          window.__webShellSseHarness?.writeSplitFrame(frame, sizes);
        },
        { frame: frameFor(event), sizes: chunkSizes },
      );
    },
    close() {
      return page.evaluate(() => window.__webShellSseHarness?.close());
    },
    error(message = 'SSE transport error') {
      return page.evaluate(
        (reason) => window.__webShellSseHarness?.error(reason),
        message,
      );
    },
  };
  return transport;
}
