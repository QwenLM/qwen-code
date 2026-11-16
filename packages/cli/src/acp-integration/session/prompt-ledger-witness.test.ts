/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appendPromptLedgerRecord } from '@qwen-code/acp-bridge/promptLedger';
import {
  createPromptLedgerWitness,
  RECOVERY_LEDGER_TAIL_BYTES,
  type PromptLedgerWitnessConfig,
} from './prompt-ledger-witness.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'prompt-ledger-witness-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function ledgerPath(sessionId: string): string {
  return path.join(tmpRoot, `${sessionId}.ledger.jsonl`);
}

function makeConfig(
  sessionId: string,
  overrides: {
    getSessionService?: () => {
      getPromptLedgerPath(sessionId: string): string;
    };
    getPromptLedgerPath?: (id: string) => string;
  } = {},
): {
  config: PromptLedgerWitnessConfig;
  getPromptLedgerPath: ReturnType<typeof vi.fn>;
} {
  const getPromptLedgerPath = vi.fn(
    overrides.getPromptLedgerPath ?? ((id: string) => ledgerPath(id)),
  );
  const config: PromptLedgerWitnessConfig = {
    getSessionService:
      overrides.getSessionService ?? (() => ({ getPromptLedgerPath })),
  };
  return { config, getPromptLedgerPath };
}

describe('createPromptLedgerWitness (recovery classification production wiring)', () => {
  it('resolves the ledger path through the session service for the session id and returns the tail', () => {
    const { config, getPromptLedgerPath } = makeConfig('session-a');
    appendPromptLedgerRecord(ledgerPath('session-a'), {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    appendPromptLedgerRecord(ledgerPath('session-a'), {
      v: 1,
      promptId: 'p1',
      terminal: 'completed',
      stopReason: 'end_turn',
      at: 2,
    });

    const witness = createPromptLedgerWitness(config, 'session-a');
    const records = witness();

    expect(getPromptLedgerPath).toHaveBeenCalledWith('session-a');
    expect(records).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        stopReason: 'end_turn',
        at: 2,
      },
    ]);
  });

  it('binds the session id: two witnesses read their own ledgers', () => {
    const { config } = makeConfig('session-x');
    appendPromptLedgerRecord(ledgerPath('session-x'), {
      v: 1,
      promptId: 'px',
      state: 'in_flight',
      at: 1,
    });
    appendPromptLedgerRecord(ledgerPath('session-y'), {
      v: 1,
      promptId: 'py',
      terminal: 'completed',
      stopReason: 'end_turn',
      at: 2,
    });

    expect(createPromptLedgerWitness(config, 'session-x')()).toEqual([
      { v: 1, promptId: 'px', state: 'in_flight', at: 1 },
    ]);
    expect(createPromptLedgerWitness(config, 'session-y')()).toEqual([
      {
        v: 1,
        promptId: 'py',
        terminal: 'completed',
        stopReason: 'end_turn',
        at: 2,
      },
    ]);
  });

  it('reads a missing ledger as an empty tail (no prompt ever admitted), not as a failure', () => {
    const { config } = makeConfig('session-missing');
    expect(createPromptLedgerWitness(config, 'session-missing')()).toEqual([]);
  });

  it('maps a failed path resolution to "no evidence" (undefined), never a throw', () => {
    const throwingConfig: PromptLedgerWitnessConfig = {
      getSessionService: () => {
        throw new Error('session service unwired');
      },
    };
    expect(
      createPromptLedgerWitness(throwingConfig, 'session-a')(),
    ).toBeUndefined();

    const badPathConfig: PromptLedgerWitnessConfig = {
      getSessionService: () => ({
        getPromptLedgerPath: () => {
          throw new Error('no storage layout');
        },
      }),
    };
    expect(
      createPromptLedgerWitness(badPathConfig, 'session-a')(),
    ).toBeUndefined();
  });

  it('reads only the bounded tail window on large ledgers', () => {
    const { config } = makeConfig('session-large');
    // One record is ~100 bytes; write enough to exceed the window.
    const count = Math.ceil((RECOVERY_LEDGER_TAIL_BYTES * 2) / 100);
    for (let i = 0; i < count; i++) {
      appendPromptLedgerRecord(ledgerPath('session-large'), {
        v: 1,
        promptId: `p-${i}`,
        terminal: 'completed',
        stopReason: 'end_turn',
        at: i + 1,
      });
    }

    const records = createPromptLedgerWitness(config, 'session-large')();
    expect(records).toBeDefined();
    // The newest record survives the window read; the tail is bounded.
    expect(records?.at(-1)).toEqual({
      v: 1,
      promptId: `p-${count - 1}`,
      terminal: 'completed',
      stopReason: 'end_turn',
      at: count,
    });
    expect(records!.length).toBeLessThan(count);
  });

  it('drops a torn tail line and keeps the records before it', () => {
    const { config } = makeConfig('session-torn');
    appendPromptLedgerRecord(ledgerPath('session-torn'), {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    writeFileSync(ledgerPath('session-torn'), 'garbage', {
      flag: 'a',
      encoding: 'utf8',
    });

    expect(createPromptLedgerWitness(config, 'session-torn')()).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
    ]);
  });
});
