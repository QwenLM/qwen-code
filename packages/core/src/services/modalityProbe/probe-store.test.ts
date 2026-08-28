/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildProbeKey,
  readProbeResult,
  withProbeResult,
  type ModalityProbeRecord,
  type ProbeResultStore,
} from './probe-store.js';

describe('probeStore', () => {
  it('builds stable composite keys', () => {
    expect(buildProbeKey('openai', 'm1', 'https://api.example.com/v1')).toEqual(
      'openai|m1|https://api.example.com/v1',
    );
    expect(buildProbeKey('openai', 'm1', undefined)).toEqual('openai|m1|');
  });

  it('reads a matching record and ignores non-matching keys', () => {
    const store: Record<string, ModalityProbeRecord> = {
      'openai|m1|https://a.example': {
        verdict: 'image',
        probedAt: '2026-08-27T00:00:00Z',
      },
    };
    expect(
      readProbeResult(store, 'openai', 'm1', 'https://a.example')?.verdict,
    ).toEqual('image');
    expect(
      readProbeResult(store, 'openai', 'm2', 'https://a.example'),
    ).toBeUndefined();
  });

  it('returns a new map on write (immutable read-modify-write)', () => {
    const store: Record<string, ModalityProbeRecord> = {};
    const next = withProbeResult(store, 'openai', 'm1', '', {
      verdict: 'text_only',
      probedAt: '2026-08-27T00:00:00Z',
    });
    expect(next['openai|m1|']).toEqual({
      verdict: 'text_only',
      probedAt: '2026-08-27T00:00:00Z',
    });
    expect(store).toEqual({});
  });

  it('lets the last write win for the same key (re-probe overwrites)', () => {
    const first = withProbeResult(undefined, 'openai', 'm1', '', {
      verdict: 'image',
      probedAt: '2026-08-27T00:00:00Z',
    });
    const second = withProbeResult(first, 'openai', 'm1', '', {
      verdict: 'text_only',
      probedAt: '2026-08-28T00:00:00Z',
    });
    expect(second['openai|m1|']?.verdict).toEqual('text_only');
    expect(Object.keys(second)).toHaveLength(1);
  });

  it('treats a hand-corrupted non-object store as empty on write', () => {
    // Spreading a raw string would materialize index keys ("0", "1", ...)
    // and persist them; the write must start from an empty map instead.
    const record: ModalityProbeRecord = {
      verdict: 'image',
      probedAt: '2026-08-28T00:00:00Z',
    };
    const next = withProbeResult(
      'corrupted' as unknown as ProbeResultStore,
      'openai',
      'm1',
      '',
      record,
    );
    expect(next).toEqual({ 'openai|m1|': record });
    expect(Object.keys(next)).toHaveLength(1);
  });
});
