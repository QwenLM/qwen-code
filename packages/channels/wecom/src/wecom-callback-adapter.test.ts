import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
  SessionTarget,
} from '@qwen-code/channel-base';
import { WeComCallbackChannel } from './wecom-callback-adapter.js';

const key = Buffer.alloc(32, 42);
const token = 'callback-token';
const realFetch = globalThis.fetch;

class RecordingChannel extends WeComCallbackChannel {
  readonly received: Envelope[] = [];
  protected override async processInbound(envelope: Envelope): Promise<void> {
    this.received.push(envelope);
  }
  acceptsTarget(target: SessionTarget) {
    return this.supportsProactiveTarget(target);
  }
}

function payload(overrides: Record<string, string> = {}) {
  const fields = {
    ToUserName: 'corp',
    AgentID: '1000002',
    FromUserName: 'alice',
    MsgType: 'text',
    Content: '你好 & <code>',
    MsgId: '12345',
    ...overrides,
  };
  return (
    '<xml>' +
    Object.entries(fields)
      .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
      .join('') +
    '</xml>'
  );
}

function signed(
  plaintext: string,
  options: { corp?: string; timestamp?: string } = {},
) {
  const text = Buffer.from(plaintext);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const framed = Buffer.concat([
    randomBytes(16),
    length,
    text,
    Buffer.from(options.corp ?? 'corp'),
  ]);
  const padding = 32 - (framed.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([framed, Buffer.alloc(padding, padding)])),
    cipher.final(),
  ]).toString('base64');
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = '123';
  const signature = createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
  return {
    params: new URLSearchParams({
      timestamp,
      nonce,
      msg_signature: signature,
      echostr: encrypted,
    }),
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  };
}

describe('WeCom Callback adapter', () => {
  let channel: RecordingChannel;
  let address: string;
  let config: ChannelConfig & Record<string, unknown>;
  let bridge: ChannelAgentBridge;
  const api = vi.fn<typeof fetch>();

  beforeEach(async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, '127.0.0.1', resolve),
    );
    const bound = reservation.address();
    if (!bound || typeof bound === 'string')
      throw new Error('Missing test port');
    const port = bound.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    config = {
      type: 'wecom-callback',
      token,
      corpId: 'corp',
      agentId: '1000002',
      corpSecret: 'app-secret',
      encodingAESKey: key.toString('base64').slice(0, -1),
      webhookPort: port,
      privatePolicy: 'allowlist',
      allowedUsers: ['alice'],
      sessionScope: 'user',
      cwd: process.cwd(),
      groupPolicy: 'disabled',
      groups: {},
    };
    bridge = {
      availableCommands: [],
      on: vi.fn(),
      off: vi.fn(),
      newSession: vi.fn(async () => 'session'),
      prompt: vi.fn(async () => ''),
      cancelSession: vi.fn(async () => {}),
    } as unknown as ChannelAgentBridge;
    channel = new RecordingChannel('callback', config, bridge);
    await channel.connect();
    address = `http://127.0.0.1:${port}/wecom/callback`;
    api.mockReset();
    api.mockImplementation(async (url) =>
      Response.json(
        String(url).includes('/gettoken?')
          ? { errcode: 0, access_token: 'access-1', expires_in: 7200 }
          : { errcode: 0 },
      ),
    );
    vi.stubGlobal('fetch', api);
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const post = async (
    url: string,
    xml: string,
    options?: Parameters<typeof signed>[1],
  ) => {
    const request = signed(xml, options);
    return realFetch(`${url}?${request.params}`, {
      method: 'POST',
      body: request.body,
    });
  };

  it('returns the exact decrypted verification challenge', async () => {
    const request = signed('  你好+challenge  ');
    const response = await realFetch(`${address}?${request.params}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('  你好+challenge  ');
    expect(api).not.toHaveBeenCalled();
  });

  it('routes an authenticated DM through access checks and deduplicates retries', async () => {
    expect(await (await post(address, payload())).text()).toBe('success');
    await vi.waitFor(() => expect(channel.received).toHaveLength(1));
    expect(channel.received[0]).toMatchObject({
      senderId: 'alice',
      chatId: 'alice',
      text: '你好 & <code>',
      messageId: '12345',
      isGroup: false,
    });
    await post(address, payload());
    await post(address, payload({ FromUserName: 'denied', MsgId: 'other' }));
    await post(address, payload({ MsgType: 'event', MsgId: 'event' }));
    expect(channel.received).toHaveLength(1);
    expect(api).not.toHaveBeenCalled();
  });

  it('acknowledges while the agent is still running', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const inbound = vi.spyOn(channel, 'handleInbound').mockReturnValue(pending);
    expect(await (await post(address, payload())).text()).toBe('success');
    expect(inbound).toHaveBeenCalledOnce();
    finish();
  });

  it('deduplicates future-dated callbacks throughout their acceptance window', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const request = signed(payload(), {
      timestamp: String((now + 300_000) / 1000),
    });
    const deliver = () =>
      realFetch(`${address}?${request.params}`, {
        method: 'POST',
        body: request.body,
      });
    expect((await deliver()).status).toBe(200);
    await vi.waitFor(() => expect(channel.received).toHaveLength(1));
    for (const elapsed of [300_001, 600_000]) {
      clock.mockReturnValue(now + elapsed);
      expect((await deliver()).status).toBe(200);
      expect(channel.received).toHaveLength(1);
    }
    clock.mockReturnValue(now + 600_001);
    expect((await deliver()).status).toBe(400);
  });

  it('keeps denied senders out of the bounded retry cache', async () => {
    const seen = (channel as unknown as { seen: Map<string, number> }).seen;
    for (let index = 0; index < 9_999; index++) {
      seen.set(`existing-${index}`, Date.now() + 300_000);
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      (
        await post(
          address,
          payload({ FromUserName: 'denied', MsgId: 'denied' }),
        )
      ).status,
    ).toBe(200);
    expect(stderr).toHaveBeenCalledWith(
      '[Channel:callback] preflight rejected reason=sender_denied\n',
    );
    expect(seen.size).toBe(9_999);
    expect((await post(address, payload())).status).toBe(200);
    await vi.waitFor(() => expect(channel.received).toHaveLength(1));
    expect(
      (await post(address, payload({ MsgId: 'over-capacity' }))).status,
    ).toBe(503);
    expect(channel.received).toHaveLength(1);
  });

  it('preserves pairing for senders outside the retry cache', async () => {
    await channel.disconnect();
    channel = new RecordingChannel(
      'callback',
      { ...config, privatePolicy: 'pairing' },
      bridge,
    );
    const pairing = vi
      .spyOn(
        channel as unknown as { onPairingRequired: () => Promise<void> },
        'onPairingRequired',
      )
      .mockResolvedValue();
    await channel.connect();
    expect(
      (await post(address, payload({ FromUserName: 'bob', MsgId: 'pairing' })))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(pairing).toHaveBeenCalledOnce());
    expect(channel.received).toHaveLength(0);
    expect(
      (channel as unknown as { seen: Map<string, number> }).seen.size,
    ).toBe(0);
  });

  it('rejects forged, stale, misrouted and broadcast messages before dispatch', async () => {
    const forged = signed(payload());
    forged.params.set('msg_signature', '0'.repeat(40));
    expect(
      (
        await realFetch(`${address}?${forged.params}`, {
          method: 'POST',
          body: forged.body,
        })
      ).status,
    ).toBe(400);
    expect((await post(address, payload(), { timestamp: '1' })).status).toBe(
      400,
    );
    expect((await post(address, payload(), { corp: 'other' })).status).toBe(
      400,
    );
    for (const overrides of [
      { AgentID: '1' },
      { ToUserName: 'other' },
      { FromUserName: '@all' },
      { FromUserName: 'alice|bob' },
      { MsgId: '' },
    ]) {
      expect((await post(address, payload(overrides))).status).toBe(400);
    }
    expect(channel.received).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });

  it('bounds requests and closes the listener on disconnect', async () => {
    const request = signed('ignored');
    const large = await realFetch(`${address}?${request.params}`, {
      method: 'POST',
      body: 'x'.repeat(65 * 1024),
    });
    expect(large.status).toBe(413);
    expect((await realFetch(address + '/wrong')).status).toBe(404);
    expect((await realFetch(address, { method: 'PUT' })).status).toBe(405);
    await channel.disconnect();
    await expect(realFetch(address)).rejects.toThrow();
    await expect(channel.sendMessage('alice', 'late')).rejects.toThrow(
      'disconnected',
    );
    expect(api).not.toHaveBeenCalled();
  });

  it('reports port conflicts at startup', async () => {
    const second = new WeComCallbackChannel('second', config, bridge);
    await expect(second.connect()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    await second.disconnect();
  });

  it('handles listener errors after startup without exposing error details', async () => {
    const server = (channel as unknown as { server: Server }).server;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() =>
      server.emit('error', new Error('private error detail')),
    ).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom Callback] HTTP server error.\n',
    );
    expect((await post(address, payload())).status).toBe(200);
    await vi.waitFor(() => expect(channel.received).toHaveLength(1));
  });

  it('can stop while startup is pending without leaving a listener', async () => {
    await channel.disconnect();
    const pending = new WeComCallbackChannel('pending', config, bridge);
    const connection = pending.connect();
    const rejected = expect(connection).rejects.toThrow('disconnected');
    await pending.disconnect();
    await rejected;
    await expect(realFetch(address)).rejects.toThrow();
  });

  it('aborts an in-flight application API request on shutdown', async () => {
    api.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const sending = expect(
      channel.sendMessage('alice', 'hello'),
    ).rejects.toThrow('API request failed');
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    await channel.disconnect();
    await sending;
  });

  it.each(['invaliduser', 'unlicenseduser'])(
    'treats a rejected single recipient as a failed delivery: %s',
    async (field) => {
      api
        .mockResolvedValueOnce(
          Response.json({
            errcode: 0,
            access_token: 'token',
            expires_in: 7200,
          }),
        )
        .mockResolvedValueOnce(Response.json({ errcode: 0, [field]: 'alice' }));
      await expect(channel.sendMessage('alice', 'hello')).rejects.toThrow(
        'delivery failed',
      );
      expect(api).toHaveBeenCalledTimes(2);
    },
  );

  it('caches tokens and splits replies without changing Unicode text', async () => {
    const text = '你🙂a'.repeat(700);
    await channel.sendMessage('alice', text);
    const requests = api.mock.calls;
    expect(
      requests.filter(([url]) => String(url).includes('/gettoken?')),
    ).toHaveLength(1);
    const messages = requests
      .filter(([url]) => String(url).includes('/message/send?'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(messages.map((m) => m.text.content).join('')).toBe(text);
    expect(
      messages.every(
        (m) =>
          Buffer.byteLength(m.text.content) <= 2048 &&
          m.touser === 'alice' &&
          m.agentid === 1000002 &&
          !m.toparty &&
          !m.totag,
      ),
    ).toBe(true);
  });

  it.each([40014, 42001])(
    'refreshes an invalid token once for code %s',
    async (code) => {
      api
        .mockResolvedValueOnce(
          Response.json({ errcode: 0, access_token: 'old', expires_in: 7200 }),
        )
        .mockResolvedValueOnce(Response.json({ errcode: code }))
        .mockResolvedValueOnce(
          Response.json({ errcode: 0, access_token: 'new', expires_in: 7200 }),
        )
        .mockResolvedValueOnce(Response.json({ errcode: 0 }));
      await channel.sendMessage('alice', 'hello');
      expect(api).toHaveBeenCalledTimes(4);
      expect(String(api.mock.calls[3]![0])).toContain('access_token=new');
    },
  );

  it('does not retry uncertain delivery or expose platform errors/secrets', async () => {
    api
      .mockResolvedValueOnce(
        Response.json({
          errcode: 0,
          access_token: 'secret-token',
          expires_in: 7200,
        }),
      )
      .mockRejectedValueOnce(
        new Error('https://api?access_token=secret-token'),
      );
    await expect(channel.sendMessage('alice', 'hello')).rejects.toThrow(
      /^WeCom Callback API request failed$/,
    );
    expect(api).toHaveBeenCalledTimes(2);
    api.mockResolvedValueOnce(
      Response.json({ errcode: 81013, errmsg: 'secret-token' }),
    );
    await expect(channel.sendMessage('alice', 'hello')).rejects.toThrow(
      /^WeCom Callback message delivery failed \(code 81013\)$/,
    );
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent token fetches and limits invalid-token retries', async () => {
    await Promise.all([
      channel.sendMessage('alice', '1'),
      channel.sendMessage('bob', '2'),
    ]);
    expect(
      api.mock.calls.filter(([url]) => String(url).includes('/gettoken?')),
    ).toHaveLength(1);
    api
      .mockResolvedValueOnce(Response.json({ errcode: 42001 }))
      .mockResolvedValueOnce(
        Response.json({ errcode: 0, access_token: 'fresh', expires_in: 7200 }),
      )
      .mockResolvedValueOnce(Response.json({ errcode: 42001 }));
    await expect(channel.sendMessage('alice', '3')).rejects.toThrow('42001');
    expect(api).toHaveBeenCalledTimes(6);
  });

  it('rejects multi-recipient and group/thread proactive targets', async () => {
    for (const user of ['@all', '@ALL', 'alice|bob', '', ' alice']) {
      await expect(channel.sendMessage(user, 'hello')).rejects.toThrow(
        'single user',
      );
    }
    expect(
      channel.acceptsTarget({
        channelName: 'callback',
        senderId: 'alice',
        chatId: 'alice',
        isGroup: false,
      }),
    ).toBe(true);
    expect(
      channel.acceptsTarget({
        channelName: 'callback',
        senderId: 'alice',
        chatId: 'alice',
        isGroup: true,
      }),
    ).toBe(false);
    expect(
      channel.acceptsTarget({
        channelName: 'callback',
        senderId: 'alice',
        chatId: 'alice',
        threadId: 'thread',
      }),
    ).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
});
