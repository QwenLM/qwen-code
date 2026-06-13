/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SubActorBanStore } from './subActorBans.js';

describe('SubActorBanStore', () => {
  it('bans, reports, lists, and lifts', () => {
    const s = new SubActorBanStore();
    expect(s.isBanned('telegram:evan')).toBe(false);
    s.ban('telegram:evan');
    expect(s.isBanned('telegram:evan')).toBe(true);
    expect(s.list()).toEqual(['telegram:evan']);
    expect(s.lift('telegram:evan')).toBe(true);
    expect(s.isBanned('telegram:evan')).toBe(false);
  });

  it('ban is idempotent; lift of an unknown sub-actor returns false', () => {
    const s = new SubActorBanStore();
    s.ban('discord:1');
    s.ban('discord:1');
    expect(s.list()).toEqual(['discord:1']);
    expect(s.lift('discord:2')).toBe(false);
  });
});
