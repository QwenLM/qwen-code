import { describe, it, expect, afterEach } from 'vitest';
import {
  AoneCliUnavailableError,
  AoneCommandError,
  aoneWhoamiAccount,
  runA1Json,
  setA1ExecForTest,
  type A1Exec,
} from './a1-client.js';

afterEach(() => {
  setA1ExecForTest();
});

function execReturning(stdout: string): A1Exec {
  return async () => ({ stdout });
}

function execFailing(error: Record<string, unknown>): A1Exec {
  return async () => {
    throw error;
  };
}

describe('runA1Json', () => {
  it('appends --format json and parses the body', async () => {
    const calls: string[][] = [];
    setA1ExecForTest(async (args) => {
      calls.push([...args]);
      return { stdout: '{"ok":true}' };
    });
    const out = await runA1Json<{ ok: boolean }>(['auth', 'whoami']);
    expect(out).toEqual({ ok: true });
    expect(calls[0]).toEqual([
      'auth',
      'whoami',
      '--no-update-check',
      '--format',
      'json',
    ]);
  });

  it('treats an a1.error/v1 object at exit 0 as an error', async () => {
    setA1ExecForTest(
      execReturning(
        JSON.stringify({
          schemaVersion: 'a1.error/v1',
          code: 'COMMAND_FAILED',
          message: '没有权限',
        }),
      ),
    );
    await expect(runA1Json(['events', 'repo', 'g/p'])).rejects.toThrow(
      '没有权限',
    );
  });

  it('reads the structured cause from exit-1 stdout', async () => {
    setA1ExecForTest(
      execFailing({
        code: 1,
        stdout: JSON.stringify({
          schemaVersion: 'a1.error/v1',
          message: 'SYSTEM_FORBIDDEN_ERROR',
        }),
        stderr: '',
      }),
    );
    await expect(runA1Json(['events', 'repo', 'g/p'])).rejects.toThrow(
      'SYSTEM_FORBIDDEN_ERROR',
    );
  });

  it('falls back to stderr when exit-1 stdout is not an error object', async () => {
    setA1ExecForTest(
      execFailing({ code: 1, stdout: 'noise', stderr: 'boom happened' }),
    );
    await expect(runA1Json(['x'])).rejects.toThrow('boom happened');
  });

  it('names a timeout from the killed flag', async () => {
    setA1ExecForTest(execFailing({ killed: true, stderr: '' }));
    await expect(runA1Json(['x'])).rejects.toThrow(/timed out after 20s/);
  });

  it('maps ENOENT to an actionable install error', async () => {
    setA1ExecForTest(execFailing({ code: 'ENOENT' }));
    await expect(runA1Json(['x'])).rejects.toThrow(AoneCliUnavailableError);
    await expect(runA1Json(['x'])).rejects.toThrow(/a1 auth login/);
  });

  it('rejects non-JSON output', async () => {
    setA1ExecForTest(execReturning('not json'));
    await expect(runA1Json(['x'])).rejects.toThrow(AoneCommandError);
    await expect(runA1Json(['x'])).rejects.toThrow(/non-JSON/);
  });

  it('never retries a failed call (write-once transport)', async () => {
    let calls = 0;
    setA1ExecForTest(async () => {
      calls++;
      throw { code: 1, stdout: '', stderr: 'transient' };
    });
    await expect(runA1Json(['x'])).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('aoneWhoamiAccount', () => {
  it('returns the trimmed account', async () => {
    setA1ExecForTest(execReturning('{"account":" shaojin.wensj "}'));
    expect(await aoneWhoamiAccount()).toBe('shaojin.wensj');
  });

  it('throws on a null body', async () => {
    setA1ExecForTest(execReturning('null'));
    await expect(aoneWhoamiAccount()).rejects.toThrow(/no account/);
  });

  it('throws on a missing or blank account', async () => {
    setA1ExecForTest(execReturning('{}'));
    await expect(aoneWhoamiAccount()).rejects.toThrow(/no account/);
    setA1ExecForTest(execReturning('{"account":"  "}'));
    await expect(aoneWhoamiAccount()).rejects.toThrow(/no account/);
  });
});
