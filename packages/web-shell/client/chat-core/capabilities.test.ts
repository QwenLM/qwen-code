import { describe, expect, it } from 'vitest';
import { SERVE_CAPABILITY_REGISTRY } from '@qwen-code/sdk/daemon';
import type { ManagedAgentSessionSummary } from '../components/managed/managed-agent-provider.js';
import {
  DAEMON_CHAT_CAPABILITY_MAP,
  MANAGED_CHAT_CAPABILITY_MAP,
  isManagedCapabilityOn,
  regionsToCapabilities,
  type ManagedCapabilityKey,
} from './capabilities.js';

describe('daemon capability map', () => {
  it('covers exactly the canonical registry tags', () => {
    expect(Object.keys(DAEMON_CHAT_CAPABILITY_MAP).sort()).toEqual(
      Object.keys(SERVE_CAPABILITY_REGISTRY).sort(),
    );
  });

  it('maps chat-relevant tags to their regions', () => {
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_set_model).toEqual([
      'modelSelection',
    ]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_context_usage).toEqual([
      'contextUsage',
    ]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_stats).toEqual(['usageStats']);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_approval_mode_control).toEqual([
      'approvalSelection',
    ]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.web_terminal).toEqual(['terminal']);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_tasks).toEqual(['tasks']);
  });

  it('keeps transport and daemon-only tags out of the shared regions', () => {
    expect(DAEMON_CHAT_CAPABILITY_MAP.health).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.require_auth).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.realtime_voice).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.workspace_local_terminal).toEqual([]);
  });
});

describe('managed capability map', () => {
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

  it('maps chat-relevant capabilities to their regions', () => {
    expect(MANAGED_CHAT_CAPABILITY_MAP.modelChange).toEqual(['modelSelection']);
    expect(MANAGED_CHAT_CAPABILITY_MAP.contextCompression).toEqual([
      'contextUsage',
    ]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.approvalModeChange).toEqual([
      'approvalSelection',
    ]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.terminal).toEqual(['terminal']);
    expect(MANAGED_CHAT_CAPABILITY_MAP.diagnostics).toEqual(['diagnostics']);
    expect(MANAGED_CHAT_CAPABILITY_MAP.canRename).toEqual(['sessionOps']);
  });

  it('keeps core turn facts out of the optional regions', () => {
    expect(MANAGED_CHAT_CAPABILITY_MAP.canSend).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.canCancel).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.actions).toEqual([]);
    expect(MANAGED_CHAT_CAPABILITY_MAP.workspaceTurns).toEqual([]);
  });
});

describe('tri-state managed terminal capability', () => {
  it('only an explicit true enables the region', () => {
    expect(isManagedCapabilityOn(true)).toBe(true);
    expect(isManagedCapabilityOn(false)).toBe(false);
    expect(isManagedCapabilityOn(null)).toBe(false);
    expect(isManagedCapabilityOn(undefined)).toBe(false);
  });
});

describe('regionsToCapabilities', () => {
  it('defaults every region to hidden', () => {
    const capabilities = regionsToCapabilities([]);
    expect(Object.values(capabilities).every((value) => value === false)).toBe(
      true,
    );
  });

  it('enables exactly the given regions', () => {
    const capabilities = regionsToCapabilities(['terminal', 'tasks']);
    expect(capabilities.terminal).toBe(true);
    expect(capabilities.tasks).toBe(true);
    expect(capabilities.modelSelection).toBe(false);
    expect(capabilities.usageStats).toBe(false);
  });
});
