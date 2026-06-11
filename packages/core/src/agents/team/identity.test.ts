/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  teammateIdentityStore,
  getTeammateContext,
  isInProcessTeammate,
  getAgentName,
  getTeamName,
  isTeammate,
  isTeamLead,
  getTeammateColor,
  runWithTeammateIdentity,
} from './identity.js';
import type { TeammateIdentity } from './types.js';

const WORKER_IDENTITY: TeammateIdentity = {
  agentId: 'worker@my-team',
  agentName: 'worker',
  teamName: 'my-team',
  color: '#FF6B6B',
  isTeamLead: false,
  parentSessionId: 'session-123',
};

const LEADER_IDENTITY: TeammateIdentity = {
  agentId: 'leader@my-team',
  agentName: 'leader',
  teamName: 'my-team',
  isTeamLead: true,
};

describe('identity', () => {
  // ─── Outside any context ────────────────────────────────────

  describe('outside teammate context', () => {
    it('getTeammateContext returns undefined', () => {
      expect(getTeammateContext()).toBeUndefined();
    });

    it('isInProcessTeammate returns false', () => {
      expect(isInProcessTeammate()).toBe(false);
    });

    it('getAgentName returns undefined', () => {
      expect(getAgentName()).toBeUndefined();
    });

    it('getTeamName returns undefined', () => {
      expect(getTeamName()).toBeUndefined();
    });

    it('isTeammate returns false', () => {
      expect(isTeammate()).toBe(false);
    });

    it('isTeamLead returns false', () => {
      expect(isTeamLead()).toBe(false);
    });

    it('getTeammateColor returns undefined', () => {
      expect(getTeammateColor()).toBeUndefined();
    });
  });

  // ─── runWithTeammateIdentity ────────────────────────────────

  describe('runWithTeammateIdentity', () => {
    it('provides identity inside callback', () => {
      runWithTeammateIdentity(WORKER_IDENTITY, () => {
        expect(getTeammateContext()).toEqual(WORKER_IDENTITY);
        expect(isInProcessTeammate()).toBe(true);
        expect(getAgentName()).toBe('worker');
        expect(getTeamName()).toBe('my-team');
        expect(isTeammate()).toBe(true);
        expect(isTeamLead()).toBe(false);
        expect(getTeammateColor()).toBe('#FF6B6B');
      });
    });

    it('isTeamLead returns true for leader', () => {
      runWithTeammateIdentity(LEADER_IDENTITY, () => {
        expect(isTeamLead()).toBe(true);
      });
    });

    it('returns the callback result', () => {
      const result = runWithTeammateIdentity(WORKER_IDENTITY, () => 42);
      expect(result).toBe(42);
    });

    it('identity is scoped — not visible outside', () => {
      runWithTeammateIdentity(WORKER_IDENTITY, () => {
        expect(getAgentName()).toBe('worker');
      });
      expect(getAgentName()).toBeUndefined();
    });

    it('works with async code', async () => {
      await runWithTeammateIdentity(WORKER_IDENTITY, async () => {
        await Promise.resolve();
        expect(getTeammateContext()).toEqual(WORKER_IDENTITY);
      });
    });

    it('nested contexts override outer', () => {
      runWithTeammateIdentity(WORKER_IDENTITY, () => {
        expect(getAgentName()).toBe('worker');

        runWithTeammateIdentity(LEADER_IDENTITY, () => {
          expect(getAgentName()).toBe('leader');
          expect(isTeamLead()).toBe(true);
        });

        // Outer context restored
        expect(getAgentName()).toBe('worker');
      });
    });
  });

  // ─── Raw store access ──────────────────────────────────────

  describe('teammateIdentityStore', () => {
    it('is an AsyncLocalStorage instance', () => {
      expect(teammateIdentityStore).toBeDefined();
      expect(teammateIdentityStore.getStore()).toBeUndefined();
    });

    it('run sets and clears store', () => {
      teammateIdentityStore.run(WORKER_IDENTITY, () => {
        expect(teammateIdentityStore.getStore()).toEqual(WORKER_IDENTITY);
      });
      expect(teammateIdentityStore.getStore()).toBeUndefined();
    });
  });
});
