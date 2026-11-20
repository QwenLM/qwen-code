import { EventEmitter } from 'node:events';
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
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { simpleParser } from 'mailparser';
import { MANAGED_OUTBOUND_LIMIT } from '@qwen-code/channel-base';
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
  destinationKey = '';
  registrations: Array<{ accountGeneration: number }> = [];
  events: ManagedInboundEvent[] = [];
  admitted = new Map<string, string>();
  receipts: Array<{ deliveryId: string; receipt: ManagedReceipt }> = [];
  outbox: ManagedClaimedDelivery[] = [];
  failSubmits = 0;
  refuseSubmitsWithStatus = 0;
  failRegisters = 0;
  enforceGenerationFence = false;
  highestGeneration = 0;
  registerGate?: Promise<void>;
  registerEntered?: () => void;
  submitErrors: Array<{ status: number; code?: string }> = [];
  receiptErrors: Array<{ status: number; code?: string }> = [];
  submitAttempts = 0;
  disconnected = false;

  async register(request: { accountGeneration: number }) {
    this.registerEntered?.();
    if (this.registerGate) await this.registerGate;
    this.registrations.push({ accountGeneration: request.accountGeneration });
    // Mirror the control plane's monotonic fence: a generation below the
    // highest it has seen is refused channel_generation_stale (R1-8).
    if (this.enforceGenerationFence) {
      if (request.accountGeneration < this.highestGeneration) {
        throw Object.assign(new Error('HTTP 409'), {
          status: 409,
          code: 'channel_generation_stale',
        });
      }
      this.highestGeneration = request.accountGeneration;
    }
    if (this.failRegisters > 0) {
      this.failRegisters -= 1;
      throw new Error('ECONNRESET');
    }
  }
  async disconnect() {
    this.disconnected = true;
  }
  async submitInbound(event: ManagedInboundEvent) {
    this.submitAttempts += 1;
    if (this.submitErrors.length > 0) {
      const failure = this.submitErrors.shift()!;
      throw Object.assign(new Error(`HTTP ${failure.status}`), {
        status: failure.status,
        code: failure.code,
      });
    }
    const key = `${event.accountGeneration}:${event.platformEventId}`;
    if (this.refuseSubmitsWithStatus) {
      // A deterministic refusal: nothing was admitted.
      throw Object.assign(new Error(`HTTP ${this.refuseSubmitsWithStatus}`), {
        status: this.refuseSubmitsWithStatus,
      });
    }
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
  async claimDeliveries(_limit: number) {
    const claimed = this.outbox;
    this.outbox = [];
    return claimed;
  }
  async receipt(deliveryId: string, receipt: ManagedReceipt) {
    if (this.receiptErrors.length > 0) {
      const failure = this.receiptErrors.shift()!;
      throw Object.assign(new Error(`HTTP ${failure.status}`), {
        status: failure.status,
        code: failure.code,
      });
    }
    this.receipts.push({ deliveryId, receipt });
  }
}

let directory: string;
let box: Mailbox;
let sent: ReturnType<typeof vi.fn>;
let plane: FakeControlPlane;
let adapters: ManagedEmailAdapter[];
let lockCompromised: (() => void) | undefined;
let lifecycle: string[] = [];

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

function make(
  extra: Record<string, unknown> = {},
  depsExtra: Record<string, unknown> = {},
  options: { pollLoop?: boolean } = {},
): ManagedEmailAdapter {
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
    pollLoop: options.pollLoop ?? false,
    deps: {
      createImap: async () => new FakeImap(box) as unknown as ImapFlow,
      createSmtp: async () =>
        ({ sendMail: sent, close() {} }) as unknown as Transporter,
      parse: async () => simpleParser,
      lock: async (_dir: string, onCompromised: () => void) => {
        lockCompromised = onCompromised;
        return async () => {
          lifecycle.push('lock');
        };
      },
      now: () => 1_750_000_000_000,
      log: () => {},
      ...depsExtra,
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
  lockCompromised = undefined;
  lifecycle = [];
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

  it('drops an in-flight claim whose sender the restarted policy no longer allows, without resubmitting', async () => {
    const log = vi.fn();
    const adapter = make();
    (adapter as unknown as { log: (line: string) => void }).log = log;
    await adapter.connect();
    plane.failSubmits = 1;
    append(raw('gone', 'still pending'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    expect(plane.submitAttempts).toBe(1);
    await adapter.disconnect();
    // The allowlist no longer covers the sender when the adapter restarts.
    const restarted = make({ allowedUsers: [] });
    (restarted as unknown as { log: (line: string) => void }).log = log;
    await restarted.connect();
    await restarted.tick();
    await restarted.tick();
    expect(state(restarted).pending).toEqual([]);
    // The event was never resubmitted: one attempt at first sight, none
    // after the policy dropped the claim.
    expect(plane.submitAttempts).toBe(1);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'refused by the current sender policy',
    );
  });

  it('stops polling and stays silent when another owner takes the state lock', async () => {
    const adapter = make();
    await adapter.connect();
    expect(lockCompromised).toBeTypeOf('function');
    append(raw('lost', 'hello'));
    lockCompromised!();
    await adapter.tick();
    await adapter.tick();
    // Nothing is admitted or claimed after a compromise reaps the lock.
    expect(plane.events).toHaveLength(0);
    expect(state(adapter).pending).toEqual([]);
    await adapter.disconnect();
  });

  it('stops persisting after the state lock is compromised (#17173 R6/R7 parity)', async () => {
    const adapter = make();
    await adapter.connect();
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const saveSpy = vi.spyOn(store, 'save');
    // Park the tick inside submitInbound so its post-answer persist lands after
    // the compromise — the in-flight tick, not a shutdown drain, is the writer
    // the ownership guard must silence.
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let submitEntered!: () => void;
    const enteredSubmit = new Promise<void>((resolve) => {
      submitEntered = resolve;
    });
    const originalSubmit = plane.submitInbound.bind(plane);
    plane.submitInbound = async (event) => {
      submitEntered();
      await submitGate;
      return originalSubmit(event);
    };
    append(raw('m1', 'hello'));
    const ticking = adapter.tick();
    // The email tick polls the mailbox before it submits; wait until it is
    // actually parked inside submitInbound, not merely started.
    await enteredSubmit;
    saveSpy.mockClear();
    lockCompromised!(); // a second owner won the mailbox mid-tick
    releaseSubmit();
    await ticking;
    expect(saveSpy).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it('re-drives a failed re-register on the next poll, never skipping new mail', async () => {
    const adapter = make();
    await adapter.connect();
    append(raw('before', 'epoch one'));
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    // The mailbox re-keys, and the generation-2 registration dies on the
    // wire once. The next polls must re-register, not let the new epoch's
    // mail hit an unregistered generation.
    plane.failRegisters = 1;
    box.epoch = 2n;
    box.messages.clear();
    box.next = 1;
    await expect(adapter.tick()).rejects.toThrow();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 2 },
    ]);
    append(raw('after', 'epoch two mail'));
    await adapter.tick();
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 2 },
      { accountGeneration: 2 },
    ]);
    expect(plane.events.at(-1)).toMatchObject({
      accountGeneration: 2,
      text: 'epoch two mail',
    });
  });

  it('re-registers when the control plane forgot the generation, keeping the mail', async () => {
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 409, code: 'channel_generation_unregistered' },
    ];
    append(raw('waiting', 'register forgot'));
    await adapter.tick();
    // The event stays claimed, and the lost registration — not the
    // message — is what the next poll re-drives.
    expect(state(adapter).pending).toHaveLength(1);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 1 },
    ]);
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.at(-1)).toMatchObject({ text: 'register forgot' });
  });

  it('re-registers when the control plane reports disconnected, keeping the mail (R3-3)', async () => {
    // A disconnect answer is the poll-level registration claim too: an
    // unfenced disconnect flipped the instance under the live adapter, and
    // only register heals `connected` — dropping the mail as a per-message
    // deterministic refusal would advance lastUid with nothing left to
    // re-drive, losing every further inbound until a process restart.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.submitErrors = [{ status: 409, code: 'channel_disconnected' }];
    append(raw('waiting', 'disconnect flip'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 1 },
    ]);
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.at(-1)).toMatchObject({ text: 'disconnect flip' });
    // The control plane answered, deterministically: the log says
    // "refused", never "did not answer".
    expect(lines.some((line) => line.includes('did not answer'))).toBe(false);
    expect(lines.some((line) => line.includes('was refused'))).toBe(true);
  });

  it('keeps a refused event the provider later expunges (R3-3)', async () => {
    // The refusal branch's pendingEvents.set is the only thing standing
    // between this mail and a provider expunge during the disconnect:
    // without it the re-drive rebuilds from the platform copy, finds the
    // message gone, and drops the claim the branch exists to keep.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.submitErrors = [{ status: 409, code: 'channel_disconnected' }];
    const uid = append(raw('waiting', 'expunge me'));
    await adapter.tick();
    box.messages.delete(uid);
    await adapter.tick();
    expect(plane.events.at(-1)).toMatchObject({ text: 'expunge me' });
    expect(
      lines.some((line) => line.includes('can no longer be rebuilt')),
    ).toBe(false);
  });

  it('stops re-driving the pending backlog once a refusal resets registration (R3-3)', async () => {
    // The first poll-level refusal already proves no later submit this
    // tick can converge: the rest of the backlog waits for the next
    // poll's re-register instead of each eating a refused submit plus a
    // retry delay.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 409, code: 'channel_disconnected' },
      { status: 409, code: 'channel_disconnected' },
      { status: 409, code: 'channel_disconnected' },
    ];
    append(raw('one', 'first'));
    await adapter.tick();
    // The backlog's second entry arrives on the next poll: the admit
    // loop stopped with the first refusal, so it is searched again.
    append(raw('two', 'second'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(2);
    expect(plane.submitAttempts).toBe(3);
    plane.submitErrors = [{ status: 409, code: 'channel_disconnected' }];
    const before = plane.submitAttempts;
    await adapter.tick();
    expect(plane.submitAttempts - before).toBe(1);
    expect(state(adapter).pending).toHaveLength(2);
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events).toHaveLength(2);
  });

  it('drops a 409 that is not a registration refusal, visibly (R3-3)', async () => {
    // Any other 409 verdict — a stale generation, a route conflict — is
    // a deterministic per-message refusal: the mail is skipped, and no
    // re-register follows.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [{ status: 409, code: 'channel_generation_stale' }];
    append(raw('waiting', 'stale generation'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    expect(plane.events).toEqual([]);
  });

  it('drops a per-message 404 that is not a registration refusal, never freezing the mailbox (R3-1)', async () => {
    // A 404 on submit can name a route session or workspace gone under a
    // live, connected instance — a per-message verdict, not a poll-level
    // registration claim. Treating it as one keeps the poison claim
    // pending and re-registers every poll, and the dead-tick guard then
    // freezes every later claim behind it.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [{ status: 404, code: 'workspace_not_found' }];
    append(raw('one', 'first'));
    append(raw('two', 'second'));
    await adapter.tick();
    await adapter.tick();
    // The poison message is dropped visibly, the mail behind it flows in
    // the same poll, and no re-register is ever armed.
    expect(plane.events.map((event) => event.text)).toEqual(['second']);
    expect(state(adapter).pending).toEqual([]);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
  });

  it('bounds the workspace refusal sacrifice per episode, never re-granted by an interleaved admission (R10-1)', async () => {
    // The streak counts CONSECUTIVE instance-scoped verdicts, but the
    // reply-driven traffic of a real mailbox interleaves fresh
    // admissions between the refusals: an already-bound thread's reply
    // resolves its workspace through the existing binding row, so it
    // admits while the binding a new route meets stays broken. If each
    // such admission zeroed the streak, the consecutive pair the stall
    // needs would never form and every refusal would drop as a first
    // occurrence — destroying one message per interleave, unbounded,
    // while the stall that exists to bound it never arms. The lift
    // waits for the held claim's own fresh admission, the one answer
    // that proves the binding itself answers again.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    const submit = plane.submitInbound.bind(plane);
    // refuse (a new route meets the broken binding) -> admit fresh (a
    // bound thread's reply short-circuits the resolution) -> refuse.
    const script: Array<{ status: number; code: string } | undefined> = [
      { status: 404, code: 'workspace_not_found' },
      undefined,
      { status: 404, code: 'workspace_not_found' },
    ];
    plane.submitInbound = async (event: ManagedInboundEvent) => {
      const failure = script.shift();
      if (failure) {
        plane.submitAttempts += 1;
        throw Object.assign(new Error(`HTTP ${failure.status}`), {
          status: failure.status,
          code: failure.code,
        });
      }
      return submit(event);
    };
    append(raw('one', 'first'));
    append(raw('two', 'bound-thread reply'));
    const held = append(raw('three', 'third'));
    await adapter.tick();
    // The first refusal dropped as the poison message it may be (R3-1);
    // the interleaved fresh admission re-grants nothing, so the second
    // refusal is the consecutive pair that holds its claim and arms the
    // stall — never a second first-occurrence drop.
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(1);
    expect(lines.some((line) => line.includes('stopped admitting'))).toBe(true);
    expect(plane.events.map((event) => event.text)).toEqual([
      'bound-thread reply',
    ]);
  });

  it('stalls admission on consecutive workspace_not_found refusals instead of dropping every message (R5-1)', async () => {
    // workspace_not_found is instance-scoped: every determinant of the
    // verdict comes from the channel instance row, so each inbound meets
    // it identically and no retry heals it. Dropping each as an
    // independent poison claim destroys the whole inbound flow behind
    // one routine log line while the channel keeps reporting connected.
    // The first drop stays (R3-1); the second consecutive verdict holds
    // its claim and stalls the search, so the mail stays re-searchable
    // until the binding answers again.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    const submit = plane.submitInbound.bind(plane);
    plane.submitInbound = async () => {
      plane.submitAttempts += 1;
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    append(raw('one', 'first'));
    const held = append(raw('two', 'second'));
    append(raw('three', 'third'));
    await adapter.tick();
    // The first poison claim dropped (R3-1); the second tripped the
    // stall and is held, so the search stopped at it and the mail behind
    // it was never admitted.
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(state(adapter).lastUid).toBe(held);
    expect(plane.events).toEqual([]);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    append(raw('four', 'fourth'));
    await adapter.tick();
    // One probe re-drive per poll, and the mail that arrived under the
    // stall is never admitted to its destruction.
    expect(plane.submitAttempts).toBe(3);
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(state(adapter).lastUid).toBe(held);
    expect(plane.events).toEqual([]);
    const stalled = lines.filter((line) => line.includes('stopped admitting'));
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toContain('--workspace');
    expect(lines.join('\n')).toContain('the message is skipped');
    expect(state(adapter).instanceRefusals).toBeGreaterThan(1);
    // The binding answers again: the held claim converges and the
    // mailbox behind it flows in the same poll, no restart.
    plane.submitInbound = submit;
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.map((event) => event.text)).toEqual([
      'second',
      'third',
      'fourth',
    ]);
    // The held claim's fresh admission proves the binding: the streak
    // resets, so the next episode starts clean.
    expect(state(adapter).instanceRefusals).toBe(0);
  });

  it.each([
    { status: 403, code: 'workspace_forbidden' },
    { status: 409, code: 'workspace_unavailable' },
  ])(
    'stalls admission on consecutive $code refusals instead of dropping every message (R6-1)',
    async ({ status, code }) => {
      // workspace_forbidden (the actor demoted past create) and
      // workspace_unavailable (the bound workspace no longer ACTIVE) are
      // instance-scoped like workspace_not_found: every determinant of
      // the verdict comes from the channel instance row, so each inbound
      // meets it identically and no retry heals it. They take the same
      // bounded stall — the first drop stays (R3-1), the second
      // consecutive verdict holds its claim — not an unbounded
      // first-occurrence drop destroying every new-thread message behind
      // one routine log line while the channel reports connected.
      const lines: string[] = [];
      const adapter = make({}, { log: (line: string) => lines.push(line) });
      await adapter.connect();
      plane.submitInbound = async () => {
        plane.submitAttempts += 1;
        throw Object.assign(new Error(`HTTP ${status}`), { status, code });
      };
      append(raw('one', 'first'));
      const held = append(raw('two', 'second'));
      append(raw('three', 'third'));
      await adapter.tick();
      // The first poison claim dropped (R3-1); the second tripped the
      // stall and is held, so the third was never admitted.
      expect(state(adapter).pending).toEqual([
        { uid: held, eventId: `1:${held}`, held: true },
      ]);
      expect(state(adapter).lastUid).toBe(held);
      expect(plane.events).toEqual([]);
      append(raw('four', 'fourth'));
      await adapter.tick();
      // The stall gates the search: mail arriving under it is never
      // admitted to its destruction either.
      expect(state(adapter).pending).toEqual([
        { uid: held, eventId: `1:${held}`, held: true },
      ]);
      expect(state(adapter).lastUid).toBe(held);
      expect(plane.events).toEqual([]);
      expect(
        lines.filter((line) => line.includes('stopped admitting')),
      ).toHaveLength(1);
    },
  );

  it('re-probes one held claim per poll while the workspace stall holds (R5-1)', async () => {
    // The held claim's re-drive is the probe that lifts the stall, and
    // one probe per poll is enough: the verdict cannot change within a
    // tick, so re-driving the entries behind it would only spend a
    // refused submit plus the retry delay each, stretching the tick
    // toward the claim lease.
    const adapter = make();
    await adapter.connect();
    plane.failSubmits = 3;
    append(raw('a', 'lost a'));
    append(raw('b', 'lost b'));
    append(raw('c', 'lost c'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(3);
    const submit = plane.submitInbound.bind(plane);
    plane.submitInbound = async () => {
      plane.submitAttempts += 1;
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    await adapter.tick();
    // The first verdict dropped the oldest claim as the poison message
    // it may be (R3-1); the second held its claim and stalled the
    // search, leaving the third entry behind them.
    expect(state(adapter).pending.map((entry) => entry.uid)).toEqual([2, 3]);
    const before = plane.submitAttempts;
    await adapter.tick();
    expect(plane.submitAttempts - before).toBe(1);
    expect(state(adapter).pending.map((entry) => entry.uid)).toEqual([2, 3]);
    // The binding answers again: the probe converges, the stall lifts,
    // and the rest of the backlog re-drives in the same poll. A held
    // claim can never converge as a replay — it was held because the
    // server left no admitted row behind — so the recovery converges on
    // fresh admissions: the first tick's lost-answer admits are cleared,
    // or the lift meets a replayed 200, which proves nothing about the
    // binding (R8-1).
    plane.admitted.clear();
    plane.submitInbound = submit;
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.admitted.size).toBe(2);
  });

  it('never resets the refusal streak on a replayed answer (R8-1)', async () => {
    // A replayed 200 is the server's idempotent answer to a claim it
    // already admitted: the existing binding row short-circuits the
    // workspace resolution, so the answer proves nothing about the
    // refusal's cause. Resetting the streak on it re-grants the
    // episode's sacrifice with the binding still broken, and the next
    // fresh submit's refusal falls to the first-occurrence drop —
    // destroying the mail the stall kept re-searchable. Held claims
    // probe first (R9-1), so a replay reaches the probe only once
    // nothing is held: the held claim's drop on a per-message verdict
    // lifts the stall — nothing remains to probe with — and leaves the
    // replayable claim behind it.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    append(raw('x', 'first occurrence'));
    const lost = append(raw('m', 'lost answer'));
    const held = append(raw('h', 'held'));
    // One tick builds pending = [M, H]: the first refusal drops its
    // claim as the poison message it may be (R3-1), M is admitted
    // server-side but its answer is lost, and H's refusal — the second
    // consecutive — is held with the stall armed.
    const submit = plane.submitInbound.bind(plane);
    const script: Array<(event: ManagedInboundEvent) => never> = [
      () => {
        throw Object.assign(new Error('HTTP 404'), {
          status: 404,
          code: 'workspace_not_found',
        });
      },
      (event) => {
        const key = `${event.accountGeneration}:${event.platformEventId}`;
        plane.admitted.set(key, `chin-${key}`);
        plane.events.push(event);
        throw new Error('answer lost');
      },
      () => {
        throw Object.assign(new Error('HTTP 404'), {
          status: 404,
          code: 'workspace_not_found',
        });
      },
      // The held claim's probe meets a per-message verdict and drops:
      // only the replayable claim remains, and the stall lifts with
      // nothing held.
      () => {
        throw Object.assign(new Error('HTTP 409'), {
          status: 409,
          code: 'channel_route_conflict',
        });
      },
    ];
    plane.submitInbound = async (event) => {
      const step = script.shift();
      if (step) {
        plane.submitAttempts += 1;
        return step(event);
      }
      // The binding stays broken for a fresh submit; a claim the server
      // already admitted replays.
      const key = `${event.accountGeneration}:${event.platformEventId}`;
      if (plane.admitted.has(key)) return submit(event);
      plane.submitAttempts += 1;
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: lost, eventId: `1:${lost}` },
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    // The sacrifice's first-occurrence drop is the one expected skip.
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(1);
    // The held claim's probe drops on the per-message verdict: with
    // nothing held the stall lifts — the drop is no proof the binding
    // answers — and the replayable claim behind it settles within the
    // same poll. The lift is the drop's own; the replay that settles M
    // proves nothing, so the streak stands.
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(2);
    expect(lines.filter((line) => line.includes('resumed'))).toHaveLength(1);
    // The binding still refuses fresh submits. Had the replay zeroed the
    // streak, this refusal would fall to the first-occurrence drop and
    // destroy the mail; the preserved streak re-holds it instead.
    const behind = append(raw('n', 'new mail behind the stall'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: behind, eventId: `1:${behind}`, held: true },
    ]);
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(2);
    // The binding answers again: the held claim's fresh admission is the
    // one proof that lifts the stall.
    plane.submitInbound = submit;
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.map((event) => event.text)).toEqual([
      'lost answer',
      'new mail behind the stall',
    ]);
    expect(lines.some((line) => line.includes('resumed'))).toBe(true);
  });

  it('probes the held claim first, so a stuck earlier claim cannot shadow the stall lift (R9-1)', async () => {
    // The stall's one probe per poll lifts only inside submit() on a
    // fresh admission, and the held claim is always the LAST entry of
    // pending — pushed by the admit that armed the stall, behind every
    // earlier in-flight claim. Probing in push order submits the
    // earliest claim and returns on the still-armed stall, so an
    // earlier claim whose answer never comes shadows the probe: the
    // held claim is never submitted, the stall never lifts, and inbound
    // mail wedges behind it, across restarts (pending is persisted).
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    const stuck = append(raw('a', 'stuck behind'));
    const sacrifice = append(raw('b', 'first occurrence'));
    const held = append(raw('c', 'held mail'));
    // One tick builds pending = [A, H]: A's submit answer is lost (no
    // verdict — the claim stays pending), B's refusal drops as the
    // poison message it may be (R3-1), and H's — the second consecutive
    // instance-scoped refusal — is held with the stall armed.
    const submit = plane.submitInbound.bind(plane);
    const script: Record<string, Array<() => never>> = {
      [`1:${stuck}`]: [
        () => {
          throw new Error('answer lost');
        },
        () => {
          throw Object.assign(new Error('HTTP 400'), { status: 400 });
        },
      ],
      [`1:${sacrifice}`]: [
        () => {
          throw Object.assign(new Error('HTTP 404'), {
            status: 404,
            code: 'workspace_not_found',
          });
        },
      ],
      [`1:${held}`]: [
        () => {
          throw Object.assign(new Error('HTTP 404'), {
            status: 404,
            code: 'workspace_not_found',
          });
        },
      ],
    };
    plane.submitInbound = async (event) => {
      const step = script[event.platformEventId]?.shift();
      if (step) {
        plane.submitAttempts += 1;
        return step();
      }
      return submit(event);
    };
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: stuck, eventId: `1:${stuck}` },
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    // The stuck claim's re-drive fails again — a per-message verdict
    // this time — while the held claim's submit now succeeds. The held
    // claim probes first: the stall lifts on its fresh admission, and
    // the stuck claim drops behind it instead of shadowing the probe.
    await adapter.tick();
    expect(lines.some((line) => line.includes('resumed'))).toBe(true);
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.map((event) => event.text)).toEqual(['held mail']);
    // The search reopens behind the lifted stall.
    append(raw('d', 'after the lift'));
    await adapter.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'held mail',
      'after the lift',
    ]);
  });

  it('starts the workspace streak clean after a mailbox epoch change (R5-1)', async () => {
    // The epoch change drops the stall's held claim with the rest of the
    // old generation's in-flight set: a stall that kept gating the new
    // epoch's search would wedge the mailbox with nothing left to
    // re-probe it, so the streak starts clean with the new generation.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 404, code: 'workspace_not_found' },
      { status: 404, code: 'workspace_not_found' },
    ];
    append(raw('one', 'first'));
    append(raw('two', 'second'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    expect(state(adapter).instanceRefusals).toBe(2);
    // The mailbox re-keys under the stall; the new epoch's mail must
    // meet a fresh streak, not the old one's gate.
    box.epoch = 2n;
    box.messages.clear();
    box.next = 1;
    await adapter.tick();
    expect(state(adapter)).toMatchObject({
      uidValidity: '2',
      pending: [],
      instanceRefusals: 0,
    });
    const uid = append(raw('three', 'new epoch'));
    await adapter.tick();
    expect(plane.events.at(-1)).toMatchObject({
      accountGeneration: 2,
      platformEventId: `2:${uid}`,
    });
  });

  it('reopens the search once a stalled claim drops on a per-message verdict (R7-1)', async () => {
    // The stall's held claim can still meet a deterministic verdict that
    // is not instance-scoped — a route conflict, a failing body — and
    // drop. If the stall flag kept gating the search past that drop, no
    // claim would remain to probe with and the mailbox would wedge for
    // the rest of the process's life: the gate holds only while a claim
    // is actually held. The streak stays above the limit, so the next
    // instance-scoped refusal re-holds without an extra drop.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 404, code: 'workspace_not_found' },
      { status: 404, code: 'workspace_not_found' },
    ];
    append(raw('one', 'first'));
    const held = append(raw('two', 'second'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    // The held claim's re-drive meets a per-message verdict and drops.
    plane.submitErrors = [{ status: 409, code: 'channel_route_conflict' }];
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    // With nothing held the search reopens: the next mail is admitted.
    const fifth = append(raw('five', 'fifth'));
    await adapter.tick();
    expect(plane.events.map((event) => event.text)).toEqual(['fifth']);
    expect(state(adapter).lastUid).toBe(fifth);
  });

  it('lifts the stall when the held claim drops on a per-message verdict, resuming full throughput', async () => {
    // The held claim is the stall's only probe: once a per-message
    // verdict drops it, nothing remains to probe with, and a flag kept
    // armed gates every later poll to a single admit — one mail per
    // minute at the default interval — while pinning every settled
    // event in the cache behind resubmitPending's stall return. The
    // refusal streak stands, so a still-broken binding re-holds the
    // next mail without a new sacrifice.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 404, code: 'workspace_not_found' },
      { status: 404, code: 'workspace_not_found' },
    ];
    append(raw('one', 'first'));
    const held = append(raw('two', 'second'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    // The held claim's re-drive meets a per-message verdict and drops.
    plane.submitErrors = [{ status: 409, code: 'channel_route_conflict' }];
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    // The mail behind the dropped claim flows in ONE poll, not one
    // message per poll.
    append(raw('n1', 'one behind'));
    append(raw('n2', 'two behind'));
    append(raw('n3', 'three behind'));
    await adapter.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'one behind',
      'two behind',
      'three behind',
    ]);
    // The refusal streak still stands: a still-broken binding re-holds
    // the next mail instead of dropping it as a first occurrence.
    plane.submitErrors = [{ status: 404, code: 'workspace_not_found' }];
    const reheld = append(raw('n4', 're-held'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: reheld, eventId: `1:${reheld}`, held: true },
    ]);
    expect(plane.events).toHaveLength(3);
  });

  it('lifts the stall when a replayed answer settles the held claim, draining the event cache', async () => {
    // The binding answers again but the fresh admission's own answer is
    // lost on the wire: the next poll's re-drive settles the held claim
    // as a REPLAY — no proof the binding answers, so the streak stands,
    // yet with nothing held the stall has no probe left and must lift,
    // or every later poll admits a single message and every settled
    // event stays in the cache.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 404, code: 'workspace_not_found' },
      { status: 404, code: 'workspace_not_found' },
    ];
    append(raw('one', 'first'));
    const held = append(raw('two', 'held'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    // The probe is admitted server-side, but the answer never arrives.
    plane.failSubmits = 1;
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    // The re-drive settles the claim as a replay: the stall lifts and
    // the settled event leaves the cache, but the streak stands.
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(state(adapter).instanceRefusals).toBe(2);
    expect(
      (adapter as unknown as { pendingEvents: Map<number, unknown> })
        .pendingEvents.size,
    ).toBe(0);
    // Full throughput resumes: the mail behind it flows in one poll.
    append(raw('n1', 'one behind'));
    append(raw('n2', 'two behind'));
    append(raw('n3', 'three behind'));
    await adapter.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'held',
      'one behind',
      'two behind',
      'three behind',
    ]);
    // A lost-answer cycle after the lift leaves nothing cached either.
    plane.failSubmits = 1;
    append(raw('n4', 'four behind'));
    await adapter.tick();
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(
      (adapter as unknown as { pendingEvents: Map<number, unknown> })
        .pendingEvents.size,
    ).toBe(0);
  });

  it('lifts the stall when the restarted held claim can no longer be rebuilt', async () => {
    // A restart re-arms the stall from the persisted held marker, but
    // the platform copy the re-drive rebuilds from can be gone: the
    // claim drops, and a flag kept armed would throttle the mailbox it
    // can no longer probe.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [
      { status: 404, code: 'workspace_not_found' },
      { status: 404, code: 'workspace_not_found' },
    ];
    append(raw('one', 'first'));
    const held = append(raw('two', 'held'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    await adapter.disconnect();
    box.messages.delete(held);
    const restarted = make();
    await restarted.connect();
    await restarted.tick();
    expect(state(restarted).pending).toEqual([]);
    append(raw('n1', 'one behind'));
    append(raw('n2', 'two behind'));
    append(raw('n3', 'three behind'));
    await restarted.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'one behind',
      'two behind',
      'three behind',
    ]);
  });

  it('keeps a stall-held claim across a restart instead of dropping it as a first occurrence (R7-2)', async () => {
    // The streak and the stall flag are in-memory, but the claim they
    // hold is persisted: an unmarked claim meets the restart with a
    // zeroed streak, falls to the first-occurrence drop, and the mail
    // the stall promised to keep is destroyed — one held message per
    // process start for as long as the refusal persists. The held
    // marker persists with the claim, so the restarted process re-holds
    // and re-probes it instead.
    const adapter = make();
    await adapter.connect();
    const submit = plane.submitInbound.bind(plane);
    plane.submitInbound = async () => {
      plane.submitAttempts += 1;
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    append(raw('one', 'first'));
    const held = append(raw('two', 'held mail'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    await adapter.disconnect();
    const restartedLines: string[] = [];
    const restarted = make(
      {},
      { log: (line: string) => restartedLines.push(line) },
    );
    await restarted.connect();
    await restarted.tick();
    // The held claim survives the restart: no first-occurrence drop, no
    // "skipped" line, and the operator's stall hint is re-emitted.
    expect(state(restarted).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(plane.events).toEqual([]);
    expect(restartedLines.join('\n')).not.toContain('the message is skipped');
    expect(
      restartedLines.some((line) => line.includes('stopped admitting')),
    ).toBe(true);
    // The binding answers again: the held mail is admitted, not lost.
    plane.submitInbound = submit;
    await restarted.tick();
    expect(plane.events.map((event) => event.text)).toEqual(['held mail']);
    expect(state(restarted).pending).toEqual([]);
  });

  it('restores the workspace stall from the persisted held claim across a restart (R7-2)', async () => {
    // The streak and the stall flag are in-memory: if nothing derives
    // them from the persisted held marker, a restart re-opens the search
    // behind the held claim, and the next message's admission meets the
    // still-broken binding with a fresh streak — dropped as a first
    // occurrence, one mail destroyed per process start, while the held
    // claim's own re-drive meets a verdict-less failure that never
    // re-arms the stall.
    const adapter = make();
    await adapter.connect();
    const submit = plane.submitInbound.bind(plane);
    plane.submitInbound = async () => {
      plane.submitAttempts += 1;
      const failure = plane.submitErrors.shift();
      if (failure) {
        throw Object.assign(new Error(`HTTP ${failure.status}`), {
          status: failure.status,
          code: failure.code,
        });
      }
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    append(raw('one', 'first'));
    const held = append(raw('two', 'held mail'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    await adapter.disconnect();
    // The restart's first re-drive of the held claim meets a 503 — a
    // failure without a verdict — while the binding still refuses, and
    // new mail arrives behind the held claim.
    plane.submitErrors = [{ status: 503 }];
    const restartedLines: string[] = [];
    const restarted = make(
      {},
      { log: (line: string) => restartedLines.push(line) },
    );
    await restarted.connect();
    // The stall is restored from the persisted marker at load, so the
    // operator hint is re-emitted before the first re-drive.
    expect(
      restartedLines.some((line) => line.includes('stopped admitting')),
    ).toBe(true);
    const behind = append(raw('three', 'behind the stall'));
    await restarted.tick();
    await restarted.tick();
    // The search stays closed behind the held claim: the new mail is
    // never admitted to the refusal that would drop it.
    expect(state(restarted).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(state(restarted).lastUid).toBe(held);
    expect(plane.events).toEqual([]);
    expect(restartedLines.join('\n')).not.toContain('the message is skipped');
    // The binding answers again: the held mail and the mail behind it
    // are admitted, nothing skipped.
    plane.submitInbound = submit;
    await restarted.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'held mail',
      'behind the stall',
    ]);
    expect(state(restarted).pending).toEqual([]);
    expect(state(restarted).lastUid).toBe(behind);
  });

  it('keeps the paid sacrifice across a restart, so the next refusal holds instead of dropping again (R10-1)', async () => {
    // The sacrifice is a PER-EPISODE budget, but the streak behind it
    // is in-memory: a restart between the paid drop and the next
    // verdict reloads it as 0, so each process start destroys one more
    // message while the binding stays broken — the loss the persisted
    // held marker exists to prevent, one drop earlier. The streak
    // persists with the state, so the restarted process resumes the
    // episode: the next instance-scoped refusal is the consecutive
    // pair that holds its claim and arms the stall.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.submitInbound = async () => {
      plane.submitAttempts += 1;
      throw Object.assign(new Error('HTTP 404'), {
        status: 404,
        code: 'workspace_not_found',
      });
    };
    append(raw('one', 'first'));
    await adapter.tick();
    // The episode's one sacrifice is paid: dropped visibly, nothing
    // pending, nothing held.
    expect(state(adapter).pending).toEqual([]);
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(1);
    await adapter.disconnect();
    const restarted = make({}, { log: (line: string) => lines.push(line) });
    await restarted.connect();
    const held = append(raw('two', 'held after the restart'));
    await restarted.tick();
    // The restored streak makes this refusal the second of the episode:
    // the claim is held and the stall arms instead of paying the
    // sacrifice again.
    expect(state(restarted).pending).toEqual([
      { uid: held, eventId: `1:${held}`, held: true },
    ]);
    expect(
      lines.filter((line) => line.includes('the message is skipped')),
    ).toHaveLength(1);
    expect(lines.some((line) => line.includes('stopped admitting'))).toBe(true);
    expect(plane.events).toEqual([]);
  });

  it('re-drives an unrecognized 404 as a lost answer, never dropping the mail (R3-1)', async () => {
    // A 404 whose code the contract never classified — an unmapped route
    // answering not_found while the adapter surface is down, a proxy's
    // synthesized envelope — is not a verdict on this message. Dropping
    // on the bare status would destroy the mail: the claim takes the
    // same bounded re-drive as a lost answer and converges once the
    // route answers again.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.submitErrors = [{ status: 404, code: 'not_found' }];
    append(raw('held', 'held by an unknown 404'));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    expect(plane.events).toEqual([]);
    const log = lines.join('\n');
    expect(log).toContain('did not answer');
    expect(log).not.toContain('the message is skipped');
    // The route answers again: the next poll's re-drive converges.
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.events.map((event) => event.text)).toEqual([
      'held by an unknown 404',
    ]);
  });

  it('stops admitting new mail once a refusal resets registration, re-searching it next poll (R3-2)', async () => {
    // The admit loop owns the same dead-tick invariant resubmitPending
    // stops on: after a refusal, every later admit this tick is a
    // guaranteed-refused submit carrying a full event body. The loop
    // returns instead — the un-admitted mail is searched again once the
    // next poll re-registers, so nothing is lost.
    const adapter = make();
    await adapter.connect();
    plane.submitErrors = [{ status: 409, code: 'channel_disconnected' }];
    const first = append(raw('one', 'first'));
    append(raw('two', 'second'));
    await adapter.tick();
    expect(plane.submitAttempts).toBe(1);
    expect(state(adapter).pending).toEqual([
      { uid: first, eventId: `1:${first}` },
    ]);
    await adapter.tick();
    expect(plane.events.map((event) => event.text)).toEqual([
      'first',
      'second',
    ]);
    expect(state(adapter).pending).toEqual([]);
  });

  it('truncates to the wire text bound even when the adapter setting is wider', async () => {
    const adapter = make({ maxTextLength: 40_000 });
    await adapter.connect();
    append(raw('wide', 'x'.repeat(33_000)));
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]!.text.length).toBeLessThanOrEqual(32_000);
  });

  it('rebuilds a pending event only while it still fits the current message bound', async () => {
    const adapter = make();
    await adapter.connect();
    plane.failSubmits = 1;
    append(raw('big', 'x'.repeat(9_000)));
    await adapter.tick();
    expect(state(adapter).pending).toHaveLength(1);
    await adapter.disconnect();
    // The operator shrank the bound before the restart: the in-flight
    // event can no longer meet the size gate its first drive passed.
    const restarted = make({ maxMessageBytes: 2_000 });
    await restarted.connect();
    await restarted.tick();
    expect(state(restarted).pending).toEqual([]);
    expect(plane.submitAttempts).toBe(1);
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

  it('skips a deterministically refused admission visibly, never re-driving it', async () => {
    const log = vi.fn();
    const adapter = make();
    (adapter as unknown as { log: (line: string) => void }).log = log;
    await adapter.connect();
    plane.refuseSubmitsWithStatus = 400;
    append(raw('poison', 'this body is refused'));
    await adapter.tick();
    expect(state(adapter).pending).toEqual([]);
    expect(plane.admitted.size).toBe(0);
    expect(plane.events).toHaveLength(0);
    expect(plane.submitAttempts).toBe(1);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'refused (400)',
    );
    // The message is gone from the in-flight set, so no later poll
    // re-drives it, and the rest of the mailbox still flows.
    plane.refuseSubmitsWithStatus = 0;
    append(raw('fine', 'ordinary mail'));
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]!.text).toBe('ordinary mail');
    expect(plane.submitAttempts).toBe(2);
  });

  it('clamps the upload bound to what the control plane can carry', async () => {
    const adapter = make();
    await adapter.connect();
    const base64 = (bytes: Buffer) =>
      bytes
        .toString('base64')
        .match(/.{1,76}/g)!
        .join('\r\n');
    const mime = (
      id: string,
      file: string,
      size: string,
      content: string,
    ): Buffer =>
      Buffer.from(
        [
          'From: Alice <alice@example.com>',
          'To: agent@example.com',
          `Message-ID: <${id}@example.com>`,
          'Subject: Files',
          'Content-Type: multipart/mixed; boundary="b1"',
          '',
          '--b1',
          'Content-Type: text/plain',
          '',
          'see attached',
          '--b1',
          `Content-Type: application/octet-stream; name="${file}"`,
          `Content-Disposition: attachment; filename="${file}"; size=${size}`,
          'Content-Transfer-Encoding: base64',
          '',
          content,
          '--b1--',
          '',
        ].join('\r\n'),
      );
    const oversized = base64(Buffer.alloc(1_500_001, 0x61));
    append(mime('big', 'big.pdf', String(1_500_001), oversized));
    await adapter.tick();
    expect(plane.events).toHaveLength(1);
    expect(plane.events[0]!.text).toBe('see attached');
    expect(plane.events[0]!.attachments).toEqual([]);
    // The exact wire bound still uploads: 1,500,000 decoded bytes are
    // 2,000,000 base64 characters, the most the control plane admits.
    const exact = base64(Buffer.alloc(1_500_000, 0x62));
    append(mime('exact', 'exact.pdf', String(1_500_000), exact));
    await adapter.tick();
    expect(plane.events).toHaveLength(2);
    expect(plane.events[1]!.attachments).toHaveLength(1);
    expect(plane.events[1]!.attachments[0]!.bytesBase64.length).toBe(2_000_000);
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

  it('caps the persisted outbound ledger at the shared limit (R1-3)', async () => {
    const adapter = make();
    await adapter.connect();
    // Receipt answers are lost so every sent segment stays in the ledger.
    plane.receipt = async () => {
      throw Object.assign(new Error('answer lost'), { status: 503 });
    };
    plane.outbox = Array.from({ length: MANAGED_OUTBOUND_LIMIT + 1 }, (_, i) =>
      delivery(`d-${i}`),
    );
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(MANAGED_OUTBOUND_LIMIT + 1);
    // The append slices to the cap, so the persisted ledger stays loadable.
    expect(state(adapter).outbound).toHaveLength(MANAGED_OUTBOUND_LIMIT);
    await adapter.disconnect();
  });

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
    // The send-level isolation keeps the entry (and its batch) moving: the
    // tick resolves, the persisted outcome stays behind.
    await adapter.tick();
    await adapter.disconnect();
    expect(state(adapter).outbound).toEqual([
      {
        deliveryId: 'd-crash',
        ordinal: 0,
        messageId: expect.stringMatching(/^<.+@example\.com>$/),
        receipt: { outcome: 'unknown' },
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

  it('re-drives a persisted receipt from the tick loop, without a restart', async () => {
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery('d-blip')];
    // The one HTTP call of the receipt dies after the provider accepted.
    const original = plane.receipt.bind(plane);
    plane.receipt = async () => {
      throw new Error('control plane blip');
    };
    await adapter.tick();
    expect(state(adapter).outbound).toHaveLength(1);
    // The next tick re-drives the persisted receipt; the ledger converges
    // without waiting for a restart.
    plane.receipt = original;
    await adapter.tick();
    expect(state(adapter).outbound).toEqual([]);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd-blip',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('drops a persisted receipt the control plane refuses for good, so later deliveries still send', async () => {
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery('d-closed')];
    // The route Session closed while its reply was in flight: every receipt
    // for that delivery is refused deterministically.
    const original = plane.receipt.bind(plane);
    plane.receipt = async (deliveryId: string, receipt: ManagedReceipt) => {
      if (deliveryId === 'd-closed') {
        throw Object.assign(new Error('HTTP 409'), {
          status: 409,
          code: 'workspace_unavailable',
        });
      }
      await original(deliveryId, receipt);
    };
    // The failed report is swallowed into the persisted outbound: the
    // entry stays with its receipt for the next tick's refusal verdict.
    await adapter.tick();
    expect(state(adapter).outbound).toHaveLength(1);
    // Another thread's reply must not wait behind the refused receipt.
    plane.outbox = [delivery('d-next')];
    await adapter.tick();
    expect(state(adapter).outbound).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d-next']);
  });

  it('keeps the rest of a claimed batch sending when one receipt answer dies', async () => {
    // The batch was already claimed server-side: an unreportable first
    // receipt must not strand the still-unsent rest of it (R8 P1).
    const adapter = make();
    await adapter.connect();
    plane.outbox = [
      delivery('d-batch-1'),
      delivery('d-batch-2'),
      delivery('d-batch-3'),
    ];
    const original = plane.receipt.bind(plane);
    plane.receipt = async (deliveryId: string, receipt: ManagedReceipt) => {
      if (deliveryId === 'd-batch-1') throw new Error('control plane blip');
      await original(deliveryId, receipt);
    };
    await adapter.tick();
    // The other two still send and report this tick; the first one stays
    // outbound with its accepted outcome persisted.
    expect(sent).toHaveBeenCalledTimes(3);
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual([
      'd-batch-2',
      'd-batch-3',
    ]);
    expect(state(adapter).outbound).toEqual([
      {
        deliveryId: 'd-batch-1',
        ordinal: 0,
        messageId: expect.any(String),
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    // The next tick re-drives exactly that receipt, never an SMTP resend.
    plane.receipt = original;
    await adapter.tick();
    expect(state(adapter).outbound).toEqual([]);
    expect(plane.receipts.map((entry) => entry.deliveryId).slice(2)).toEqual([
      'd-batch-1',
    ]);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('re-registers when the outbox claim reports disconnected, recovering the send (R3-3)', async () => {
    // claimDeliveries answers the same 409 channel_disconnected; without
    // the registration reset every tick re-throws from pullOutbox with the
    // claim lease still proving aliveness, stalling outbound until a
    // restart heals the instance by chance.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.outbox = [delivery()];
    let claimFaults = 1;
    const original = plane.claimDeliveries.bind(plane);
    plane.claimDeliveries = async (limit: number) => {
      if (claimFaults > 0) {
        claimFaults -= 1;
        throw Object.assign(new Error('HTTP 409'), {
          status: 409,
          code: 'channel_disconnected',
        });
      }
      return original(limit);
    };
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(0);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 1 },
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
    // The refusal log names the verdict, so a transient disconnect flap
    // is distinguishable from a permanent 404 in the server's own log.
    const refusal = lines.find((line) => line.includes('outbox claim'));
    expect(refusal).toContain('409');
    expect(refusal).toContain('channel_disconnected');
  });

  it('re-registers when the outbox claim reports the instance is gone (R3-3)', async () => {
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery()];
    let claimFaults = 1;
    const original = plane.claimDeliveries.bind(plane);
    plane.claimDeliveries = async (limit: number) => {
      if (claimFaults > 0) {
        claimFaults -= 1;
        // The fault precedes the delegation: the fake's claim consumes
        // the batch, so a later throw would leave nothing to recover.
        throw Object.assign(new Error('HTTP 404'), {
          status: 404,
          code: 'channel_not_found',
        });
      }
      return original(limit);
    };
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(0);
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 1 },
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('re-registers when a held receipt reports the instance is gone (R3-3)', async () => {
    // A send whose receipt answer died leaves its accepted outcome held in
    // state.outbound, and reportOrphanedOutbound re-drives it ahead of
    // every outbox pull. When the instance row is gone that re-drive meets
    // the same 404 channel_not_found as the claim route: without the
    // poll-level arm the tick dies before pullOutbox and nothing ever
    // re-registers — outbound wedges behind the held receipt.
    const lines: string[] = [];
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await adapter.connect();
    plane.outbox = [delivery('d-held')];
    const original = plane.receipt.bind(plane);
    plane.receipt = async () => {
      throw new Error('answer lost');
    };
    await adapter.tick();
    plane.receipt = original;
    expect(state(adapter).outbound).toHaveLength(1);
    plane.receiptErrors = [{ status: 404, code: 'channel_not_found' }];
    plane.outbox = [delivery('d-queued')];
    // The tick resolves: the held receipt keeps its entry and resets the
    // generation, and the pull behind it still sends.
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(2);
    await adapter.tick();
    expect(plane.registrations).toEqual([
      { accountGeneration: 1 },
      { accountGeneration: 1 },
    ]);
    expect(state(adapter).outbound).toEqual([]);
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual([
      'd-queued',
      'd-held',
    ]);
    expect(lines.some((line) => line.includes('not registered'))).toBe(true);
  });

  it('drops a held receipt whose delivery is gone, without arming a re-register (R3-1)', async () => {
    // delivery_not_found names the claim, not the instance: the re-driven
    // receipt meets the deterministic drop, and the poll-level
    // registration claim stays disarmed.
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery('d-held')];
    const original = plane.receipt.bind(plane);
    plane.receipt = async () => {
      throw new Error('answer lost');
    };
    await adapter.tick();
    plane.receipt = original;
    expect(state(adapter).outbound).toHaveLength(1);
    plane.receiptErrors = [{ status: 404, code: 'delivery_not_found' }];
    await adapter.tick();
    expect(state(adapter).outbound).toEqual([]);
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
  });

  it('rethrows a transport failure from the outbox claim (R3-3)', async () => {
    // A claim that did not answer is not a refusal: the tick fails and
    // the run loop reconnects, and no spurious re-register follows.
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery()];
    plane.claimDeliveries = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(adapter.tick()).rejects.toThrow('ECONNRESET');
    expect(plane.registrations).toEqual([{ accountGeneration: 1 }]);
  });

  it('completes the remote disconnect while the mailbox is still owned', async () => {
    // Releasing the lock first would let a replacement register and have
    // its fresh registration revoked by our unfenced disconnect (R8 P1).
    const adapter = make();
    await adapter.connect();
    const original = FakeControlPlane.prototype.disconnect;
    plane.disconnect = async () => {
      lifecycle.push('remote');
      return original.call(plane);
    };
    await adapter.disconnect();
    expect(lifecycle).toEqual(['remote', 'lock']);
  });

  it('completes the remote disconnect with ownership through the production run-loop teardown', async () => {
    // The production shape (pollLoop: true): the run loop's own teardown
    // must not free the mailbox before the remote close, either (R10).
    const adapter = make({}, {}, { pollLoop: true });
    await adapter.connect();
    const original = FakeControlPlane.prototype.disconnect;
    plane.disconnect = async () => {
      lifecycle.push('remote');
      return original.call(plane);
    };
    await adapter.disconnect();
    expect(lifecycle).toEqual(['remote', 'lock']);
  });

  it('admits a multibyte inbound truncated into the envelope byte line (F2)', async () => {
    const adapter = make();
    await adapter.connect();
    append(raw('cjk', '汉'.repeat(22_000)));
    await adapter.tick();
    const event = plane.events.at(-1)!;
    // The character line stays, and the text the envelope carries now fits
    // its own byte line with headroom — never a deterministic refuse.
    expect(event.text.startsWith('汉')).toBe(true);
    expect(Buffer.byteLength(event.text, 'utf8')).toBeLessThanOrEqual(
      64 * 1024 - 4096,
    );
    // The adapter stayed healthy past the truncated message.
    plane.outbox = [delivery()];
    await adapter.tick();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('logs a deterministically refused register as refused, not unanswered', async () => {
    // A 409 register threw "did not answer … re-drives" before the exit:
    // the wording claims the verdict is latency, which it is not (R6).
    const lines: string[] = [];
    plane.register = async () => {
      throw Object.assign(new Error('HTTP 409'), {
        status: 409,
        code: 'channel_ownership_conflict',
      });
    };
    const adapter = make({}, { log: (line: string) => lines.push(line) });
    await expect(adapter.connect()).rejects.toThrow('HTTP 409');
    expect(lines.some((line) => line.includes('was refused (409)'))).toBe(true);
    expect(lines.some((line) => line.includes('did not answer'))).toBe(false);
  });

  it('replays the persisted provider receipt on restart instead of settling unknown', async () => {
    const adapter = make();
    await adapter.connect();
    plane.outbox = [delivery('d-receipted')];
    // The provider accepted the segment and the control plane committed
    // the receipt — only the HTTP answer was lost.
    const original = plane.receipt.bind(plane);
    plane.receipt = async (deliveryId: string, receipt: ManagedReceipt) => {
      await original(deliveryId, receipt);
      throw new Error('answer lost');
    };
    await adapter.tick();
    await adapter.disconnect();
    const persisted = state(adapter).outbound;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      deliveryId: 'd-receipted',
      receipt: { outcome: 'accepted' },
    });
    plane.receipt = original;
    const restarted = make();
    await restarted.connect();
    // The committed outcome is replayed verbatim, so a delivery the
    // server already settled still converges — never a blanket unknown.
    expect(plane.receipts).toHaveLength(2);
    expect(plane.receipts[1]).toEqual({
      deliveryId: 'd-receipted',
      receipt: {
        outcome: 'accepted',
        ordinal: 0,
        providerMessageId: persisted[0].receipt.providerMessageId,
        acceptedAt: 1_750_000_000_000,
      },
    });
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

describe('managed email adapter registration-identity isolation', () => {
  function legacyState(pending: number, outbound: number) {
    return {
      version: 1,
      uidValidity: '1',
      generation: 1,
      lastUid: pending,
      pending: Array.from({ length: pending }, (_, i) => ({
        uid: i + 1,
        eventId: `1:${i + 1}`,
      })),
      outbound: Array.from({ length: outbound }, (_, i) => ({
        deliveryId: `d-${i}`,
        ordinal: i,
        messageId: `<m-${i}@example.com>`,
      })),
      recent: [],
      routes: [],
    };
  }

  it('a destination change never replays one tenant pending into another', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const a = make();
    await a.connect();
    // A real message at uid 1 so a replayed claim would reach the wire: a
    // hand-written claim against an empty mailbox is dropped before submission
    // and cannot witness the cross-tenant replay at all.
    append(raw('tenant-a-mail'));
    const sA = state(a);
    sA.pending = [{ uid: 1, eventId: '1:1' }];
    sA.lastUid = 1;
    writeFileSync(a.stateFile, JSON.stringify(sA));
    await a.disconnect();
    const stateFileA = a.stateFile;

    plane.destinationKey = 'cp|tenant-b|chan|actor|ws|.';
    const b = make();
    await b.connect();
    expect(b.stateFile).not.toBe(stateFileA);
    expect(dirname(b.stateFile)).toBe(dirname(stateFileA));
    expect(state(b).pending).toEqual([]);
    await b.tick();
    expect(plane.submitAttempts).toBe(0);
    expect(plane.events).toHaveLength(0);
    await b.disconnect();
  });

  it('a workspace change within one tenant isolates the ledger', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const a = make();
    await a.connect();
    const sA = state(a);
    sA.pending = [{ uid: 1, eventId: '1:1' }];
    sA.lastUid = 1;
    writeFileSync(a.stateFile, JSON.stringify(sA));
    await a.disconnect();

    plane.destinationKey = 'cp|tenant-a|chan|actor|ws-2|.';
    const b = make();
    await b.connect();
    expect(b.stateFile).not.toBe(a.stateFile);
    expect(state(b).pending).toEqual([]);
    await b.disconnect();
  });

  it('logs the stranded legacy ledger on upgrade rather than dropping it silently', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify(legacyState(2, 3)),
    );
    // Mail up to UID 5 arrived while down, so the legacy cursor (2) sits below
    // the tip and the offline window is genuine.
    for (let i = 0; i < 5; i++) append(raw(`strand-${i}`));
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain(join(dir, 'managed-state.json'));
    expect(stranded[0]).toContain('2 pending');
    expect(stranded[0]).toContain('3 outbound');
    expect(stranded[0]).toContain('does not re-fetch them');
    expect(stranded[0]).toContain(
      'outbound segments with an unknown delivery status were dropped',
    );
    // The legacy cursor (lastUid 2) is named as a skipped offline window even
    // though this legacy also carries pending/outbound (R1-1).
    expect(stranded[0]).toContain(
      'Mail received after the legacy cursor (UID 2)',
    );
    // Not adopted: the legacy pending never enters this registration's state.
    expect(state(adapter).pending).toEqual([]);
    // Archive contract: renamed (not deleted), claims preserved, path logged,
    // and a second start does not re-announce it.
    expect(existsSync(join(dir, 'managed-state.json'))).toBe(false);
    const archived = readdirSync(dir).filter((f) =>
      f.startsWith('managed-state.json.stranded-'),
    );
    expect(archived).toHaveLength(1);
    const archivedState = JSON.parse(
      readFileSync(join(dir, archived[0]), 'utf8'),
    );
    expect(archivedState.pending).toHaveLength(2);
    expect(archivedState.outbound).toHaveLength(3);
    expect(lines.some((l) => l.includes(join(dir, archived[0])))).toBe(true);
    await adapter.disconnect();
    lines.length = 0;
    const second = make({}, { log: (l: string) => lines.push(l) });
    await second.connect();
    expect(
      lines.filter((l) => l.includes('is stranded and not replayed')),
    ).toHaveLength(0);
    await second.disconnect();
  });

  it('a genuinely cursor-less quiescent legacy (0/0) reports no loss', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    // No lastUid: a genuinely cursor-less legacy skips no offline window.
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), lastUid: undefined }),
    );
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('0 pending');
    expect(stranded[0]).toContain('0 outbound');
    expect(stranded[0]).not.toContain('does not re-fetch them');
    expect(stranded[0]).not.toContain('unknown delivery status');
    expect(stranded[0]).not.toContain('Mail received after the legacy cursor');
    await adapter.disconnect();
  });

  it('names the skipped offline window for a quiescent cursor-bearing legacy', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    // UIDs 1..5 arrived while the adapter was stopped (tip 5); the legacy
    // cursor sits at 2, so 3..5 are below the fresh tip and never re-fetched.
    for (let i = 0; i < 5; i++) append(raw(`offline-${i}`));
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), lastUid: 2 }),
    );
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('0 pending');
    expect(stranded[0]).toContain('0 outbound');
    expect(stranded[0]).toContain(
      'Mail received after the legacy cursor (UID 2)',
    );
    expect(stranded[0]).toContain('will not be admitted');
    // The skipped mail is never admitted: the fresh ledger starts at the tip.
    await adapter.tick();
    expect(plane.events).toHaveLength(0);
    await adapter.disconnect();
  });

  it('an unreadable legacy ledger reports unknown counts and a possible loss', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-state.json'), '{not json');
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('unknown pending');
    expect(stranded[0]).toContain('unknown outbound');
    expect(stranded[0]).toContain('could not be read');
    expect(stranded[0]).not.toContain('0 pending');
    await adapter.disconnect();
  });

  it('a legacy ledger staged after a rollback is still reported (keyed ledger exists)', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const first = make({}, { log: (l: string) => lines.push(l) });
    await first.connect();
    await first.disconnect();
    expect(
      lines.filter((l) => l.includes('is stranded and not replayed')),
    ).toHaveLength(0);
    // A rollback stages a fresh legacy after the keyed ledger already exists.
    writeFileSync(
      join(dirname(first.stateFile), 'managed-state.json'),
      JSON.stringify(legacyState(1, 0)),
    );
    lines.length = 0;
    const second = make({}, { log: (l: string) => lines.push(l) });
    await second.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('1 pending');
    // Roll-forward: the keyed ledger keeps its own cursor and re-fetches, so
    // the fresh-window loss clauses must NOT fire (R1-2).
    expect(stranded[0]).not.toContain('does not re-fetch them');
    expect(stranded[0]).not.toContain('Mail received after the legacy cursor');
    await second.disconnect();
  });

  it('reports settled-receipt outbound as zero, not an unknown-status loss', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({
        ...legacyState(0, 0),
        outbound: [
          {
            deliveryId: 'd-a',
            ordinal: 0,
            messageId: '<a@x>',
            receipt: {
              outcome: 'accepted',
              ordinal: 0,
              providerMessageId: '<a@x>',
              acceptedAt: 1,
            },
          },
          {
            deliveryId: 'd-r',
            ordinal: 1,
            messageId: '<r@x>',
            receipt: { outcome: 'rejected' },
          },
        ],
      }),
    );
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('0 outbound');
    expect(stranded[0]).not.toContain('unknown delivery status');
    await adapter.disconnect();
  });

  it('a fresh generation-1 ledger is refused when the server holds a higher generation', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 2;
    const adapter = make();
    await expect(adapter.connect()).rejects.toThrow();
    expect(plane.registrations).toContainEqual({ accountGeneration: 1 });
  });

  it('seeds the legacy generation so a re-keyed mailbox still registers after upgrade', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 2;
    const adapter = make();
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), generation: 2 }),
    );
    await adapter.connect();
    expect(plane.registrations).toContainEqual({ accountGeneration: 2 });
    expect(state(adapter).generation).toBe(2);
    // Seeding the counter adopts no pending/cursor state.
    expect(state(adapter).pending).toEqual([]);
    await adapter.disconnect();
  });

  it('does not seed a non-integer legacy generation that would brick the fresh ledger', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const first = make();
    const dir = dirname(first.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), generation: 2.5 }),
    );
    await first.connect();
    // A float generation is not a safe integer: seeding it would persist a
    // state the validator rejects on the next load, bricking the ledger.
    expect(state(first).generation).toBe(1);
    await first.disconnect();
    const second = make();
    await second.connect();
    expect(state(second).generation).toBe(1);
    await second.disconnect();
  });

  it('rejects when the lock is lost during connection', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    let release!: () => void;
    plane.registerGate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    plane.registerEntered = entered;
    const adapter = make();
    const connecting = adapter.connect();
    await enteredP;
    lockCompromised!();
    release();
    await expect(connecting).rejects.toThrow(/stopped during connection/);
  });

  it('a failed first start leaves the legacy unarchived for a rollback', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make();
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify(legacyState(1, 0)),
    );
    plane.failRegisters = 1;
    await expect(adapter.connect()).rejects.toThrow();
    expect(existsSync(join(dir, 'managed-state.json'))).toBe(true);
    expect(
      readdirSync(dir).filter((f) =>
        f.startsWith('managed-state.json.stranded-'),
      ),
    ).toHaveLength(0);
  });

  it('a second registration seeds the archived generation high-water', async () => {
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 2;
    plane.destinationKey = 'cp|tenant-a|chan|actor-a|ws|.';
    const a = make();
    const dir = dirname(a.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), generation: 2 }),
    );
    await a.connect();
    expect(plane.registrations).toContainEqual({ accountGeneration: 2 });
    // A archived the literal legacy on its successful start.
    expect(existsSync(join(dir, 'managed-state.json'))).toBe(false);
    await a.disconnect();
    // B is a different actor/workspace of the same tenant/channel: it shares
    // the control plane's generation row but keys a different ledger, and the
    // literal legacy is gone — the seed must come from the archives/siblings.
    plane.destinationKey = 'cp|tenant-a|chan|actor-b|ws|.';
    const b = make();
    await b.connect();
    expect(b.stateFile).not.toBe(a.stateFile);
    expect(plane.registrations.at(-1)).toEqual({ accountGeneration: 2 });
    expect(state(b).generation).toBe(2);
    await b.disconnect();
  });

  it('a second registration seeds from an archive that outranks every ledger', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor-a|ws|.';
    const a = make();
    await a.connect();
    const dir = dirname(a.stateFile);
    await a.disconnect();
    // The rollback case: an archive carries a generation above A's keyed ledger
    // (the pre-upgrade build advanced it, then the file was archived), so the
    // archive arm — not any live ledger — must decide the seed.
    writeFileSync(
      join(dir, 'managed-state.json.stranded-fixture'),
      JSON.stringify({ ...legacyState(0, 0), generation: 4 }),
    );
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 4;
    plane.destinationKey = 'cp|tenant-a|chan|actor-b|ws|.';
    const b = make();
    await b.connect();
    expect(plane.registrations.at(-1)).toEqual({ accountGeneration: 4 });
    expect(state(b).generation).toBe(4);
    await b.disconnect();
  });

  it('repeats the loss clauses on the retry after a failed first start', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const first = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(first.stateFile);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) append(raw(`retry-${i}`));
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(1, 0), lastUid: 2 }),
    );
    plane.failRegisters = 1;
    await expect(first.connect()).rejects.toThrow();
    const s1 = lines.filter((l) => l.includes('is stranded and not replayed'));
    expect(s1[0]).toContain('does not re-fetch them');
    expect(s1[0]).toContain('Mail received after the legacy cursor (UID 2)');
    await first.disconnect();
    // The failed start left a keyed ledger pinned to the tip; the retry loads
    // it, but the legacy window is still permanently below that cursor.
    lines.length = 0;
    const second = make({}, { log: (l: string) => lines.push(l) });
    await second.connect();
    const s2 = lines.filter((l) => l.includes('is stranded and not replayed'));
    expect(s2).toHaveLength(1);
    expect(s2[0]).toContain('does not re-fetch them');
    expect(s2[0]).toContain('Mail received after the legacy cursor (UID 2)');
    await second.disconnect();
  });

  it('logs and keeps the legacy when the archive rename fails', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify(legacyState(1, 0)),
    );
    const store = (
      adapter as unknown as {
        store: { archiveStrandedLegacy(): string | undefined };
      }
    ).store;
    const spy = vi
      .spyOn(store, 'archiveStrandedLegacy')
      .mockReturnValue(undefined);
    try {
      await adapter.connect();
      expect(
        lines.some((l) => l.includes('could not archive the legacy ledger')),
      ).toBe(true);
      expect(existsSync(join(dir, 'managed-state.json'))).toBe(true);
      expect(
        readdirSync(dir).filter((f) =>
          f.startsWith('managed-state.json.stranded-'),
        ),
      ).toHaveLength(0);
      await adapter.disconnect();
      // The kept legacy is reported again on the next start.
      lines.length = 0;
      const second = make({}, { log: (l: string) => lines.push(l) });
      await second.connect();
      expect(
        lines.filter((l) => l.includes('is stranded and not replayed')),
      ).toHaveLength(1);
      await second.disconnect();
    } finally {
      spy.mockRestore();
    }
  });

  it('the epoch branch clamps a multi-generation lag to the durable high-water', async () => {
    plane.destinationKey = 'cp|tenant-a|chan|actor-a|ws|.';
    const a = make();
    await a.connect();
    const dir = dirname(a.stateFile);
    // A sibling registration advanced the shared row to 3 while A was down.
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), generation: 3 }),
    );
    await a.disconnect();
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 3;
    box.epoch = 3n;
    box.messages.clear();
    box.next = 1;
    // A loads its generation-1 ledger; the epoch branch must jump to the
    // high-water (3), not register generation 2 and meet a 409 before the seed.
    const a2 = make();
    await a2.connect();
    expect(plane.registrations.at(-1)).toEqual({ accountGeneration: 3 });
    expect(state(a2).generation).toBe(3);
    await a2.disconnect();
  });

  it('heals a lagging loaded ledger and drops its dead staged claims visibly', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor-a|ws|.';
    const a = make({}, { log: (l: string) => lines.push(l) });
    await a.connect();
    const dir = dirname(a.stateFile);
    const sA = state(a);
    sA.pending = [{ uid: 1, eventId: '1:1' }];
    sA.lastUid = 1;
    writeFileSync(a.stateFile, JSON.stringify(sA));
    // A sibling of the same mailbox advanced the shared row to 2.
    writeFileSync(
      join(dir, 'managed-state-aaaaaaaaaaaaaaaa.json'),
      JSON.stringify({ ...legacyState(0, 0), generation: 2 }),
    );
    await a.disconnect();
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 2;
    lines.length = 0;
    // A2 loads the generation-1 ledger with a staged claim, epoch unchanged.
    // The claim's generation can never be registered (the row is ahead), so it
    // is dead: heal to 2 and drop it visibly rather than wedge on every start.
    const a2 = make({}, { log: (l: string) => lines.push(l) });
    await a2.connect();
    expect(state(a2).generation).toBe(2);
    expect(state(a2).pending).toEqual([]);
    expect(plane.registrations.at(-1)).toEqual({ accountGeneration: 2 });
    expect(lines.some((l) => l.includes('admit nothing further'))).toBe(true);
    await a2.disconnect();
  });

  it('does not claim a skipped offline window when the retry cursor equals the legacy cursor', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const first = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(first.stateFile);
    mkdirSync(dir, { recursive: true });
    // Quiescent upgrade: the legacy cursor sits at the tip (0); the first start
    // pins the fresh ledger to that same tip, then fails at registration.
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), lastUid: 0 }),
    );
    plane.failRegisters = 1;
    await expect(first.connect()).rejects.toThrow();
    await first.disconnect();
    // Mail arrives after the failed start; the retry cursor still equals the
    // legacy cursor, so the next poll (cursor + 1) admits it — no skipped window.
    append(raw('after-failed-start'));
    lines.length = 0;
    const second = make({}, { log: (l: string) => lines.push(l) });
    await second.connect();
    const s2 = lines.filter((l) => l.includes('is stranded and not replayed'));
    expect(s2).toHaveLength(1);
    expect(s2[0]).not.toContain('Mail received after the legacy cursor');
    await second.tick();
    expect(plane.events.length).toBeGreaterThan(0);
    await second.disconnect();
  });

  it('an unreadable legacy carries a restore instruction when the row refuses the fresh generation', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    plane.enforceGenerationFence = true;
    plane.highestGeneration = 2;
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-state.json'), '{not json');
    await expect(adapter.connect()).rejects.toThrow();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain('restore or repair it before restarting');
    expect(stranded[0]).toContain('only local copy');
  });

  it('keeps an unreadable legacy in place for repair instead of archiving it', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'managed-state.json'), '{not json');
    await adapter.connect();
    // The repair target stays at the printed path; archiving it would
    // invalidate the restore instruction and make the warning permanent.
    expect(existsSync(join(dir, 'managed-state.json'))).toBe(true);
    expect(
      readdirSync(dir).filter((f) =>
        f.startsWith('managed-state.json.stranded-'),
      ),
    ).toHaveLength(0);
    expect(
      lines.some((l) => l.includes('restore or repair it before restarting')),
    ).toBe(true);
    await adapter.disconnect();
  });

  it('names an unreadable generation source on a runtime mailbox reopen', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    const corrupt = join(dir, 'managed-state-aaaaaaaaaaaaaaaa.json');
    writeFileSync(corrupt, '{not json');
    await adapter.connect();
    // Exactly one line per start: openMailbox names it, the heal does not re-log.
    expect(
      lines.filter((l) => l.includes('could not read the generation source')),
    ).toHaveLength(1);
    lines.length = 0;
    // Force a runtime reopen: tick() re-enters openMailbox without connect().
    (adapter as unknown as { imap: { usable: boolean } }).imap.usable = false;
    await adapter.tick();
    expect(
      lines.filter(
        (l) =>
          l.includes('could not read the generation source') &&
          l.includes(corrupt),
      ),
    ).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not report a skipped offline window for a lossless quiescent upgrade', async () => {
    const lines: string[] = [];
    plane.destinationKey = 'cp|tenant-a|chan|actor|ws|.';
    const adapter = make({}, { log: (l: string) => lines.push(l) });
    const dir = dirname(adapter.stateFile);
    mkdirSync(dir, { recursive: true });
    // Quiescent at the pre-upgrade cursor: legacy lastUid 0, empty mailbox (tip
    // 0). Nothing arrived while down, so the upgrade skipped no offline window.
    writeFileSync(
      join(dir, 'managed-state.json'),
      JSON.stringify({ ...legacyState(0, 0), lastUid: 0 }),
    );
    await adapter.connect();
    const stranded = lines.filter((l) =>
      l.includes('is stranded and not replayed'),
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).not.toContain('Mail received after the legacy cursor');
    await adapter.disconnect();
  });
});
