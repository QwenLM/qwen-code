import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';
import { FeishuChannel } from './FeishuAdapter.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

describe('Feishu inbound file storage', () => {
  const systemTmpDir = tmpdir();
  const bytes = new Uint8Array([0, 1, 255]);
  let directory: string;
  let channel: FeishuChannel;
  let dispatch: MockInstance<FeishuChannel['handleInbound']>;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(mkdirSync).mockImplementation(actualFs.mkdirSync);
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync);
    directory = mkdtempSync(join(systemTmpDir, 'feishu-file-store-'));
    vi.mocked(tmpdir).mockReturnValue(directory);
    vi.useFakeTimers();
    const config: ChannelConfig = {
      type: 'feishu',
      token: '',
      clientId: 'test_app_id',
      clientSecret: 'test_app_secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: directory,
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: { '*': { requireMention: true } },
    };
    const bridge = {
      prompt: vi.fn().mockResolvedValue(''),
      cancelSession: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
      availableCommands: [],
      newSession: vi.fn().mockResolvedValue('session-1'),
      loadSession: vi.fn().mockImplementation((id: string) => id),
    } as unknown as ChannelAgentBridge;
    channel = new FeishuChannel('test', config, bridge);
    Object.assign(channel, {
      tokenCache: { token: 'test_token', expiresAt: Date.now() + 3_600_000 },
    });
    dispatch = vi.spyOn(channel, 'handleInbound').mockResolvedValue(undefined);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe(
        'https://open.feishu.cn/open-apis/im/v1/messages/inbound-file/resources/file_1?type=file',
      );
      return new Response(bytes, {
        headers: { 'Content-Type': 'application/pdf' },
      });
    });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(tmpdir).mockReturnValue(systemTmpDir);
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    actualFs.rmSync(directory, { recursive: true, force: true });
  });

  function receive() {
    (channel as unknown as { onMessage(data: unknown): void }).onMessage({
      message: {
        message_id: 'inbound-file',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({
          file_key: 'file_1',
          file_name: 'report.pdf',
        }),
      },
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
    });
  }

  it('keeps successful files until the existing cleanup grace period', async () => {
    receive();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const attachment = dispatch.mock.calls[0]![0].attachments?.[0];
    expect(attachment).toEqual({
      type: 'file',
      filePath: expect.any(String),
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
    });
    expect(readFileSync(attachment!.filePath!)).toEqual(Buffer.from(bytes));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(existsSync(attachment!.filePath!)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(readdirSync(join(directory, 'channel-files'))).toEqual([]);
  });

  it.each([
    { stage: 'mkdir', code: 'EACCES' },
    { stage: 'write', code: 'ENAMETOOLONG' },
    { stage: 'write', code: 'ENOSPC' },
  ])(
    'removes partial storage and keeps text on $stage $code',
    async ({ stage, code }) => {
      const actualFs =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      if (stage === 'mkdir') {
        vi.mocked(mkdirSync).mockImplementationOnce((path, options) => {
          actualFs.mkdirSync(path, options);
          throw new Error(code);
        });
      } else {
        vi.mocked(writeFileSync).mockImplementationOnce((path) => {
          actualFs.writeFileSync(path, 'partial');
          throw new Error(code);
        });
      }
      receive();
      await vi.advanceTimersByTimeAsync(0);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(code));
      expect.soft(readdirSync(join(directory, 'channel-files'))).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![0]).toMatchObject({
        text: '(file: report.pdf)',
        syntheticText: true,
      });
      expect(dispatch.mock.calls[0]![0].attachments).toBeUndefined();
    },
  );
});
