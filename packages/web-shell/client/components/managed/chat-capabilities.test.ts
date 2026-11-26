import { describe, expect, it } from 'vitest';
import type { ManagedAgentSessionSummary } from './managed-agent-provider.js';
import {
  MANAGED_CHAT_CAPABILITY_MAP,
  isManagedCapabilityOn,
  managedCapabilitiesFromSummary,
  type ManagedCapabilityKey,
} from './chat-capabilities.js';
import type { ChatRegion } from '../../chat-core/capabilities.js';

// Every non-empty decision, pinned literally: any assignment moving to []
// or to another region, and any empty key gaining a region, flips this red.
const NON_EMPTY_DECISIONS = {
  canRename: ['sessionOps'],
  sessionClose: ['sessionOps'],
  sessionArchive: ['sessionOps'],
  sessionUnarchive: ['sessionOps'],
  sessionDelete: ['sessionOps'],
  childAgents: ['tasks'],
  tasks: ['tasks'],
  diagnostics: ['diagnostics'],
  artifacts: ['artifacts'],
  modelChange: ['modelSelection'],
  contextCompression: ['contextUsage'],
  approvalModeChange: ['approvalSelection'],
  terminal: ['terminal'],
};

describe('managed chat capability map', () => {
  it('covers exactly the managed capability keys (Required<> fixture)', () => {
    const fixture: Required<ManagedAgentSessionSummary['capabilities']> = {
      canSend: true,
      canCancel: true,
      canRename: true,
      sessionClose: true,
      sessionArchive: true,
      sessionUnarchive: true,
      sessionDelete: true,
      actions: true,
      childAgents: true,
      tasks: true,
      diagnostics: true,
      artifacts: true,
      workspaceTurns: true,
      modelChange: true,
      contextCompression: true,
      approvalModeChange: true,
      inputAttachments: true,
      btw: true,
      recap: true,
      terminal: true,
      clientFiles: true,
    };
    const keys: ManagedCapabilityKey[] = Object.keys(
      fixture,
    ) as ManagedCapabilityKey[];
    expect(Object.keys(MANAGED_CHAT_CAPABILITY_MAP).sort()).toEqual(
      keys.sort(),
    );
  });

  it('pins every non-empty region assignment', () => {
    const nonEmpty = Object.fromEntries(
      Object.entries(MANAGED_CHAT_CAPABILITY_MAP).filter(
        ([, regions]) => regions.length > 0,
      ),
    );
    expect(nonEmpty).toEqual(NON_EMPTY_DECISIONS);
  });

  it('keeps core turn facts out of the optional regions', () => {
    expect(MANAGED_CHAT_CAPABILITY_MAP.canSend).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.canCancel).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.actions).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.workspaceTurns).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.clientFiles).toEqual([]);
  });
});

describe('tri-state managed terminal capability', () => {
  it('only an explicit true enables the region', () => {
    expect(isManagedCapabilityOn(true)).toBe(true);
    expect(isManagedCapabilityOn(false)).toBe(false);
    expect(isManagedCapabilityOn(null)).toBe(false);
    expect(isManagedCapabilityOn(undefined)).toBe(false);
  });

  it('derives ChatCapabilities from ManagedAgentSessionSummary capabilities', () => {
    const empty = managedCapabilitiesFromSummary(undefined);
    expect(Object.values(empty).every((enabled) => enabled === false)).toBe(
      true,
    );
    expect(managedCapabilitiesFromSummary({ terminal: null }).terminal).toBe(
      false,
    );
    for (const [key, expected] of Object.entries(NON_EMPTY_DECISIONS)) {
      const caps = managedCapabilitiesFromSummary({
        [key as ManagedCapabilityKey]: true,
      });
      const active = (Object.keys(caps) as ChatRegion[]).filter(
        (region) => caps[region],
      );
      expect(active).toEqual(expected);
    }
  });
});
