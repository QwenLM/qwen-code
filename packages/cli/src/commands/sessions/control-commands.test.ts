/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import yargs, { type Argv } from 'yargs';

const connectExistingAgentViewSupervisor = vi.fn();

vi.mock('../../agent-view/supervisor-runner.js', () => ({
  connectExistingAgentViewSupervisor: (...args: unknown[]) =>
    connectExistingAgentViewSupervisor(...args),
}));

const stdout: string[] = [];
const stderr: string[] = [];

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => stderr.push(line),
}));

const { answerCommand, peekCommand } = await import('./control-commands.js');

const SESSION = '0f8e1c42-9d3a-4d21-8f77-2b6a7c9e0c31';

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  connectExistingAgentViewSupervisor.mockReset();
});

afterEach(() => {
  process.exitCode = savedExitCode;
});

async function run(
  command: { handler?: unknown },
  argv: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (command.handler as any)(argv);
}

/**
 * Drive a parse the way the CLI does. `config.ts` builds its yargs tree
 * from `hideBin(process.argv)`, and `answer` cuts its text back out of
 * those same raw args, so a parse test has to give yargs and `process.argv`
 * the one argv.
 */
async function withRawArgs<T>(
  argv: string[],
  parse: () => Promise<T>,
): Promise<T> {
  const savedArgv = process.argv;
  process.argv = ['node', 'qwen', ...argv];
  try {
    return await parse();
  } finally {
    process.argv = savedArgv;
  }
}

/**
 * Parse through a chain that mirrors the real one: the root yargs instance
 * registers globals (config.ts: --debug/-d, --proxy, --telemetry*,
 * --version/-v, ...), and the sessions builder disables --version.
 *
 * Those globals stay known inside the answer subtree, where
 * `unknown-options-as-args` cannot see them, so without
 * forgetInheritedOptions a quoted flag sets the option and is silently
 * stripped from the text.
 */
async function parseWithRootOptions(
  argv: string[],
): Promise<Record<string, unknown>> {
  return (await withRawArgs(argv, () =>
    yargs(argv)
      .option('debug', { type: 'boolean', alias: 'd', default: false })
      .option('proxy', { type: 'string' })
      .version('x')
      .alias('v', 'version')
      .command({
        command: 'sessions',
        describe: 'Manage Qwen Code sessions',
        builder: (y: Argv) =>
          y.command(answerCommand).demandCommand(1).version(false),
        handler: () => {},
      })
      .strict()
      .exitProcess(false)
      .parseAsync(),
  )) as Record<string, unknown>;
}

/** What the handler passed to the supervisor as the session id. */
function deliveredSession(answer: { mock: { calls: unknown[][] } }) {
  const call = answer.mock.calls[0] ?? [];
  return call[0];
}

describe('session control command reporting', () => {
  it('writes a failure to stderr and keeps stdout clean', async () => {
    // No supervisor running: peek fails, and the message must not land
    // in the success channel of a `qwen sessions peek <id> > last.log`.
    connectExistingAgentViewSupervisor.mockResolvedValue(undefined);
    await run(peekCommand, { session: SESSION });
    expect(stderr.join('\n')).toContain(
      'No background supervisor is reachable',
    );
    expect(stderr.join('\n')).toContain('qwen sessions ps');
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('writes a refused answer to stderr, not into the result', async () => {
    // The shape that bit before the fix: `answer "$id" "$reply" > last.log`
    // against a stale id wrote the error into the redirected file, mixed
    // with what success prints, distinguishable only by exit code.
    connectExistingAgentViewSupervisor.mockResolvedValue({
      answer: vi
        .fn()
        .mockRejectedValue(new Error('No Agent View session found for zz.')),
    });
    await run(answerCommand, { session: 'zz', text: ['yes'] });
    expect(stderr).toEqual(['No Agent View session found for zz.']);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('writes a delivered answer to stdout', async () => {
    connectExistingAgentViewSupervisor.mockResolvedValue({
      answer: vi.fn().mockResolvedValue({ sessionId: SESSION, answered: true }),
    });
    await run(answerCommand, { session: SESSION, text: ['yes'] });
    expect(stdout).toEqual(['Answer delivered.']);
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('answer command parsing', () => {
  // Parse-level tests against the real yargs tree: the handler joins the
  // variadic tail, so what reaches it — not what the user quoted — is
  // what a dash-leading answer must survive.
  async function parse(argv: string[]): Promise<void> {
    await withRawArgs(argv, () =>
      yargs(argv).command(answerCommand).strict().parseAsync(),
    );
  }

  function mockDelivered() {
    const answer = vi
      .fn()
      .mockResolvedValue({ sessionId: SESSION, answered: true });
    connectExistingAgentViewSupervisor.mockResolvedValue({ answer });
    return answer;
  }

  it('delivers a dash-leading answer instead of parsing it as options', async () => {
    const answer = mockDelivered();
    await parse(['answer', SESSION, '--force']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--force');
    expect(stdout).toEqual(['Answer delivered.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('takes the tokens after -- as the answer', async () => {
    const answer = mockDelivered();
    await parse(['answer', SESSION, '--', '--force']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--force');
    expect(stdout).toEqual(['Answer delivered.']);
  });

  it('keeps a plain answer working', async () => {
    const answer = mockDelivered();
    await parse(['answer', SESSION, 'yes, go ahead']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'yes, go ahead');
  });

  it('refuses an empty answer rather than parsing one out of nothing', async () => {
    const answer = mockDelivered();
    await parse(['answer', SESSION]);
    expect(answer).not.toHaveBeenCalled();
    expect(stderr).toEqual(['An answer cannot be empty.']);
    expect(process.exitCode).toBe(1);
  });
});

describe('answer command parsing with the root options registered', () => {
  const parse = parseWithRootOptions;

  function mockDelivered() {
    const answer = vi
      .fn()
      .mockResolvedValue({ sessionId: SESSION, answered: true });
    connectExistingAgentViewSupervisor.mockResolvedValue({ answer });
    return answer;
  }

  it('keeps a quoted root option in the answer text', async () => {
    const answer = mockDelivered();
    await parse([
      'sessions',
      'answer',
      SESSION,
      'please',
      'set',
      '--debug',
      'on',
    ]);
    expect(answer).toHaveBeenCalledWith(SESSION, 'please set --debug on');
    expect(stdout).toEqual(['Answer delivered.']);
  });

  it('keeps a quoted root option that takes a value', async () => {
    const answer = mockDelivered();
    await parse([
      'sessions',
      'answer',
      SESSION,
      'use',
      '--proxy',
      'http://x',
      'now',
    ]);
    expect(answer).toHaveBeenCalledWith(SESSION, 'use --proxy http://x now');
  });

  it('delivers an answer that is only a root option', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, '--debug']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--debug');
    expect(stderr).toEqual([]);
  });

  it('keeps the short alias of a root option', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'rerun', '-d', 'now']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'rerun -d now');
  });

  it('keeps the version alias in the answer text', async () => {
    // `.version(false)` up the chain deletes `version` from the key/type
    // groups but leaves the alias entry `v: ['version']` behind, which
    // keeps `-v` known unless forgetInheritedOptions forgets it too.
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'rerun', '-v', 'now']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'rerun -v now');
  });

  it('delivers an answer that is only --version', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, '--version']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--version');
    expect(stderr).toEqual([]);
  });

  it('still shows help for a bare --help', async () => {
    // The carve-out promised in the positional's describe: quoting flags
    // in the text must not swallow the help flag itself.
    const answer = mockDelivered();
    const parsed = await parse(['sessions', 'answer', SESSION, '--help']);
    expect(parsed['help']).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
  });

  it('still takes the tokens after -- as the answer', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, '--', '--debug']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--debug');
  });

  it('keeps an unknown option when root options are registered', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, '--frobnicate', 'keep']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--frobnicate keep');
  });

  it('keeps a plain answer working when root options are registered', async () => {
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'yes, go ahead']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'yes, go ahead');
  });
});

describe('answer text yargs cannot hand over intact', () => {
  // `--help` has to stay a known boolean so a bare `--help` still shows
  // help, and yargs-parser counts every `--no-<known flag>` as a negated
  // boolean rather than an unknown option; separately, the variadic
  // positional is re-parsed as argv by yargs' postProcessPositionals. Both
  // edit an answer while the command still reports success, so the handler
  // takes the tail from the raw args instead.
  const parse = parseWithRootOptions;

  function mockDelivered(sessionId: string = SESSION) {
    const answer = vi.fn().mockResolvedValue({ sessionId, answered: true });
    connectExistingAgentViewSupervisor.mockResolvedValue({ answer });
    return answer;
  }

  it('keeps a negated --help in the answer text', async () => {
    // Without the raw tail this delivered "please me": yargs-parser folded
    // `--no-help` into the kept `help` boolean and dropped it from the
    // variadic positional, then printed "Answer delivered." anyway.
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'please', '--no-help', 'me']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'please --no-help me');
    expect(stdout).toEqual(['Answer delivered.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps --help=false in the answer text', async () => {
    // The `=` form of the same negation: known option, so it set help and
    // vanished from the text.
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'go', '--help=false', 'on']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'go --help=false on');
    expect(stdout).toEqual(['Answer delivered.']);
  });

  it('keeps a quoted --text in the answer text', async () => {
    // `text` is registered after forgetInheritedOptions, so yargs still
    // knows it as an option: both tokens were consumed and the command
    // refused an answer it had been given.
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, '--text', 'hello']);
    expect(answer).toHaveBeenCalledWith(SESSION, '--text hello');
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(['Answer delivered.']);
  });

  it('does not let a quoted --session= re-bind the session id', async () => {
    // postProcessPositionals re-parses the positional values as argv, so
    // `--session=zzz` bound a second time and turned the id into an array
    // the supervisor's requireSessionId would reject — after dropping the
    // token from the text and reporting success.
    const answer = mockDelivered();
    await parse(['sessions', 'answer', SESSION, 'use', '--session=zzz']);
    expect(answer).toHaveBeenCalledWith(SESSION, 'use --session=zzz');
    const sessionId = deliveredSession(answer);
    expect(typeof sessionId).toBe('string');
    expect(sessionId).toBe(SESSION);
    expect(stdout).toEqual(['Answer delivered.']);
  });

  it('keeps an all-digit session id a string', async () => {
    // requireSessionId demands a string, and yargs coerces an all-digit
    // positional to a number.
    const answer = mockDelivered('12345');
    await parse(['sessions', 'answer', '12345', 'hi']);
    expect(answer).toHaveBeenCalledWith('12345', 'hi');
    expect(typeof deliveredSession(answer)).toBe('string');
  });
});
