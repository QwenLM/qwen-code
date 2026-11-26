import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import first from './fixtures/session-state-10f1bfe8.json' with { type: 'json' };
import second from './fixtures/session-state-1609c001.json' with { type: 'json' };
import { SessionStateStore } from './session-state-store.js';
import { SessionStateDecryptionError } from './session-state-crypto.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { countRequestTokens } from '../utils/request-token-count.js';
import {
  bindSessionCreditsPersistence,
  clearSessionCredits,
  flushSessionUsage,
  getSessionCreditsSnapshot,
  loadLatestSessionUsage,
  recordCompletedRequest,
  recordSessionUsageInMemory,
} from './session-state-usage.js';

describe('unreadable session usage', () => {
  let fixture = first;
  let home: string;
  function store(persist = true) {
    return new SessionStateStore({
      projectRoot: '/fixture/project',
      sessionId: fixture.sessionId,
      configHomeDir: home,
      persist,
    });
  }
  async function seed(input: typeof first) {
    fixture = input;
    const file = store().getSessionStatePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(fixture, null, 2) + '\n');
    clearSessionCredits(fixture.sessionId);
  }
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'session-recovery-'));
    await seed(first);
  });
  afterEach(async () => {
    clearSessionCredits(fixture.sessionId);
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([first, second])('backs up $sessionId and permits writes and fresh usage', async (input) => {
    await seed(input);
    const s = store();
    await expect(loadLatestSessionUsage(s)).resolves.toBeNull();
    await s.setSegment('metadata', { preserved: true }, { encrypted: false });
    const files = await fs.readdir(path.dirname(s.getSessionStatePath()));
    const backup = files.find((f) => f.endsWith('.bak'));
    expect(backup).toBeDefined();
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(path.dirname(s.getSessionStatePath()), backup!),
          'utf8',
        ),
      ),
    ).toEqual(fixture);
    const usage = {
      ...cloneUsage(),
      input_tokens: 12000,
      output_tokens: 100,
      request_id: 'new-request',
    };
    recordSessionUsageInMemory(s, usage);
    await flushSessionUsage(s);
    await expect(loadLatestSessionUsage(store())).resolves.toMatchObject(usage);
    await expect(store().getSegment('metadata')).resolves.toEqual({
      preserved: true,
    });
    await expect(store().getSegment('s0')).resolves.toMatchObject({
      historyIncomplete: true,
    });
  });

  it.each([first, second])('keeps unknown usage and persists new credits once for $sessionId', async (input) => {
    await seed(input);
    const s = store();
    const dispose = await bindSessionCreditsPersistence(fixture.sessionId, s);
    try {
      expect(getSessionCreditsSnapshot(fixture.sessionId)).toMatchObject({
        observed: false,
        historyIncomplete: true,
      });
      const request = {
        sessionId: fixture.sessionId,
        requestId: 'charged-request',
        model: 'test-model',
        usage: { billable: true, credits: 2 },
      };
      expect(recordCompletedRequest(request)).toBe(true);
      expect(recordCompletedRequest(request)).toBe(false);
      expect(getSessionCreditsSnapshot(fixture.sessionId).observed).toBe(true);
      await flushSessionUsage(s);
      expect(await store().getSegment('s0')).not.toHaveProperty('latest');
      const latestUsage = await loadLatestSessionUsage(store());
      expect(latestUsage).toBeNull();
      const count = countRequestTokens({
        model: 'test-model',
        messages: [],
        latestUsage,
        normalizedMessages: [
          { role: 'user', content: 'Long context. '.repeat(5000) },
        ],
      });
      expect(count.source).toBe('estimate');
      expect(count.tokens).toBeGreaterThan(10000);
    } finally {
      await dispose();
    }
    clearSessionCredits(fixture.sessionId);
    const disposeAgain = await bindSessionCreditsPersistence(
      fixture.sessionId,
      store(),
    );
    try {
      expect(getSessionCreditsSnapshot(fixture.sessionId)).toMatchObject({
        observed: true,
        totalCredits: 2,
        historyIncomplete: true,
        byModel: { 'test-model': { credits: 2 } },
      });
    } finally {
      await disposeAgain();
    }
  });

  it('does not mutate files for nonpersistent recovery', async () => {
    const s = store(false);
    const before = await fs.readFile(s.getSessionStatePath(), 'utf8');
    await expect(loadLatestSessionUsage(s)).resolves.toBeNull();
    await s.setSegment('metadata', { ok: true });
    expect(await fs.readFile(s.getSessionStatePath(), 'utf8')).toBe(before);
    expect(await fs.readdir(path.dirname(s.getSessionStatePath()))).toEqual([
      'state.json',
    ]);
  });

  it('does not recover an unrelated segment authentication failure', async () => {
    const file = store().getSessionStatePath();
    await fs.writeFile(
      file,
      JSON.stringify({ ...fixture, items: { private: fixture.items.s0 } }),
    );
    await expect(store().load()).rejects.toBeInstanceOf(
      SessionStateDecryptionError,
    );
  });

  it('fails closed when a backup cannot be written', async () => {
    const s = store();
    const before = await fs.readFile(s.getSessionStatePath(), 'utf8');
    const digest = createHash('sha256').update(before).digest('hex');
    await fs.mkdir(s.getSessionStatePath() + '.s0-' + digest + '.bak');
    await expect(s.setSegment('metadata', { ok: true })).rejects.toThrow();
    expect(await fs.readFile(s.getSessionStatePath(), 'utf8')).toBe(before);
  });

  it('preserves healthy segments and backup across concurrent store updates', async () => {
    const s = store();
    const initial = { ...fixture, data: { metadata: { original: true } } };
    await fs.writeFile(
      s.getSessionStatePath(),
      JSON.stringify(initial, null, 2) + '\n',
    );
    await Promise.all([s.setSegment('a', 1), store().setSegment('b', 2)]);
    expect((await store().load())?.segments).toMatchObject({
      metadata: { original: true },
      a: 1,
      b: 2,
      s0: { historyIncomplete: true },
    });
    const backups = (
      await fs.readdir(path.dirname(s.getSessionStatePath()))
    ).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(path.dirname(s.getSessionStatePath()), backups[0]!),
          'utf8',
        ),
      ),
    ).toEqual(initial);
  });

  it('does not hide malformed encrypted records', async () => {
    await fs.writeFile(
      store().getSessionStatePath(),
      JSON.stringify({
        ...fixture,
        items: { s0: { ...fixture.items.s0, t: null } },
      }),
    );
    await expect(store().load()).rejects.toThrow('unsupported format');
  });
});
