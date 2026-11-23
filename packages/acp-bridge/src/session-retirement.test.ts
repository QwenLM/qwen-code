/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRetirementLedger } from './session-retirement.js';

describe('native retirement ledger', () => {
  let runtime: string;
  const identity = {
    sessionId: randomUUID(),
    operationId: randomUUID(),
    eventEpoch: randomUUID(),
  };

  beforeEach(() => {
    runtime = mkdtempSync(path.join(tmpdir(), 'qwen-retire-ledger-'));
  });

  afterEach(() => rmSync(runtime, { recursive: true, force: true }));

  it('fences a source before a receipt and keeps a verified receipt after reopening the ledger', () => {
    const ledger = new SessionRetirementLedger(runtime, '/source');
    expect(ledger.read(identity.sessionId)).toBeUndefined();
    ledger.begin(identity);
    expect(() => ledger.assertOpen(identity.sessionId)).toThrow('fenced');
    expect(() => ledger.assertOpen(identity.sessionId.toUpperCase())).toThrow(
      'fenced',
    );
    expect(() =>
      ledger.begin({ ...identity, operationId: randomUUID() }),
    ).toThrow();
    expect(() =>
      ledger.settle({ ...identity, eventEpoch: randomUUID() }, 'retired'),
    ).toThrow();
    expect(ledger.settle(identity, 'retired')).toEqual({
      ...identity,
      state: 'retired',
    });
    expect(
      new SessionRetirementLedger(runtime, '/source').read(identity.sessionId),
    ).toEqual({
      ...identity,
      state: 'retired',
    });
    expect(
      new SessionRetirementLedger(runtime, '/destination').read(
        identity.sessionId,
      ),
    ).toBeUndefined();
  });

  it('retains an unknown outcome and never reopens a retired identity', () => {
    const ledger = new SessionRetirementLedger(runtime, '/source');
    ledger.begin(identity);
    ledger.settle(identity, 'result_unknown');
    const reopened = new SessionRetirementLedger(runtime, '/source');
    expect(reopened.read(identity.sessionId)).toEqual({
      ...identity,
      state: 'result_unknown',
    });
    expect(() => reopened.releaseNotStarted(identity)).toThrow();
    expect(() => reopened.assertOpen(identity.sessionId)).toThrow('fenced');
  });

  it('permits same-operation retry after definitive refusal before close', () => {
    const ledger = new SessionRetirementLedger(runtime, '/source');
    ledger.begin(identity);
    ledger.releaseNotStarted(identity);
    expect(ledger.read(identity.sessionId)).toBeUndefined();
    expect(() => ledger.assertOpen(identity.sessionId)).not.toThrow();
    expect(() => ledger.begin(identity)).not.toThrow();
  });
});
