import { describe, expect, it } from 'vitest';
import { parseSendCommand } from './sendCommand';

describe('parseSendCommand', () => {
  it('takes everything after the options as the message', () => {
    expect(
      parseSendCommand(
        ' --workspace backend --session-id abc-1 check the build\nthen report',
      ),
    ).toEqual({
      ok: true,
      workspace: 'backend',
      sessionId: 'abc-1',
      message: 'check the build\nthen report',
    });
  });

  it('starts a new session in the current workspace without options', () => {
    expect(parseSendCommand(' hello there')).toEqual({
      ok: true,
      message: 'hello there',
    });
  });

  it('reads quoted and = values', () => {
    expect(
      parseSendCommand(`--workspace "/work/my repo" --session-id=x1 go`),
    ).toEqual({
      ok: true,
      workspace: '/work/my repo',
      sessionId: 'x1',
      message: 'go',
    });
  });

  it('treats options after the message as message text', () => {
    expect(parseSendCommand('fix --workspace flag parsing')).toEqual({
      ok: true,
      message: 'fix --workspace flag parsing',
    });
  });

  it('refuses a missing message, value, or a repeated option', () => {
    expect(parseSendCommand('--workspace backend')).toEqual({
      ok: false,
      error: 'missing-message',
    });
    expect(parseSendCommand('--session-id')).toEqual({
      ok: false,
      error: 'missing-value',
      option: '--session-id',
    });
    expect(parseSendCommand('--workspace "/unterminated go')).toEqual({
      ok: false,
      error: 'missing-value',
      option: '--workspace',
    });
    expect(parseSendCommand('--workspace a --workspace b go')).toEqual({
      ok: false,
      error: 'duplicate-option',
      option: '--workspace',
    });
  });
});
