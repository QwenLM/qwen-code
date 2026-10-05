/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findReplacementRuntime, joinCommands } from './add-runtime-dialog';

describe('joinCommands', () => {
  const join = {
    token: 'secret-token',
    workspaceId: 'workspace-id',
    expiresAt: Date.now() + 60_000,
  };

  it('quotes the coordinator address and keeps the token out of qwen argv', () => {
    const command = joinCommands("https://host/base'$(id)'", join).qwen;

    expect(command).toContain(
      "QWEN_AGENT_HOST_ENROLLMENT_TOKEN='secret-token'",
    );
    expect(command).toContain("'\"'\"'");
    expect(command).toContain('--join ');
    expect(command.match(/secret-token/g)).toHaveLength(1);
  });

  it('rejects coordinator addresses with URL parameters', () => {
    expect(() => joinCommands('https://host/base?next=other', join)).toThrow(
      'Invalid coordinator address.',
    );
  });
});

describe('findReplacementRuntime', () => {
  const old = {
    id: 'old-host',
    kind: 'external' as const,
    label: 'Old host',
    provider: 'qwen',
    status: 'offline' as const,
  };

  it('waits for the selected host to disappear before reporting a new host', () => {
    const next = {
      ...old,
      id: 'new-host',
      label: 'New host',
      status: 'online' as const,
    };
    const known = new Set(['old-host']);

    expect(findReplacementRuntime([old, next], known, old.id)).toBeUndefined();
    expect(findReplacementRuntime([next], known, old.id)).toBe(next);
    const recoveredKnown = new Set([old.id, next.id]);
    expect(
      findReplacementRuntime([next], recoveredKnown, old.id),
    ).toBeUndefined();
    expect(
      findReplacementRuntime([next], recoveredKnown, old.id, next.id),
    ).toBe(next);
    expect(
      findReplacementRuntime([old, next], recoveredKnown, old.id, next.id),
    ).toBeUndefined();
  });
});
