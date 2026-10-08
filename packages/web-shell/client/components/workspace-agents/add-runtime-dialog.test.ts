/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  findReplacementRuntime,
  joinCommands,
  joinCoordinatorCommand,
  parseJoinLink,
} from './add-runtime-dialog';
import { runtimePrograms } from './agents-view-logic';

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

describe('parseJoinLink', () => {
  it('reads the coordinator and workspace from a join link', () => {
    expect(parseJoinLink(' https://host:4170/join/ws_1 ')).toEqual({
      serverUrl: 'https://host:4170',
      workspaceId: 'ws_1',
    });
    // A coordinator mounted under a path keeps it.
    expect(parseJoinLink('http://10.0.0.2:4170/qwen/join/abc-1/')).toEqual({
      serverUrl: 'http://10.0.0.2:4170/qwen',
      workspaceId: 'abc-1',
    });
  });

  it('refuses anything else, as `qwen serve --join` does', () => {
    for (const link of [
      '',
      'not a url',
      'ftp://host/join/ws',
      'https://user:pw@host/join/ws',
      'https://host/join/ws?x=1',
      'https://host/join/ws#frag',
      'https://host/join/',
      'https://host/join/ws/extra',
      'https://host/join/bad.id',
      'https://host/other/ws',
    ]) {
      expect(parseJoinLink(link)).toBeUndefined();
    }
  });
});

describe('joinCoordinatorCommand', () => {
  it('keeps the token in the environment and quotes the link', () => {
    const command = joinCoordinatorCommand(
      "https://host/join/ws'x",
      'secret',
      false,
    );
    expect(command).toBe(
      `QWEN_AGENT_HOST_ENROLLMENT_TOKEN='secret' qwen agents join 'https://host/join/ws'"'"'x'`,
    );
  });

  it('shows a placeholder without a token and the HTTP opt-in when asked', () => {
    const command = joinCoordinatorCommand('http://h/join/ws', '', true);
    expect(command).toContain("QWEN_AGENT_HOST_ENROLLMENT_TOKEN='<token>'");
    expect(command.endsWith(' --allow-http')).toBe(true);
  });
});

describe('runtimePrograms', () => {
  it('lists reported programs and defaults only an omitted field to Qwen', () => {
    expect(runtimePrograms({ programs: ['codex', 'qwen', 'other'] })).toEqual([
      'qwen',
      'codex',
    ]);
    expect(runtimePrograms({ programs: ['claude'] })).toEqual(['claude']);
    expect(runtimePrograms({})).toEqual(['qwen']);
    expect(runtimePrograms({ programs: [] })).toEqual([]);
    expect(runtimePrograms({ programs: ['other'] })).toEqual([]);
  });
});
