/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const addPeerController = vi.fn();
const listPeerControllers = vi.fn();
const removePeerController = vi.fn();

class FakePeerControllerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PeerControllerError';
  }
}

vi.mock('@qwen-code/qwen-code-core', () => ({
  addPeerController: (...args: unknown[]) => addPeerController(...args),
  listPeerControllers: (...args: unknown[]) => listPeerControllers(...args),
  removePeerController: (...args: unknown[]) => removePeerController(...args),
  getPeerControllerRegistryPath: () => '/home/u/.qwen/peer-controllers.json',
  PeerControllerError: FakePeerControllerError,
}));

const stdout: string[] = [];
const stderr: string[] = [];

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => stderr.push(line),
}));

const { handleAdd, handleControllerList, handleRemove, ID_COL, LABEL_COL } =
  await import('./controllers.js');

const TOKEN = `qpc_${'a'.repeat(64)}`;

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'c_0123abcd',
    label: 'voice bridge',
    tokenHash: 'f'.repeat(64),
    createdAt: Date.parse('2026-09-05T02:33:00Z'),
    ...over,
  };
}

let exitCode: number | undefined;

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  exitCode = undefined;
  addPeerController.mockReset();
  listPeerControllers.mockReset();
  removePeerController.mockReset();
  // The handlers call process.exit on failure; intercept rather than
  // tear the worker down, and let the code after it run as it would.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    return undefined as never;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('controllers add', () => {
  it('prints the token exactly once, with the auth line to paste', async () => {
    addPeerController.mockResolvedValue({ record: record(), token: TOKEN });

    await handleAdd({ label: 'voice bridge' });

    expect(addPeerController).toHaveBeenCalledWith('voice bridge');
    const out = stdout.join('\n');
    expect(out).toContain('Controller "voice bridge" added (c_0123abcd).');
    expect(out).toContain('shown once');
    // Once as the bare token, once inside the example auth line — and
    // nowhere else, so a user who scrolls past cannot recover it.
    expect(out.split(TOKEN)).toHaveLength(3);
    expect(out).toContain(`{"msgV":1,"type":"auth","token":"${TOKEN}"}`);
    expect(exitCode).toBeUndefined();
  });

  it('says what the grant does to the gate', async () => {
    addPeerController.mockResolvedValue({ record: record(), token: TOKEN });
    await handleAdd({ label: 'voice bridge' });
    const out = stdout.join('\n');
    expect(out).toContain('without per-message review');
    expect(out).toContain('agents.crossSessionInbound');
  });

  it('emits one JSON object with --json', async () => {
    const created = record();
    addPeerController.mockResolvedValue({ record: created, token: TOKEN });

    await handleAdd({ label: 'voice bridge', json: true });

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      id: created.id,
      label: created.label,
      token: TOKEN,
      createdAt: created.createdAt,
    });
    // The stored hash is a credential's shadow; it is projected away.
    expect(stdout[0]).not.toContain('tokenHash');
  });

  it('reports a rejected label as the error it is', async () => {
    addPeerController.mockRejectedValue(
      new FakePeerControllerError(
        'A controller needs a label.',
        'invalid-label',
      ),
    );

    await handleAdd({ label: '  ' });

    expect(stdout).toHaveLength(0);
    expect(stderr.join('\n')).toBe('Error: A controller needs a label.');
    expect(exitCode).toBe(1);
  });

  it('names the file when the write itself fails', async () => {
    addPeerController.mockRejectedValue(new Error('EROFS: read-only'));

    await handleAdd({ label: 'voice bridge' });

    expect(stderr.join('\n')).toContain('/home/u/.qwen/peer-controllers.json');
    expect(stderr.join('\n')).toContain('EROFS');
    expect(exitCode).toBe(1);
  });
});

describe('controllers list', () => {
  it('says how to add one when the list is empty', async () => {
    listPeerControllers.mockResolvedValue([]);
    await handleControllerList({});
    expect(stdout.join('\n')).toBe(
      'No trusted controllers. Add one with: qwen sessions controllers add --label <name>',
    );
  });

  it('prints a table and never the hash', async () => {
    listPeerControllers.mockResolvedValue([
      record(),
      record({ id: 'c_89abcdef', label: 'dictation' }),
    ]);

    await handleControllerList({});

    expect(stdout[0].startsWith('ID')).toBe(true);
    expect(stdout[0]).toContain('LABEL');
    expect(stdout[0]).toContain('CREATED');
    expect(stdout[1]).toContain('c_0123abcd');
    expect(stdout[1]).toContain('voice bridge');
    expect(stdout[1]).toContain('2026-09-05');
    expect(stdout.join('\n')).not.toContain('f'.repeat(64));
    // The label column is padded, so the CREATED cells line up.
    expect(stdout[1].indexOf('2026-09-05')).toBe(ID_COL + LABEL_COL);
  });

  it('strips an escape sequence a hand edit put in a label', async () => {
    listPeerControllers.mockResolvedValue([record({ label: '[2Kvoice' })]);
    await handleControllerList({});
    expect(stdout.join('\n')).not.toContain('');
    expect(stdout.join('\n')).toContain('voice');
  });

  it('emits JSON Lines without the hash', async () => {
    listPeerControllers.mockResolvedValue([record()]);
    await handleControllerList({ json: true });
    expect(JSON.parse(stdout[0])).toEqual({
      id: 'c_0123abcd',
      label: 'voice bridge',
      createdAt: record().createdAt,
    });
  });

  it('reports an unreadable registry and exits nonzero', async () => {
    listPeerControllers.mockRejectedValue(new Error('EACCES'));
    await handleControllerList({});
    expect(stderr.join('\n')).toContain('EACCES');
    expect(exitCode).toBe(1);
  });
});

describe('controllers remove', () => {
  it('confirms the revocation and when it takes effect', async () => {
    removePeerController.mockResolvedValue(record());

    await handleRemove({ id: 'c_0123abcd' });

    expect(removePeerController).toHaveBeenCalledWith('c_0123abcd');
    const out = stdout.join('\n');
    expect(out).toContain('Removed controller "voice bridge" (c_0123abcd).');
    // A credential file is normally read at startup; say that this one
    // is not, or the user will restart their sessions for nothing.
    expect(out).toContain('next connection');
    expect(exitCode).toBeUndefined();
  });

  it('exits nonzero for an id nothing holds', async () => {
    removePeerController.mockResolvedValue(null);

    await handleRemove({ id: 'c_99999999' });

    expect(stdout).toHaveLength(0);
    expect(stderr.join('\n')).toContain(
      'no controller has the id "c_99999999"',
    );
    expect(stderr.join('\n')).toContain('controllers list');
    expect(exitCode).toBe(1);
  });

  it('reports a failed write', async () => {
    removePeerController.mockRejectedValue(new Error('EROFS'));
    await handleRemove({ id: 'c_0123abcd' });
    expect(stderr.join('\n')).toContain('EROFS');
    expect(exitCode).toBe(1);
  });
});
