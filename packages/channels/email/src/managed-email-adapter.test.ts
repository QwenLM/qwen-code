import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { simpleParser } from 'mailparser';
import {
  ManagedEmailAdapter,
  type ManagedChannelControlPlane,
  type ManagedClaimedDelivery,
  type ManagedInboundEvent,
  type ManagedReceipt,
} from './managed-email-adapter.js';

// The managed path replays the Legacy adapter's behavioral cases against a
// fake control plane: one input per platform event, the (sender,
// Message-ID) dedupe window, in-flight claims that survive a lost answer,
// the mailbox-epoch rollover, and sends whose outcome is reported exactly
// as the provider proved it — never retried on the adapter's own.

interface Mailbox {
  epoch: bigint;
  next: number;
  messages: Map<number, Buffer>;
}

class FakeImap extends EventEmitter {
  usable = false;
  constructor(private readonly box: Mailbox) {
    super();
  }
  async connect() {
    this.usable = true;
  }
  async mailboxOpen() {
    return { uidValidity: this.box.epoch, uidNext: this.box.next };
  }
  async status() {
    return {
      uidNext: this.box.next,
      uidValidity: this.box.epoch,
      messages: this.box.messages.size,
    };
  }
  async search(query: { uid: string }) {
    const [start, end] = query.uid.split(':').map(Number);
    return [...this.box.messages.keys()].filter(
      (uid) => uid >= start && uid <= end,
    );
  }
  async fetchAll(uids: number[]) {
    return uids.map((uid) => ({
      uid,
      size: this.box.messages.get(uid)!.length,
    }));
  }
  async fetchOne(
    uid: number,
    query: { headers?: boolean; source?: { maxLength: number } },
  ) {
    const source = this.box.messages.get(uid);
    if (!source) return false;
    if (query.headers)
      return {
        uid,
        headers: Buffer.from(
          source.toString().split('\r\n\r\n')[0] + '\r\n\r\n',
        ),
      };
    return { uid, source: source.subarray(0, query.source?.maxLength) };
  }
  close() {
    this.usable = false;
  }
}

class FakeControlPlane implements ManagedChannelControlPlane {
  registrations: Array<{ accountGeneration: number }> = [];
  events: ManagedInboundEvent[] = [];
  admitted = new Map<string, string>();
  receipts: Array<{ deliveryId: string; receipt: ManagedReceipt }> = [];
  outbox: ManagedClaimedDelivery[] = [];
  failSubmits = 0;
  disconnected = false;

  async register(request: { accountGeneration: number }) {
    this.registrations.push({ accountGeneration: request.accountGeneration });
  }
  async disconnect() {
    this.disconnected = true;
  }
  async submitInbound(event: ManagedInboundEvent) {
    const key = `${event.accountGeneration}:${event.platformEventId}`;
    if (this.failSubmits > 0) {
      this.failSubmits -= 1;
      // The control plane admitted it, but the answer was lost.
      this.admitted.set(key, `chin-${key}`);
      this.events.push(event);
      throw new Error('ECONNRESET');
    }
    const replayed = this.admitted.has(key);
    if (!replayed) {
      this.admitted.set(key, `chin-${key}`);
      this.events.push(event);
    }
    return {
      inputId: this.admitted.get(key)!,
      sessionId: 'session-1',
      replayed,
    };
  }
  async claimDeliveries() {
    const claimed = this.outbox;
    this.outbox = [];
    return claimed;
  }
  async receipt(deliveryId: string, receipt: ManagedReceipt) {
    this.receipts.push({ deliveryId, receipt });
  }
}

let directory: string;
let box: Mailbox;
let sent: ReturnType<typeof vi.fn>;
let plane: FakeControlPlane;
let adapters: ManagedEmailAdapter[];

function raw(
  id: string,
  text = 'hello agent',
  headers: string[] = [],
  from = 'Alice <alice@example.com>',
): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      'To: agent@example.com',
      `Message-ID: <${id}@example.com>`,
      'Subject: Task',
      ...headers,
      '',
      text,
    ].join('\r\n'),
  );
}

function append(source: Buffer): number {
  const uid = box.next++;
  box.messages.set(uid, source);
  return uid;
}

function make(extra: Record<string, unknown> = {}): ManagedEmailAdapter {
  const adapter = new ManagedEmailAdapter({
    name: 'mail',
    cwd: directory,
    config: {
      type: 'email',
      address: 'agent@example.com',
      imapHost: 'imap.example.com',
      imapUser: 'agent',
      imapPassword: 'secret-imap-password',
      smtpHost: 'smtp.example.com',
      smtpUser: 'agent',
      smtpPassword: 'secret-smtp-password',
      allowedUsers: ['ALICE@EXAMPLE.COM'],
      privatePolicy: 'allowlist',
      pollInterval: 5,
      ...extra,
    },
    controlPlane: plane,
    pollLoop: false,
    deps: {
      createImap: async () => new FakeImap(box) as unknown as ImapFlow,
      createSmtp: async () =>
        ({ sendMail: sent, close() {} }) as unknown as Transporter,
      parse: async () => simpleParser,
      lock: async () => async () => {},
      now: () => 1_750_000_000_000,
      log: () => {},
    },
  });
  adapters.push(adapter);
  return adapter;
}

function state(adapter: ManagedEmailAdapter) {
  return JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qwen-managed-email-'));
  vi.stubEnv('QWEN_HOME', directory);
  box = { epoch: 1n, next: 1, messages: new Map() };
  sent = vi.fn(async () => ({ accepted: ['alice@example.com'] }));
  plane = new FakeControlPlane();
  adapters = [];
});

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.disconnect()));
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('managed email inbound', () => {
  it('skips history, admits one event per message, and keeps identical text apart', async () => {
    append(raw('old'));
    const adapter = make();
    await adapter.connect();
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    const first = append(raw('new', 'Please investigate'));
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]).toMatchObject({
      accountGeneration: 1,
      platformEventId: `1:${first}`,
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'alice@example.com',
      },
      senderId: 'alice@example.com',
      subject: 'Task',
      text: 'Please investigate',
      attachments: [],
      replyContext: {
        to: 'alice@example.com',
        parent: '<new@example.com>',
        references: ['<new@example.com>'],
        subject: 'Task',
      },
    });
    expect(state(adapter)).toMatchObject({
      lastUid: first,
      pending: [],
      generation: 1,
    });
    // A second real message with the same text is a second event.
    const second = append(raw('again', 'Please investigate'));
    await adapter.tick();
    expect(plane.events.map((event) => event.platformEventId)).toEqual([
      `1:${first}`,
      `1:${second}`,
    ]);
    // The same Message-ID under a new UID is the Legacy dedupe window's
    // duplicate: skipped before any admission.
    append(raw('again', 'Please investigate'));
    await adapter.tick();
    expect(plane.events).toHaveLength(2);
    expect(state(adapter).recent).toHaveLength(2);
  });

  it('denies senders outside the policy before reading bodies', async () => {
    const adapter = make();
    await adapter.connect();
    append(
      raw('blocked', 'secret', [], 'alice@example.com <mallory@example.com>'),
    );
    append(raw('self', 'secret', [], 'agent@example.com'));
    append(raw('bob', 'secret', [], 'bob@example.com'));
    append(raw('list', 'secret', ['List-Id: test']));
    const good = append(raw('good'));
    await adapter.tick();
    expect(plane.events.map((event) => event.platformEventId)).toEqual([
      `1:${good}`,
    ]);
    expect(state(adapter).lastUid).toBe(good);
  });

  it('keeps a lost admission answer as an in-flight claim and re-drives it, once', async () => {
    const adapter = make();
    await adapter.connect();
    plane.failSubmits = 1;
    const uid = append(raw('lost', 'hello'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([{ uid, eventId: `1:${uid}` }]);
    expect(plane.events).toHaveLength(1);
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events).toHaveLength(1);
    expect(plane.admitted.size).toBe(1);
  });

  it('re-drives in-flight claims after a restart from the immutable platform copy', async () => {
    const adapter = make();
    await adapter.connect();
    plane.failSubmits = 1;
    const uid = append(raw('restart', 'hello after restart'));
    await adapter.tick();
    await adapter.disconnect();
    expect(state(adapter).pending).toEqual([{ uid, eventId: `1:${uid}` }]);
    const restarted = make();
    await restarted.connect();
    await restarted.tick();
    expect(state(restarted).pending).toEqual([]);
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]!.text).toBe('hello after restart');
  });

  it('rolls the account generation on a mailbox epoch change and drops the old in-flight claims visibly', async () => {
    const log = vi.fn();
    const adapter = make();
    (adapter as unknown as { log: (line: string) => void }).log = log;
    await adapter.connect();
    plane.failSubmits = 1;
    append(raw('inflight', 'x'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    box.epoch = 2n;
    box.messages.clear();
    box.next = 1;
    await adapter.tick();
    expect(state(adapter)).toMatchObject({
      uidValidity: '2',
      generation: 2,
      pending: [],
    });
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 2 },
    ]);
    const uid = append(raw('fresh', 'new epoch'));
    await adapter.tick();
    expect(plane.events.at(-1)).toMatchObject({
      accountGeneration: 2,
      platformEventId: `2:${uid}`,
    });
  });

  it('stages bounded attachments as base64 and skips calendar and message parts', async () => {
    const adapter = make();
    await adapter.connect();
    const boundary = 'b1';
    const message = Buffer.from(
      [
        'From: Alice <alice@example.com>',
        'To: agent@example.com',
        'Message-ID: <att@example.com>',
        'Subject: Files',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain',
        '',
        'see attached',
        `--${boundary}`,
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        '',
        'hello',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    );
    append(message);
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]!.attachments).toEqual([
      {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        bytesBase64: Buffer.from('hello').toString('base64'),
      },
    ]);
  });
});

describe('managed email outbound', () => {
  function delivery(id = 'd-1', text = 'Done.'): ManagedClaimedDelivery {
    return {
      deliveryId: id,
      replyContext: {
        to: 'alice@example.com',
        parent: '<new@example.com>',
        references: ['<new@example.com>'],
        subject: 'Task',
      },
      segments: [{ ordinal: 0, segmentId: `${id}:0`, text }],
    };
  }

  it('sends a claimed reply into the thread and reports the provider acceptance', async () => {
    const adapter = make();
    await adapter.connect();
    append(raw('new', 'question'));
    await adapter.tick();
    plane.outbox = [delivery()];
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(1);
    const mail = sent.mock.calls[0]![0] as Record<string, unknown>;
    expect(mail).toMatchObject({
      to: 'alice@example.com',
      envelope: { from: 'agent@example.com', to: ['alice@example.com'] },
      subject: 'Re: Task',
      inReplyTo: '<new@example.com>',
      references: ['<new@example.com>'],
      text: 'Done.',
      headers: {
        'Auto-Submitted': 'auto-replied',
        'X-Qwen-Code-Agent': 'email-channel',
      },
    });
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: mail['messageId'],
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    expect(state(adapter).outbound).toEqual([]);
    // Our Message-ID joined the thread, so a reply to it maps back.
    expect(state(adapter).routes[0].ids).toContain(mail['messageId']);
    const followup = append(
      raw('reply', 'thanks', [
        `In-Reply-To: ${mail['messageId']}`,
        `References: <new@example.com> ${mail['messageId']}`,
      ]),
    );
    await adapter.tick();
    expect(plane.events.at(-1)).toMatchObject({
      platformEventId: `1:${followup}`,
      threadId: plane.events[0]!.threadId,
    });
  });

  it('reports a definitive SMTP refusal as rejected and anything ambiguous as unknown, retrying neither', async () => {
    const adapter = make();
    await adapter.connect();
    sent.mockRejectedValueOnce(
      Object.assign(new Error('550 no such user'), { responseCode: 550 }),
    );
    plane.outbox = [delivery('d-rejected')];
    await adapter.tick();
    sent.mockRejectedValueOnce(new Error('socket timeout'));
    plane.outbox = [delivery('d-unknown')];
    await adapter.tick();
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-rejected', receipt: { outcome: 'rejected' } },
      { deliveryId: 'd-unknown', receipt: { outcome: 'unknown' } },
    ]);
    expect(state(adapter).outbound).toEqual([]);
  });

  it('refuses a reply target the policy does not allow without guessing another', async () => {
    const adapter = make();
    await adapter.connect();
    plane.outbox = [
      {
        ...delivery('d-foreign'),
        replyContext: {
          ...(delivery().replyContext as object),
          to: 'mallory@example.com',
        },
      },
      { ...delivery('d-bare'), replyContext: null },
    ];
    await adapter.tick();
    expect(sent).not.toHaveBeenCalled();
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-foreign', receipt: { outcome: 'rejected' } },
      { deliveryId: 'd-bare', receipt: { outcome: 'rejected' } },
    ]);
  });

  it('reports a segment sent before a crash as unknown on restart, never sending it again', async () => {
    const adapter = make();
    await adapter.connect();
    sent.mockImplementationOnce(async () => {
      // The process dies after the provider took the message.
      throw Object.assign(new Error('crash'), { crash: true });
    });
    plane.outbox = [delivery('d-crash')];
    // Simulate the crash window: the claim persists, the receipt never
    // happens because the adapter is torn down mid-send.
    const original = plane.receipt.bind(plane);
    plane.receipt = async () => {
      throw new Error('process died');
    };
    await expect(adapter.tick()).rejects.toThrow('process died');
    await adapter.disconnect();
    expect(state(adapter).outbound).toEqual([
      {
        deliveryId: 'd-crash',
        ordinal: 0,
        messageId: expect.stringMatching(/^<.+@example\.com>$/),
      },
    ]);
    plane.receipt = original;
    const restarted = make();
    await restarted.connect();
    expect(plane.receipts).toEqual([
      { deliveryId: 'd-crash', receipt: { outcome: 'unknown' } },
    ]);
    expect(state(restarted).outbound).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('tells the control plane when it disconnects', async () => {
    const adapter = make();
    await adapter.connect();
    await adapter.disconnect();
    expect(plane.disconnected).toBe(true);
  });
});
