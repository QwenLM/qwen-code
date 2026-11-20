import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelLoopStore } from '@qwen-code/channel-base';
import type {
  ChannelLoop,
  ChannelLoopController,
  ChannelLoopInput,
  SessionTarget,
} from '@qwen-code/channel-base';
import { createChannelLoopController } from './loop-runtime.js';

const CHANNEL_A = 'qq-a';
const CHANNEL_B = 'qq-b';

function loopTarget(
  channelName: string,
  chatId: string,
  senderId = 'member-1',
): SessionTarget {
  return { channelName, senderId, chatId, isGroup: true };
}

async function listForChat(
  controller: ChannelLoopController,
  channelName: string,
  chatId: string,
): Promise<ChannelLoop[]> {
  if (!controller.listForChat) {
    throw new Error('createChannelLoopController does not provide listForChat');
  }
  return controller.listForChat(channelName, chatId);
}

describe('createChannelLoopController listForChat', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function seedLoops(): Promise<{
    controller: ChannelLoopController;
    match: ChannelLoop;
    otherSender: ChannelLoop;
    otherChat: ChannelLoop;
    otherChannel: ChannelLoop;
  }> {
    tempDir = mkdtempSync(join(tmpdir(), 'qwen-loop-runtime-'));
    const store = new ChannelLoopStore({
      filePath: join(tempDir, 'cron.json'),
    });
    const controller = createChannelLoopController(store);
    const seed = (
      channelName: string,
      chatId: string,
      prompt: string,
      senderId = 'member-1',
    ): Promise<ChannelLoop> => {
      const input: ChannelLoopInput = {
        channelName,
        target: loopTarget(channelName, chatId, senderId),
        cwd: '/workspace',
        cron: '*/5 * * * *',
        prompt,
        label: prompt,
        recurring: true,
        createdBy: senderId,
      };
      return controller.create(input);
    };
    const match = await seed(CHANNEL_A, 'chat-1', 'match');
    const otherSender = await seed(
      CHANNEL_A,
      'chat-1',
      'same chat, other sender',
      'member-2',
    );
    const otherChat = await seed(CHANNEL_A, 'chat-2', 'other chat');
    const otherChannel = await seed(CHANNEL_B, 'chat-1', 'other channel');
    return { controller, match, otherSender, otherChat, otherChannel };
  }

  it('returns only the jobs of the given channel and chat', async () => {
    const { controller, match, otherSender } = await seedLoops();

    const jobs = await listForChat(controller, CHANNEL_A, 'chat-1');

    expect(jobs.map((job) => job.id).sort()).toEqual(
      [match.id, otherSender.id].sort(),
    );
  });

  it('is chat-wide: matches every sender in the chat, not just the creator', async () => {
    const { controller, match, otherSender } = await seedLoops();

    const jobs = await listForChat(controller, CHANNEL_A, 'chat-1');

    expect(jobs.map((job) => job.createdBy).sort()).toEqual(
      [match.createdBy, otherSender.createdBy].sort(),
    );
  });
});
