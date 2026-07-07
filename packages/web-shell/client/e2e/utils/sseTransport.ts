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

    function activeControllers() {
      return controllers.filter((controller) => {
        try {
          const _desiredSize = controller.desiredSize;
          return true;
        } catch {
          return false;
        }
      });
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
        for (const controller of activeControllers()) {
          controller.close();
        }
        controllers.length = 0;
      },
      error(message: string) {
        for (const controller of activeControllers()) {
          controller.error(new Error(message));
        }
        controllers.length = 0;
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
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          connections.push({
            url: url.href,
            sessionId,
            headers: Object.fromEntries(request.headers.entries()),
            connectedAt: Date.now(),
          });
        },
        cancel() {
          controllers.length = 0;
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
      const match = connections.find(
        (connection) => !sessionId || connection.sessionId === sessionId,
      );
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
