import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getUpdates: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return { ...actual, getUpdates: apiMocks.getUpdates };
});

vi.mock('./accounts.js', async () => {
  const actual =
    await vi.importActual<typeof import('./accounts.js')>('./accounts.js');
  return { ...actual, getStateDir: () => '/nonexistent/weixin-monitor-test' };
});

import { startPollLoop } from './monitor.js';
import { MessageItemType, MessageType } from './types.js';
import type { ParsedMessage } from './monitor.js';

describe('startPollLoop', () => {
  beforeEach(() => {
    apiMocks.getUpdates.mockReset();
  });

  it('marks only captionless media placeholders as synthetic text', async () => {
    apiMocks.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_id: 1,
          from_user_id: 'user-1',
          message_type: MessageType.USER,
          item_list: [
            {
              type: MessageItemType.IMAGE,
              image_item: {
                media: { encrypt_query_param: 'image-query', aes_key: 'key' },
              },
            },
          ],
        },
        {
          message_id: 2,
          from_user_id: 'user-1',
          message_type: MessageType.USER,
          item_list: [
            {
              type: MessageItemType.FILE,
              file_item: {
                file_name: 'report.pdf',
                media: { encrypt_query_param: 'file-query', aes_key: 'key' },
              },
            },
          ],
        },
        {
          message_id: 3,
          from_user_id: 'user-1',
          message_type: MessageType.USER,
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: 'hello' },
            },
          ],
        },
      ],
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const controller = new AbortController();
    const messages: ParsedMessage[] = [];

    await startPollLoop({
      baseUrl: 'https://weixin.invalid',
      token: 'token',
      abortSignal: controller.signal,
      onMessage: async (message) => {
        messages.push(message);
        if (messages.length === 3) controller.abort();
      },
    });

    expect(messages).toEqual([
      expect.objectContaining({
        text: '(image)',
        syntheticText: true,
        image: expect.any(Object),
      }),
      expect.objectContaining({
        text: '(file: report.pdf)',
        syntheticText: true,
        file: expect.any(Object),
      }),
      expect.objectContaining({
        text: 'hello',
      }),
    ]);
    expect(messages[2]?.syntheticText).toBeUndefined();
  });
});
