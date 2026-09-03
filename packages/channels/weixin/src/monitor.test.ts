import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUpdatesMock = vi.hoisted(() => vi.fn());

vi.mock('./api.js', () => ({ getUpdates: getUpdatesMock }));

import { startPollLoop } from './monitor.js';

describe('startPollLoop', () => {
  let stateDir: string;
  const previousStateDir = process.env['WEIXIN_STATE_DIR'];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'qwen-weixin-monitor-'));
    process.env['WEIXIN_STATE_DIR'] = stateDir;
    getUpdatesMock.mockReset();
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env['WEIXIN_STATE_DIR'];
    else process.env['WEIXIN_STATE_DIR'] = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('preserves large message IDs through inbound dispatch', async () => {
    const controller = new AbortController();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    getUpdatesMock.mockImplementationOnce(async () => {
      controller.abort();
      return {
        ret: 0,
        msgs: [
          {
            message_id: '7489534892789344264',
            message_type: 1,
            from_user_id: 'user-1',
            item_list: [{ type: 1, text_item: { text: 'hello' } }],
          },
        ],
      };
    });

    await startPollLoop({
      baseUrl: 'https://ilink.example',
      token: 'token',
      onMessage,
      abortSignal: controller.signal,
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: '7489534892789344264' }),
    );
  });
});
