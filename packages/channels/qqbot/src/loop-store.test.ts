import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelLoopStore, SessionRouter } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelLoopController,
  ChannelLoopToolHandler,
} from '@qwen-code/channel-base';

const { mockNewSession, mockPrompt } = vi.hoisted(() => ({
  mockNewSession: vi.fn(),
  mockPrompt: vi.fn(),
}));

const { QQChannel } = await import('./QQChannel.js');

const CHAT_ID = 'group-openid-store';
const SENDER_ID = 'member-store';
const SESSION_ID = 'session-store-1';

function makeController(store: ChannelLoopStore): ChannelLoopController {
  return {
    create: (input) => store.create(input),
    createForTarget: (input, maxEnabledLoops) =>
      store.createForTarget(input, maxEnabledLoops),
    listForTarget: (channelName, target) =>
      store.listForTarget(channelName, target),
    disable: (id) => store.disable(id),
    validateCron: (cron) => {
      if (cron.trim().split(/\s+/u).length !== 5) {
        throw new Error('expected a five-field cron expression');
      }
    },
  };
}

function makeChannel(
  controller: ChannelLoopController,
  persistPath: string,
): {
  ch: InstanceType<typeof QQChannel>;
  getLoopHandler: () => ChannelLoopToolHandler | undefined;
} {
  let loopHandler: ChannelLoopToolHandler | undefined;
  const bridge = {
    newSession: mockNewSession,
    prompt: mockPrompt,
    on: vi.fn(),
    off: vi.fn(),
    registerChannelLoopToolHandler: vi.fn((handler: ChannelLoopToolHandler) => {
      loopHandler = handler;
    }),
  };
  const router = new SessionRouter(
    bridge as unknown as ChannelAgentBridge,
    '/tmp',
    'user',
    persistPath,
  );
  const ch = new QQChannel(
    'store-bot',
    {
      type: 'qq',
      token: '',
      senderPolicy: 'open' as const,
      allowedUsers: [],
      sessionScope: 'user' as const,
      cwd: '/tmp',
      groupPolicy: 'open' as const,
      groups: {},
      dmPolicy: 'open' as const,
      appID: 'store-app-id',
      appSecret: 'store-secret',
    },
    bridge as unknown as ChannelAgentBridge,
    { loopController: controller, registerBridgeEvents: false, router },
  );
  return { ch, getLoopHandler: () => loopHandler };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNewSession.mockResolvedValue(SESSION_ID);
});

describe('QQ channel loop store integration', () => {
  it('persists create, list, and cancel through a real ChannelLoopStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-loop-store-'));
    const storePath = join(dir, 'loops.json');
    try {
      const store = new ChannelLoopStore({
        filePath: storePath,
        idFactory: () => 'store-job-1',
      });
      const { ch, getLoopHandler } = makeChannel(
        makeController(store),
        join(dir, 'sessions.json'),
      );
      const sessionId = await ch.router.resolve(
        'store-bot',
        SENDER_ID,
        CHAT_ID,
        undefined,
        '/tmp',
        true,
      );
      const handler = getLoopHandler();
      expect(handler).toBeDefined();

      const created = await handler!.create(sessionId, {
        cron: '*/5 * * * *',
        prompt: 'drink water',
      });
      expect(created).toBe('Loop store-job-1: */5 * * * *');
      const afterCreate = JSON.parse(readFileSync(storePath, 'utf8'));
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]).toMatchObject({
        id: 'store-job-1',
        enabled: true,
      });

      const listed = await handler!.list(sessionId);
      expect(listed).toContain('store-job-1');
      expect(listed).toContain('enabled');

      await expect(handler!.cancel(sessionId, 'store-job-1')).resolves.toBe(
        'Cancelled loop store-job-1.',
      );
      const afterCancel = JSON.parse(readFileSync(storePath, 'utf8'));
      expect(afterCancel).toHaveLength(1);
      expect(afterCancel[0]).toMatchObject({
        id: 'store-job-1',
        enabled: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
