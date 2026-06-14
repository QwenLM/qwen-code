/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRateTable,
  computeCostCents,
  lookupRate,
  rateTablePath,
  RateTableHolder,
  createRateTableReloader,
} from './rateTable.js';

const YAML = `
currencyLabel: USD
defaultModelServiceId: qwen
models:
  - modelServiceId: qwen
    modelId: qwen3-coder-plus
    inputPerMTok: 200
    outputPerMTok: 800
    cachedReadPerMTok: 20
`;

describe('parseRateTable', () => {
  it('parses currency, default service, and model entries', () => {
    const t = parseRateTable(YAML);
    expect(t.currencyLabel).toBe('USD');
    expect(t.defaultModelServiceId).toBe('qwen');
    expect(t.models).toHaveLength(1);
    expect(t.models[0]).toMatchObject({
      modelServiceId: 'qwen',
      modelId: 'qwen3-coder-plus',
      inputPerMTok: 200,
      outputPerMTok: 800,
      cachedReadPerMTok: 20,
    });
  });

  it('throws on a missing currencyLabel', () => {
    expect(() => parseRateTable('models: []')).toThrow(/currencyLabel/);
  });

  it('throws when models is not an array', () => {
    expect(() => parseRateTable('currencyLabel: USD\nmodels: nope')).toThrow(
      /"models" must be an array/,
    );
  });

  it('throws when an entry is missing a required numeric field', () => {
    const bad = `
currencyLabel: USD
models:
  - modelServiceId: qwen
    modelId: m
    inputPerMTok: 1
    outputPerMTok: 2
`; // cachedReadPerMTok missing
    expect(() => parseRateTable(bad)).toThrow(/cachedReadPerMTok/);
  });

  it('throws on malformed YAML', () => {
    expect(() => parseRateTable('currencyLabel: "unterminated')).toThrow();
  });
});

describe('computeCostCents', () => {
  const table = parseRateTable(YAML);

  it('prices the spec scenario: in=1000,out=500,cached=0 -> 0.6 cents', () => {
    expect(
      computeCostCents(table, 'qwen', 'qwen3-coder-plus', {
        in: 1000,
        out: 500,
        cached: 0,
      }),
    ).toBeCloseTo(0.6, 10);
  });

  it('includes cached-read cost', () => {
    // 1e6 cached * 20/Mtok = 20 cents
    expect(
      computeCostCents(table, 'qwen', 'qwen3-coder-plus', {
        in: 0,
        out: 0,
        cached: 1_000_000,
      }),
    ).toBeCloseTo(20, 10);
  });

  it('falls back to defaultModelServiceId when none is given', () => {
    expect(
      computeCostCents(table, undefined, 'qwen3-coder-plus', {
        in: 1000,
        out: 0,
        cached: 0,
      }),
    ).toBeCloseTo(0.2, 10);
  });

  it('returns null (not 0) on a lookup miss', () => {
    expect(
      computeCostCents(table, 'openai', 'gpt-5', { in: 1, out: 1, cached: 1 }),
    ).toBeNull();
    expect(lookupRate(table, 'openai', 'gpt-5')).toBeUndefined();
  });
});

describe('rateTablePath', () => {
  it('is model-rates.yaml under ~/.qwen/rc', () => {
    expect(rateTablePath('/home/x')).toBe('/home/x/.qwen/rc/model-rates.yaml');
  });
});

describe('createRateTableReloader', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-rates-'));
    path = join(dir, 'model-rates.yaml');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Drive the debounce timer synchronously.
  function fakeTimers() {
    let fn: (() => void) | undefined;
    return {
      schedule: (f: () => void) => {
        fn = f;
        return 1;
      },
      cancel: () => {
        fn = undefined;
      },
      flush: () => {
        const f = fn;
        fn = undefined;
        f?.();
      },
    };
  }

  it('swaps the holder to the freshly-loaded table on a valid edit', async () => {
    await writeFile(path, YAML, 'utf8');
    const holder = new RateTableHolder(parseRateTable(YAML));
    const t = fakeTimers();
    const reloaded: string[] = [];
    const reloader = createRateTableReloader(path, holder, {
      onParseFailed: () => {},
      onReloaded: (tbl) => reloaded.push(tbl.currencyLabel),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    await writeFile(path, 'currencyLabel: EUR\nmodels: []\n', 'utf8');
    reloader.trigger();
    t.flush();
    for (let i = 0; i < 50 && holder.current().currencyLabel !== 'EUR'; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(holder.current().currencyLabel).toBe('EUR');
    expect(reloaded).toEqual(['EUR']);
    reloader.stop();
  });

  it('retains the previous table and reports the error on parse failure', async () => {
    await writeFile(path, YAML, 'utf8');
    const holder = new RateTableHolder(parseRateTable(YAML));
    const errors: string[] = [];
    const t = fakeTimers();
    const reloader = createRateTableReloader(path, holder, {
      onParseFailed: (m) => errors.push(m),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    await writeFile(path, 'currencyLabel: "unterminated', 'utf8'); // malformed
    reloader.trigger();
    t.flush();
    for (let i = 0; i < 50 && errors.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(errors).toHaveLength(1);
    expect(holder.current().currencyLabel).toBe('USD'); // retained
    reloader.stop();
  });
});
