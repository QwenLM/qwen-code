/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// FG7 (issue #13802): the parametric driver of the channel fault gates. One
// run executes one phase of one case; phases compose across runs through the
// adapter's real persisted state, so every restart is a genuine cold load.
// Embedded: the lose-once reverse proxy in front of the control plane's
// internal listener, the real ManagedEmailAdapter with scripted IMAP and
// scriptable SMTP deps, and a recording control-plane client wrapping the
// production HttpManagedChannelControlPlane (the probe/resend probes fetch
// the surface directly). Orchestrated by HostedChannelFaultGatesIT /
// HostedChannelProcessCrashIT, which read `resultFile` and the FG7_* markers.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
// The integration-tests root declares no workspace dependencies, so the
// adapter comes from the sibling package's build output directly — the same
// artifact `qwen channel managed-email` runs.
import {
  createManagedEmailDeps,
  ManagedEmailAdapter,
  type ManagedChannelControlPlane,
  type ManagedChannelPolicy,
  type ManagedClaimedDelivery,
  type ManagedInboundEvent,
  type ManagedReceipt,
} from '../../packages/channels/email/dist/index.js';
// The production adapter client, so the gate's wire shape can never drift
// from the shape production uses.
import { HttpManagedChannelControlPlane } from '../../packages/cli/src/commands/channel/managed-channel-client.js';
import { relayUpstream } from './hosted-relay-headers.js';

interface DriverConfig {
  phase:
    | 'admit'
    | 'admit-attempt'
    | 'full-turn'
    | 'pull'
    | 'pull-parked'
    | 'pull-terminate'
    | 'resume-cold'
    | 'probe'
    | 'resend';
  faultCase: string;
  tenantId: string;
  channelId: string;
  actorId: string;
  workspaceId: string;
  cwdRelative: string;
  /** The control plane's internal listener base URL (the proxy target). */
  internalUrl: string;
  stateDir: string;
  mailboxAddress: string;
  /** The scripted inbound's UID; distinct UIDs are distinct platform events. */
  mailUid?: number;
  /** The scripted inbound sender; empty mailbox when omitted. */
  sender?: string;
  subject?: string;
  bodyText?: string;
  /** Drop the first armed answer of this verb. */
  dropVerb?: DropVerb;
  /** Fake SMTP behaviour. */
  smtpMode?: SmtpMode;
  /** The file whose creation releases a parked send. */
  smtpReleaseFile?: string;
  /**
   * After the send is recorded, hold the receipt behind this file: the
   * SIGSTOP case freezes the process inside the hold, settles by lease,
   * then lets the honest receipt cross.
   */
  holdAfterSendFile?: string;
  expectDelivery?: boolean;
  /** The settled send count of this phase (multi-delivery pulls). */
  expectedSends?: number;
  /**
   * Zero-send loops that must outlive the armed fault, then a few extra
   * ticks: the phase ends only after the armed drop has fired.
   */
  holdAfterDrop?: boolean;
  maxTicks?: number;
  /** Exit the run as soon as one receipt post hard-fails (restart cases). */
  exitAfterFirstReceiptError?: boolean;
  /** resend phase: the original delivery to resend. */
  resendDeliveryId?: string;
  /** probe phase: the claimed delivery the wrong ordinal arrives for. */
  probeDeliveryId?: string;
  resultFile: string;
}

type Verb = 'register' | 'inbound' | 'claim' | 'receipt' | 'resend';
type DropVerb = 'inbound' | 'claim' | 'receipt';
type SmtpMode = 'ok' | 'park' | 'accept-timeout';

interface RelayRecord {
  verb: Verb;
  attempt: number;
  dropped: boolean;
  status: number;
}

interface Results {
  faultCase: string;
  relays: RelayRecord[];
  sends: Array<{ messageId: string; to: string; text: string }>;
  receipts: Array<{ deliveryId: string; outcome: string }>;
  receiptErrors: number;
  admissionInputIds: string[];
  resent?: {
    deliveryId: string;
    resentFrom: string;
    possibleDuplicate: boolean;
  };
  claimResponses: Array<{
    deliveryId: string;
    segments: Array<{ ordinal: number; segmentId: string }>;
  }>;
  probeStatus?: number;
  pendingAfterAttempt?: number;
}

/**
 * The production client of the trusted adapter surface plus the gate's
 * evidence: admissions, claim answers and receipt outcomes recorded beside
 * every production call, so the wire stays exactly the wire production uses.
 */
class RecordingControlPlane implements ManagedChannelControlPlane {
  private readonly delegate: HttpManagedChannelControlPlane;

  constructor(
    baseUrl: string,
    tenantId: string,
    actorId: string,
    channelId: string,
    workspaceId: string,
    cwdRelative: string,
    private readonly results: Results,
  ) {
    this.delegate = new HttpManagedChannelControlPlane({
      baseUrl,
      tenantId,
      channelId,
      actorId,
      workspaceId,
      cwdRelative,
    });
  }

  register(request: {
    platform: 'email';
    accountId: string;
    accountGeneration: number;
    policy: ManagedChannelPolicy;
  }): Promise<void> {
    return this.delegate.register(request);
  }

  disconnect(): Promise<void> {
    return this.delegate.disconnect();
  }

  async submitInbound(event: ManagedInboundEvent) {
    const admitted = await this.delegate.submitInbound(event);
    this.results.admissionInputIds.push(admitted.inputId);
    return admitted;
  }

  async claimDeliveries(limit: number): Promise<ManagedClaimedDelivery[]> {
    const deliveries = await this.delegate.claimDeliveries(limit);
    for (const delivery of deliveries) {
      this.results.claimResponses.push({
        deliveryId: delivery.deliveryId,
        segments: delivery.segments.map((segment) => ({
          ordinal: segment.ordinal,
          segmentId: segment.segmentId,
        })),
      });
      console.log(`FG7_CLAIMED ${delivery.deliveryId}`);
    }
    return deliveries;
  }

  async receipt(deliveryId: string, receipt: ManagedReceipt): Promise<void> {
    try {
      await this.delegate.receipt(deliveryId, receipt);
    } catch (cause) {
      this.results.receiptErrors += 1;
      throw cause;
    }
    this.results.receipts.push({ deliveryId, outcome: receipt.outcome });
  }
}

class FakeImap extends EventEmitter {
  usable = false;
  constructor(
    private readonly source: Buffer | null,
    private readonly uid: number,
  ) {
    super();
  }
  async connect() {
    this.usable = true;
  }
  async mailboxOpen() {
    // A fresh mailbox is empty at open: the scripted message arrives after
    // the initial cursor (`status` reports it), or the adapter's bootstrap
    // skips it as history it never saw.
    return { uidValidity: '7', uidNext: 1 };
  }
  async status() {
    return {
      uidNext: this.source === null ? 1 : this.uid + 1,
      uidValidity: '7',
      messages: this.source === null ? 0 : 1,
    };
  }
  async search(query: { uid: string }) {
    const [start, end] = query.uid.split(':').map(Number);
    return this.source !== null && this.uid >= start && this.uid <= end
      ? [this.uid]
      : [];
  }
  async fetchAll(uids: number[]) {
    return uids.map((uid) => ({ uid, size: this.source!.length }));
  }
  async fetchOne(
    uid: number,
    query: { headers?: boolean; source?: { maxLength: number } },
  ) {
    if (this.source === null || uid !== this.uid) return false;
    if (query.headers)
      return {
        uid,
        headers: Buffer.from(
          this.source.toString('utf8').split('\r\n\r\n')[0] + '\r\n\r\n',
        ),
      };
    return { uid, source: this.source.subarray(0, query.source?.maxLength) };
  }
  close() {
    this.usable = false;
  }
}

/* TS-private at compile time only: the phases below drive the adapter one
 * half-step at a time (inbound poll without the outbox pull), and peek at
 * the pending ledger. Choreography selectors, never gate evidence. */
interface AdapterInternals {
  state?: { pending: Array<unknown> };
  poll(): Promise<void>;
  pullOutbox(): Promise<void>;
}

const config = JSON.parse(
  await readFile(process.argv[2]!, 'utf8'),
) as DriverConfig;
const maxTicks = config.maxTicks ?? 40;
await mkdir(config.stateDir, { recursive: true });

const results: Results = {
  faultCase: config.faultCase,
  relays: [],
  sends: [],
  receipts: [],
  receiptErrors: 0,
  admissionInputIds: [],
  claimResponses: [],
};
const attempts = new Map<Verb, number>();
let droppedForVerb = 0;

function verbOf(method: string | undefined, pathname: string): Verb | null {
  if (method === 'PUT') return 'register';
  if (pathname.endsWith('/inbound')) return 'inbound';
  if (pathname.endsWith('/deliveries:claim')) return 'claim';
  if (pathname.includes(':receipt')) return 'receipt';
  if (pathname.includes(':resend')) return 'resend';
  return null;
}

const proxy = createServer((req, res) => {
  void (async () => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const target = new URL(req.url!, config.internalUrl);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          'x-qwen-tenant-id': config.tenantId,
        },
        body: body.length ? body : undefined,
        // A pure safety net, far past any attach cost; never a gate knob.
        signal: AbortSignal.timeout(120_000),
      });
      const answer = Buffer.from(await upstream.arrayBuffer());
      const verb = verbOf(req.method, target.pathname);
      if (verb !== null) {
        const attempt = (attempts.get(verb) ?? 0) + 1;
        attempts.set(verb, attempt);
        // A claim arm must catch the answer that carries the delivery, not
        // the empty scans ahead of the plan; the other verbs are singular.
        let armed = upstream.ok;
        if (verb === 'claim') {
          try {
            const body = JSON.parse(answer.toString('utf8')) as {
              deliveries?: unknown[];
            };
            armed = (body.deliveries?.length ?? 0) > 0;
          } catch {
            armed = false;
          }
        }
        const drop = config.dropVerb === verb && droppedForVerb === 0 && armed;
        if (drop) droppedForVerb = 1;
        results.relays.push({
          verb,
          attempt,
          dropped: drop,
          status: upstream.status,
        });
        if (drop) {
          // The committed answer is consumed upstream; the adapter sees a
          // transport failure and must recover by identity, not by effect.
          res.destroy();
          console.log(`FG7_DROPPED ${verb}`);
          return;
        }
      }
      relayUpstream(res, upstream, answer);
    } catch {
      // A controller restart or a client abort makes one relay die; the
      // adapter sees a transport failure, which is its own retry signal.
      res.destroy();
    }
  })();
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyAddress = proxy.address();
assert(proxyAddress && typeof proxyAddress !== 'string');
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
const channelRoot = `${proxyUrl}/internal/managed-channels/v1/channels/${encodeURIComponent(config.channelId)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rawMail(): Buffer {
  // One platform event is one identity across every re-drive and restart:
  // the Message-ID is deterministic per (channel, uid), or a resubmission
  // would mint a second route by content and double the sends the case
  // counts.
  return Buffer.from(
    `From: ${config.sender}\r\nTo: ${config.mailboxAddress}\r\nSubject: ${config.subject}\r\nMessage-ID: <${config.channelId}-uid${config.mailUid ?? 1}@fg7.fixture>\r\nDate: Wed, 07 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${config.bodyText}\r\n`,
    'utf8',
  );
}

function makeSmtp() {
  return {
    close() {},
    async sendMail(message: Record<string, unknown>) {
      const mode = config.smtpMode ?? 'ok';
      if (mode === 'park') {
        console.log('FG7_CLAIM_PARKED');
        for (;;) {
          const released = config.smtpReleaseFile
            ? await readFile(config.smtpReleaseFile)
                .then(() => true)
                .catch(() => false)
            : false;
          if (released) break;
          await sleep(100);
        }
      }
      results.sends.push({
        messageId: String(message['messageId']),
        to: JSON.stringify(message['to']),
        text: String(message['text']),
      });
      console.log(`FG7_SEND_DONE ${String(message['messageId'])}`);
      if (mode === 'accept-timeout') {
        throw Object.assign(new Error('FG7 provider answer timed out'), {
          code: 'ETIMEDOUT',
        });
      }
      if (config.phase === 'pull-terminate') {
        // The bytes reached the provider; the claim ends here. Java kills
        // this process at the marker, so the evidence lands before it.
        await writeFile(config.resultFile, JSON.stringify(results, null, 2));
        console.log('FG7_AWAIT_KILL');
        await new Promise(() => {});
      }
      if (config.holdAfterSendFile !== undefined) {
        // The hold point is deterministic: the receipt exists neither in
        // the state file nor on the wire while the process waits here.
        await writeFile(config.resultFile, JSON.stringify(results, null, 2));
        console.log('FG7_HELD');
        for (;;) {
          const released = await readFile(config.holdAfterSendFile)
            .then(() => true)
            .catch(() => false);
          if (released) break;
          await sleep(100);
        }
      }
      return { messageId: message['messageId'] };
    },
  };
}

function buildAdapter(mail: Buffer | null): ManagedEmailAdapter {
  const realDeps = createManagedEmailDeps();
  return new ManagedEmailAdapter({
    name: config.channelId,
    cwd: config.stateDir,
    config: {
      type: 'email',
      address: config.mailboxAddress,
      imapHost: 'imap.fixture',
      imapUser: 'u',
      imapPassword: 'p',
      imapSecure: false,
      smtpHost: 'smtp.fixture',
      smtpUser: 'u',
      smtpPassword: 'p',
      smtpSecure: false,
      folder: 'INBOX',
      pollInterval: 100,
      privatePolicy: 'allowlist',
      ...(config.sender !== undefined ? { allowedUsers: [config.sender] } : {}),
    },
    controlPlane: new RecordingControlPlane(
      proxyUrl,
      config.tenantId,
      config.actorId,
      config.channelId,
      config.workspaceId,
      config.cwdRelative,
      results,
    ),
    deps: {
      ...realDeps,
      createImap: async () => new FakeImap(mail, config.mailUid ?? 1) as never,
      createSmtp: async () => makeSmtp() as never,
      lock: async () => async () => {},
      log: (line) => console.log(`FG7_ADAPTER ${line}`),
    },
    pollLoop: false,
  });
}

/** One fault-tolerant tick: a refused hop is the adapter's to re-drive. */
async function tickOrNote(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (cause) {
    console.log(`FG7_TICK_REFUSED ${String(cause)}`);
  }
}

/** One poll snapshot: why an admit skipped, when it happens. */
interface AdapterStatePeek {
  pending: Array<{ uid: number; eventId: string }>;
  lastUid: number;
}

/** Inbound-only ticks: the outbox stays untouched for paced cancellation. */
async function pollUntilAdmitted(adapter: ManagedEmailAdapter): Promise<void> {
  const internals = adapter as unknown as AdapterInternals;
  for (let tick = 1; tick <= maxTicks; tick++) {
    await tickOrNote(() => internals.poll());
    const peek = internals.state as unknown as AdapterStatePeek | undefined;
    if ((peek?.pending.length ?? 0) === 0) {
      if (results.admissionInputIds.length > 0) return;
      if (tick >= 5) {
        throw new Error(
          `the scripted inbound was dropped before submission (lastUid=${peek?.lastUid ?? -1})`,
        );
      }
    }
    await sleep(200);
  }
  throw new Error('the scripted inbound was never admitted');
}

/** Full ticks until every expected send is sent and reported once. */
async function tickUntilSettled(adapter: ManagedEmailAdapter): Promise<void> {
  const expectDelivery = config.expectDelivery ?? true;
  const quota = config.expectedSends ?? (expectDelivery ? 1 : 0);
  for (let tick = 1; tick <= maxTicks; tick++) {
    await tickOrNote(() => adapter.tick());
    if (config.holdAfterDrop === true && droppedForVerb === 1) {
      // The armed fault fired; let a few more rounds prove nothing moves.
      for (let extra = 0; extra < 4; extra++) {
        await tickOrNote(() => adapter.tick());
        await sleep(150);
      }
      return;
    }
    if (results.sends.length > 0) {
      if (!expectDelivery) break;
      if (config.exitAfterFirstReceiptError && results.receiptErrors > 0) {
        // The process ends behind a persisted outbound entry whose first
        // report hard-failed; a cold run owns the re-drive.
        return;
      }
      if (results.sends.length >= quota && results.receipts.length >= quota) {
        for (let extra = 0; extra < 3; extra++) {
          await tickOrNote(() => adapter.tick());
          await sleep(150);
        }
        assert.equal(
          results.sends.length,
          quota,
          `exactly ${quota} physical send(s)`,
        );
        assert.equal(
          results.receipts.length,
          quota,
          `exactly ${quota} receipt(s) reported`,
        );
        return;
      }
    } else if (
      !expectDelivery &&
      config.holdAfterDrop === undefined &&
      tick >= 5
    ) {
      // Five claim rounds and the outbox stayed silent: nothing was owed.
      assert.equal(results.sends.length, 0, 'no send may ever happen');
      return;
    }
    await sleep(200);
  }
  if (expectDelivery) {
    assert.equal(
      results.sends.length,
      quota,
      `exactly ${quota} physical send(s)`,
    );
    assert.equal(
      results.receipts.length,
      quota,
      `exactly ${quota} receipt(s) reported`,
    );
  } else {
    assert.equal(results.sends.length, 0, 'no send may ever happen');
  }
}

const scriptedMail = config.sender !== undefined ? rawMail() : null;

try {
  switch (config.phase) {
    case 'admit': {
      const adapter = buildAdapter(scriptedMail);
      await adapter.connect();
      console.log('FG7_READY');
      await pollUntilAdmitted(adapter);
      break;
    }
    case 'admit-attempt': {
      const adapter = buildAdapter(scriptedMail);
      await adapter.connect();
      console.log('FG7_READY');
      const internals = adapter as unknown as AdapterInternals;
      await internals.poll().catch((cause) => {
        console.log(`FG7_ATTEMPT_REFUSED ${String(cause)}`);
      });
      results.pendingAfterAttempt = internals.state?.pending.length ?? -1;
      break;
    }
    case 'full-turn': {
      const adapter = buildAdapter(scriptedMail);
      await adapter.connect();
      console.log('FG7_READY');
      await tickUntilSettled(adapter);
      await adapter.disconnect().catch(() => undefined);
      break;
    }
    case 'pull':
    case 'pull-parked':
    case 'pull-terminate': {
      const adapter = buildAdapter(null);
      await adapter.connect();
      console.log('FG7_READY');
      if (config.phase === 'pull-terminate') {
        // The ticks never return: the send parks the process until Java kills it.
        await adapter.tick();
      } else {
        await tickUntilSettled(adapter);
        await adapter.disconnect().catch(() => undefined);
      }
      break;
    }
    case 'resume-cold': {
      const adapter = buildAdapter(null);
      await adapter.connect(); // reportOrphanedOutbound re-drives here
      console.log('FG7_READY');
      for (let tick = 0; tick < 3; tick++) {
        await tickOrNote(() => adapter.tick());
        await sleep(150);
      }
      await adapter.disconnect().catch(() => undefined);
      break;
    }
    case 'probe': {
      // A receipt for an ordinal outside the plan: the adapter that claimed
      // the delivery is parked behind its send while this arrives.
      assert(config.probeDeliveryId, 'probeDeliveryId is required');
      const refused = await fetch(
        `${channelRoot}/deliveries/${encodeURIComponent(config.probeDeliveryId)}:receipt`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-tenant-id': config.tenantId,
          },
          body: JSON.stringify({
            outcome: 'accepted',
            ordinal: 1,
            providerMessageId: `<${randomUUID()}@fg7.fixture>`,
            acceptedAt: Date.now(),
          }),
        },
      );
      results.probeStatus = refused.status;
      assert.equal(refused.status, 409, await refused.text());
      console.log('FG7_PROBE_REFUSED');
      break;
    }
    case 'resend': {
      assert(config.resendDeliveryId, 'resendDeliveryId is required');
      const response = await fetch(
        `${channelRoot}/deliveries/${encodeURIComponent(config.resendDeliveryId)}:resend`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-tenant-id': config.tenantId,
          },
          body: '{}',
        },
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text) as Record<string, unknown>;
      results.resent = {
        deliveryId: String(body['deliveryId']),
        resentFrom: String(body['resentFrom']),
        possibleDuplicate: body['possibleDuplicate'] === true,
      };
      console.log(`FG7_RESEND ${results.resent.deliveryId}`);
      const adapter = buildAdapter(null);
      await adapter.connect();
      console.log('FG7_READY');
      for (let tick = 1; tick <= maxTicks; tick++) {
        await tickOrNote(() => adapter.tick());
        if (
          results.receipts.some(
            (receipt) => receipt.deliveryId === results.resent!.deliveryId,
          )
        ) {
          // Settle ticks: a duplicate re-driven on a later tick must be
          // observed before the exactly-once window closes.
          for (let extra = 0; extra < 3; extra++) {
            await tickOrNote(() => adapter.tick());
            await sleep(150);
          }
          break;
        }
        await sleep(200);
      }
      assert.equal(
        results.receipts.filter(
          (receipt) => receipt.deliveryId === results.resent!.deliveryId,
        ).length,
        1,
        'the resend chain settled exactly once',
      );
      await adapter.disconnect().catch(() => undefined);
      break;
    }
    default:
      throw new Error(`unknown phase ${config.phase as string}`);
  }
} finally {
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}

await writeFile(config.resultFile, JSON.stringify(results, null, 2));
console.log(`FG7_${config.phase.replaceAll('-', '_').toUpperCase()}_OK`);
