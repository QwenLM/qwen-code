/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  connectExistingWith,
  findReplacementRuntime,
  joinCommands,
  joinCoordinatorCommand,
  joinCoordinatorWith,
  joinOutcome,
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

describe('joinOutcome', () => {
  it('reports why a join was not saved, and nothing for a saved one', () => {
    expect(
      joinOutcome({ connected: true, saved: false, saveError: 'disk full' }),
    ).toEqual({ saveError: 'disk full' });
    expect(joinOutcome({ connected: true, saved: false })).toEqual({
      saveError: '',
    });
    expect(joinOutcome({ connected: true, saved: true })).toEqual({});
    // An older daemon sends no `saved` field; it always claimed the save.
    expect(joinOutcome({ connected: true })).toEqual({});
    expect(joinOutcome(undefined)).toEqual({});
  });

  it('reports a join the credential did not record, whose rerun is refused', () => {
    expect(
      joinOutcome({
        connected: true,
        saved: false,
        saveError: 'disk full',
        recorded: false,
      }),
    ).toEqual({ saveError: 'disk full', recorded: false });
    // `recorded: true`, like an older daemon's silence, keeps the remedy.
    expect(
      joinOutcome({ connected: true, saved: false, recorded: true }),
    ).toEqual({ saveError: '' });
  });
});

describe('connectExistingWith', () => {
  const input = {
    remoteUrl: 'https://worker.example',
    remoteToken: 'remote-token',
    remoteCwd: '/remote',
    serverUrl: 'https://hub.example:4170',
    allowHttp: false,
  };

  it('reads the answer of a connect that went through', async () => {
    const connect = vi.fn(async () => ({
      connected: true,
      saved: false,
      saveError: 'disk full',
      workspaceCwd: '/remote',
    }));
    const run = async (action: () => Promise<unknown>) => {
      await action();
      return true;
    };

    expect(await connectExistingWith(run, connect)(input)).toEqual({
      saveError: 'disk full',
      workspaceCwd: '/remote',
    });
    expect(connect).toHaveBeenCalledWith(input);
  });

  it.each([
    ['without a workspace', { connected: true }],
    ['with one that is not a path', { connected: true, workspaceCwd: 1 }],
    ['with no body', null],
  ])('reads an answer %s as from no workspace', async (_label, answer) => {
    const run = async (action: () => Promise<unknown>) => {
      await action();
      return true;
    };

    expect(
      await connectExistingWith(
        run,
        vi.fn(async () => answer),
      )(input),
    ).toEqual({});
  });

  it('passes on a connect that failed, whatever it answered', async () => {
    const connect = vi.fn(async () => ({ connected: true, saved: false }));
    const run = async (action: () => Promise<unknown>) => {
      await action();
      return false;
    };

    expect(await connectExistingWith(run, connect)(input)).toBe(false);
  });

  it('keeps the page busy while a remote connect runs', async () => {
    const busy: boolean[] = [];
    let busyDuring: boolean[] = [];
    const connect = vi.fn(async () => {
      busyDuring = [...busy];
      return { connected: true, saved: false, saveError: 'disk full' };
    });

    const outcome = await connectExistingWith(
      async (action) => {
        await action();
        return true;
      },
      connect,
      (value) => busy.push(value),
    )(input);

    expect(outcome).toEqual({ saveError: 'disk full' });
    expect(busyDuring).toEqual([true]);
    expect(busy).toEqual([true, false]);
  });
});

describe('joinCoordinatorWith', () => {
  it('reads the answer of a join', async () => {
    const join = vi.fn(async () => ({
      connected: true,
      saved: false,
      saveError: 'disk full',
    }));
    const input = {
      serverUrl: 'https://hub.example:4170',
      workspaceId: 'ws_1',
      enrollmentToken: 'join-token',
      allowHttp: false,
    };

    expect(await joinCoordinatorWith(join)(input)).toEqual({
      saveError: 'disk full',
    });
    expect(join).toHaveBeenCalledWith(input);
  });

  it.each([
    ['settles', async () => ({ connected: true })],
    [
      'fails',
      async () => {
        throw new Error('Invalid or expired Agent Host enrollment token.');
      },
    ],
  ] as const)(
    'keeps the page busy while a join runs, until it %s',
    async (_label, answer) => {
      // Leaving the page meanwhile would unmount the dialog that sent it.
      const busy: boolean[] = [];
      let busyDuring: boolean[] = [];
      const join = vi.fn(async () => {
        busyDuring = [...busy];
        return answer();
      });

      await joinCoordinatorWith(join, (value) => busy.push(value))({
        serverUrl: 'https://hub.example:4170',
        workspaceId: 'ws_1',
        enrollmentToken: 'join-token',
        allowHttp: false,
      }).catch(() => undefined);

      expect(busyDuring).toEqual([true]);
      expect(busy).toEqual([true, false]);
    },
  );
});
