/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import yargs from 'yargs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const core = vi.hoisted(() => ({
  answerAsk: vi.fn(),
  assertSafeName: vi.fn(),
  claimBoardTask: vi.fn(),
  completeBoardTask: vi.fn(),
  createAsk: vi.fn(),
  createBoardTask: vi.fn(),
  declineAsk: vi.fn(),
  getAsk: vi.fn(),
  listAsks: vi.fn(),
  listBoardTasks: vi.fn(),
  pruneAsks: vi.fn(),
  pruneBoardTasks: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core/board', () => core);

import { boardCommand } from '../board.js';
import { renderBoard } from './render.js';

const TASK_ID = 't-00000000-0000-4000-8000-000000000001';
const ASK_ID = 'a-00000000-0000-4000-8000-000000000002';

async function parse(command: string): Promise<void> {
  await yargs(command.split(' '))
    .command(boardCommand)
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

// Real stdout invokes the write callback once the chunk is flushed, and `emit`
// waits for it, so a faithful stub has to invoke it too.
function stubWrite(): typeof process.stdout.write {
  return ((
    _chunk: unknown,
    encodingOrCb?: unknown,
    cb?: (err?: Error | null) => void,
  ) => {
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    (done as ((err?: Error | null) => void) | undefined)?.(null);
    return true;
  }) as unknown as typeof process.stdout.write;
}

function written(spy: MockInstance<typeof process.stdout.write>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

describe('board CLI', () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(stubWrite());
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    core.listBoardTasks.mockResolvedValue([]);
    core.listAsks.mockResolvedValue([]);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  });

  it('requires an explicit board', async () => {
    await parse('board show');
    expect(stderr).toHaveBeenCalledWith('Pass --board <name>.\n');
    expect(process.exitCode).toBe(1);
  });

  it('requires and forwards the actor for mutations', async () => {
    core.createBoardTask.mockResolvedValue({ id: TASK_ID, subject: 'check' });
    await parse('board task check --board demo --as author --json');
    expect(core.createBoardTask).toHaveBeenCalledWith({
      board: 'demo',
      createdBy: 'author',
      subject: 'check',
      owner: undefined,
    });
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({ id: TASK_ID, subject: 'check' })}\n`,
      expect.any(Function),
    );
  });

  it('passes the declared actor when answering', async () => {
    core.answerAsk.mockResolvedValue({ id: ASK_ID, state: 'answered' });
    await parse(`board answer ${ASK_ID} yes --board demo --as web --json`);
    expect(core.answerAsk).toHaveBeenCalledWith('demo', ASK_ID, 'web', 'yes');
  });

  it.each([
    ['answered', undefined],
    ['declined', 2],
    ['timeout', 3],
  ] as const)('maps an ask %s outcome to exit code %s', async (state, code) => {
    core.createAsk.mockResolvedValue({ id: ASK_ID, to: 'web' });
    core.getAsk.mockResolvedValue({ id: ASK_ID, state, answer: 'yes' });
    await parse(
      'board ask web question --board demo --as api --wait --timeout 1 --ttl 1 --json',
    );
    expect(process.exitCode).toBe(code);
  });

  it('uses exit code 4 when the local wait ends first', async () => {
    core.createAsk.mockResolvedValue({ id: ASK_ID, to: 'web' });
    core.getAsk.mockResolvedValue({ id: ASK_ID, state: 'open' });
    await parse(
      'board ask web question --board demo --as api --wait --timeout 0 --ttl 1',
    );
    expect(process.exitCode).toBe(4);
  });

  it('reports an ask removed while waiting as missing', async () => {
    core.createAsk.mockResolvedValue({ id: ASK_ID, to: 'web' });
    core.getAsk.mockResolvedValue(null);
    await parse(
      'board ask web question --board demo --as api --wait --timeout 0 --ttl 1',
    );
    expect(stderr).toHaveBeenCalledWith(`Ask "${ASK_ID}" not found.\n`);
    expect(process.exitCode).toBe(1);
  });

  it('sanitizes human output and errors', async () => {
    core.createBoardTask.mockResolvedValue({
      id: TASK_ID,
      subject: 'check\x1b]52;c;pw\x07',
    });
    await parse('board task check --board demo --as author');
    expect(written(stdout)).not.toContain('\x1b');
    expect(written(stdout)).not.toContain('\x07');

    core.listBoardTasks.mockRejectedValue(new Error('bad\x1b]52;c;pw\x07'));
    await parse('board show --board demo');
    expect(stderr.mock.calls.flat().join('')).not.toContain('\x1b');
    expect(stderr.mock.calls.flat().join('')).not.toContain('\x07');
  });

  it('keeps the show panel multi-line while still sanitizing it', async () => {
    core.listBoardTasks.mockResolvedValue([
      {
        id: TASK_ID,
        subject: 'first\nsecond',
        status: 'in_progress',
        owner: 'worker',
      },
      {
        id: 't-00000000-0000-4000-8000-000000000003',
        subject: 'third\x1b]52;c;pw\x07',
        status: 'pending',
        owner: null,
      },
    ]);
    await parse('board show --board demo');
    const out = written(stdout);
    expect(out.trim().split('\n')).toHaveLength(3);
    expect(out).toContain('first second');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  it('prints a multi-line ask answer without flattening it', async () => {
    core.createAsk.mockResolvedValue({ id: ASK_ID, to: 'web' });
    core.getAsk.mockResolvedValue({
      id: ASK_ID,
      state: 'answered',
      answer: 'line one\nline two',
    });
    await parse(
      'board ask web question --board demo --as api --wait --timeout 1 --ttl 1',
    );
    expect(stdout).toHaveBeenCalledWith(
      'line one\nline two\n',
      expect.any(Function),
    );
  });

  it('rejects a negative prune cutoff before deleting', async () => {
    await parse('board prune --board demo --as human --older-than -1');
    expect(core.pruneAsks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(['-5', 'abc'])(
    'rejects --timeout %s before creating the ask',
    async (timeout) => {
      await parse(
        `board ask web question --board demo --as api --wait --timeout=${timeout}`,
      );
      expect(core.createAsk).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        '--timeout must be a finite number >= 0.\n',
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it('waits for stdout to drain before the handler resolves', async () => {
    let flush: (() => void) | undefined;
    stdout.mockImplementation(((
      _chunk: unknown,
      cb?: (err?: Error | null) => void,
    ) => {
      flush = () => cb?.(null);
      return false;
    }) as unknown as typeof process.stdout.write);

    let settled = false;
    const parsed = parse('board show --board demo --json').then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // `parseArguments` calls process.exit once this resolves, so it must not
    // resolve while a pipe write is still queued.
    expect(settled).toBe(false);
    expect(flush).toBeDefined();

    flush?.();
    await parsed;
    expect(settled).toBe(true);
  });

  it('stops quietly when the reader closes the pipe', async () => {
    const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    stdout.mockImplementation(((
      _chunk: unknown,
      cb?: (err?: Error | null) => void,
    ) => {
      // Real stdout reports a closed reader to the callback and then re-emits
      // it on the stream.
      cb?.(epipe);
      process.stdout.emit('error', epipe);
      return false;
    }) as unknown as typeof process.stdout.write);

    await parse('board show --board demo --json');
    expect(written(stderr)).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a write failure that is not a closed reader', async () => {
    const enospc: NodeJS.ErrnoException = new Error('no space left on device');
    enospc.code = 'ENOSPC';
    stdout.mockImplementation(((
      _chunk: unknown,
      cb?: (err?: Error | null) => void,
    ) => {
      cb?.(enospc);
      return false;
    }) as unknown as typeof process.stdout.write);

    await parse('board show --board demo --json');
    expect(written(stderr)).toContain('no space left on device');
    expect(process.exitCode).toBe(1);
  });
});

describe('board rendering', () => {
  it('keeps full actionable ids and one line per item', () => {
    const output = renderBoard({
      board: 'demo',
      tasks: [
        {
          schemaVersion: 1,
          id: TASK_ID,
          subject: 'first\nsecond',
          createdBy: 'author',
          owner: 'worker',
          status: 'in_progress',
          createdAt: 1,
          updatedAt: 1,
          notes: [],
        },
      ],
      asks: [],
    });
    expect(output).toContain(TASK_ID);
    expect(output).toContain('first second');
    expect(output.split('\n')).toHaveLength(2);
  });
});
