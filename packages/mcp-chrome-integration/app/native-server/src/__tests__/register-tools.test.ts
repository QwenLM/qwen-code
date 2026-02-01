jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    sendRequestToExtensionAndWait: jest.fn(),
  },
}));

import { setupTools } from '../mcp/register-tools';
import nativeMessagingHostInstance from '../native-messaging-host';

const sendRequestToExtensionAndWait = nativeMessagingHostInstance
  .sendRequestToExtensionAndWait as jest.Mock;

type Handler = (request: {
  params: { name: string; arguments?: unknown };
}) => Promise<unknown>;

describe('register-tools', () => {
  beforeEach(() => {
    sendRequestToExtensionAndWait.mockReset();
  });

  it('passes through CallToolResult content (image)', async () => {
    const handlers: Handler[] = [];
    const server = {
      setRequestHandler: (_schema: unknown, handler: Handler) => {
        handlers.push(handler);
      },
    } as unknown as Parameters<typeof setupTools>[0];

    setupTools(server);

    const callToolHandler = handlers[1];
    const imageResult = {
      content: [
        {
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
        },
      ],
    };

    sendRequestToExtensionAndWait.mockResolvedValue({
      status: 'success',
      data: imageResult,
    });

    const result = await callToolHandler({
      params: { name: 'chrome_screenshot', arguments: {} },
    });

    expect(result).toEqual(imageResult);
  });

  it('returns isError when native response is error', async () => {
    const handlers: Handler[] = [];
    const server = {
      setRequestHandler: (_schema: unknown, handler: Handler) => {
        handlers.push(handler);
      },
    } as unknown as Parameters<typeof setupTools>[0];

    setupTools(server);

    const callToolHandler = handlers[1];

    sendRequestToExtensionAndWait.mockResolvedValue({
      status: 'error',
      error: 'boom',
    });

    const result = (await callToolHandler({
      params: { name: 'chrome_screenshot', arguments: {} },
    })) as { isError?: boolean; content?: { type: string; text?: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('boom');
  });
});
