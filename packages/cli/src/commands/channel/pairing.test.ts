/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingStore } from '@qwen-code/channel-base';
import { pairingListCommand, pairingApproveCommand } from './pairing.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

type ListArgs = Parameters<
  NonNullable<typeof pairingListCommand.handler>
>[0] extends infer T
  ? T
  : never;

// The CLI must address the same workspace-scoped store the channel worker
// uses (#7017): `--cwd` selects the scope, and two workspaces sharing a
// channel name never see each other's requests through the CLI.
describe('channel pairing CLI (--cwd scoping)', () => {
  let qwenHome: string;
  let wsA: string;
  let wsB: string;
  const originalQwenHome = process.env['QWEN_HOME'];

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-pairing-cli-'));
    process.env['QWEN_HOME'] = qwenHome;
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b-'));
    vi.mocked(writeStdoutLine).mockClear();
    vi.mocked(writeStderrLine).mockClear();
  });

  afterEach(() => {
    if (originalQwenHome !== undefined) {
      process.env['QWEN_HOME'] = originalQwenHome;
    } else {
      delete process.env['QWEN_HOME'];
    }
    for (const dir of [qwenHome, wsA, wsB]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const stdoutText = () =>
    vi
      .mocked(writeStdoutLine)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');

  it('lists only the requests of the workspace given via --cwd', () => {
    // Seed through the same PairingStore call the channel worker makes.
    new PairingStore('support-bot', wsA).createRequest('user-alice', 'Alice');
    new PairingStore('support-bot', wsB).createRequest('user-bob', 'Bob');

    pairingListCommand.handler!({
      name: 'support-bot',
      cwd: wsA,
      _: [],
      $0: '',
    } as unknown as ListArgs);

    const out = stdoutText();
    expect(out).toContain('Alice');
    expect(out).not.toContain('Bob');
  });

  it('prints the workspace-aware hint when the scoped store is empty', () => {
    new PairingStore('support-bot', wsB).createRequest('user-bob', 'Bob');

    pairingListCommand.handler!({
      name: 'support-bot',
      cwd: wsA,
      _: [],
      $0: '',
    } as unknown as ListArgs);

    expect(stdoutText()).toContain(
      'No pending pairing requests in this workspace',
    );
  });

  it('approve acts on the --cwd workspace and leaves the other untouched', () => {
    const storeA = new PairingStore('support-bot', wsA);
    const code = storeA.createRequest('user-alice', 'Alice')!;
    new PairingStore('support-bot', wsB).createRequest('user-bob', 'Bob');

    pairingApproveCommand.handler!({
      name: 'support-bot',
      code,
      cwd: wsA,
      _: [],
      $0: '',
    } as unknown as Parameters<
      NonNullable<typeof pairingApproveCommand.handler>
    >[0]);

    expect(new PairingStore('support-bot', wsA).isApproved('user-alice')).toBe(
      true,
    );
    expect(new PairingStore('support-bot', wsB).isApproved('user-alice')).toBe(
      false,
    );
  });

  it('approve with a code from another workspace fails with the scoped error', () => {
    const codeB = new PairingStore('support-bot', wsB).createRequest(
      'user-bob',
      'Bob',
    )!;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    try {
      pairingApproveCommand.handler!({
        name: 'support-bot',
        code: codeB,
        cwd: wsA,
        _: [],
        $0: '',
      } as unknown as Parameters<
        NonNullable<typeof pairingApproveCommand.handler>
      >[0]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(new PairingStore('support-bot', wsB).isApproved('user-bob')).toBe(
        false,
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});
