/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SessionAttributionMap,
  UNATTRIBUTED_TOKEN_ID,
} from './sessionAttribution.js';

describe('SessionAttributionMap', () => {
  it('returns the unattributed sentinel for an unknown session', () => {
    const m = new SessionAttributionMap();
    expect(m.get('sess_x')).toEqual({
      attributionTokenId: UNATTRIBUTED_TOKEN_ID,
      subActor: null,
    });
  });

  it('records and returns a prompt-originated attribution', () => {
    const m = new SessionAttributionMap();
    m.set('sess_1', { attributionTokenId: 'tkn_a', subActor: 'telegram:42' });
    expect(m.get('sess_1')).toEqual({
      attributionTokenId: 'tkn_a',
      subActor: 'telegram:42',
    });
  });

  it('overwrites on a newer prompt (latest originator wins)', () => {
    const m = new SessionAttributionMap();
    m.set('sess_1', { attributionTokenId: 'tkn_a', subActor: null });
    m.set('sess_1', { attributionTokenId: 'tkn_b', subActor: null });
    expect(m.get('sess_1').attributionTokenId).toBe('tkn_b');
  });

  it('forgets a deleted session', () => {
    const m = new SessionAttributionMap();
    m.set('sess_1', { attributionTokenId: 'tkn_a', subActor: null });
    m.delete('sess_1');
    expect(m.get('sess_1').attributionTokenId).toBe(UNATTRIBUTED_TOKEN_ID);
  });
});
