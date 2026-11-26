/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEAR_PROGRAM_STATUS,
  clearProgramStatusRecord,
  encodeProgramStatusText,
  formatProgramStatus,
  PROGRAM_STATUS_APP,
  PROGRAM_STATUS_QUERY,
  sanitizeProgramStatusId,
  truncateUtf8,
} from './programStatus.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');

describe('formatProgramStatus', () => {
  it('encodes a root record with app and ST terminator', () => {
    expect(formatProgramStatus({ state: 'idle' })).toBe(
      `\x1b]7501;state=idle:app=${PROGRAM_STATUS_APP}\x1b\\`,
    );
  });

  it('encodes kind and base64 msg for blocked', () => {
    expect(
      formatProgramStatus({
        state: 'blocked',
        kind: 'permission',
        msg: 'Tool confirmation required',
      }),
    ).toBe(
      `\x1b]7501;state=blocked:kind=permission:app=${PROGRAM_STATUS_APP}:msg=${b64('Tool confirmation required')}\x1b\\`,
    );
  });

  it('drops kind outside blocked and progress outside working/blocked', () => {
    const seq = formatProgramStatus({
      state: 'done',
      kind: 'question',
      progress: 50,
    });
    expect(seq).toBe(`\x1b]7501;state=done:app=${PROGRAM_STATUS_APP}\x1b\\`);
  });

  it('clamps and rounds progress', () => {
    expect(formatProgramStatus({ state: 'working', progress: 140 })).toContain(
      ':progress=100:',
    );
    expect(formatProgramStatus({ state: 'working', progress: -3 })).toContain(
      ':progress=0:',
    );
    expect(formatProgramStatus({ state: 'working', progress: 33.6 })).toContain(
      ':progress=34:',
    );
    expect(
      formatProgramStatus({ state: 'working', progress: Number.NaN }),
    ).not.toContain('progress');
  });

  it('encodes child records with id and title', () => {
    expect(
      formatProgramStatus({ state: 'working', id: 'a-explore-1', title: 'Explore' }),
    ).toBe(
      `\x1b]7501;state=working:id=a-explore-1:app=${PROGRAM_STATUS_APP}:title=${b64('Explore')}\x1b\\`,
    );
  });

  it('omits empty free text', () => {
    expect(formatProgramStatus({ state: 'working', msg: '  \n ' })).toBe(
      `\x1b]7501;state=working:app=${PROGRAM_STATUS_APP}\x1b\\`,
    );
  });

  it('never lets free text break the pair syntax', () => {
    const seq = formatProgramStatus({ state: 'error', msg: 'a:b;c=d\x1b]0;x\x07' });
    const body = seq.slice('\x1b]7501;'.length, -2);
    expect(body.split(':').every((pair) => /^[a-z]+=[A-Za-z0-9_.,+/=-]*$/.test(pair))).toBe(true);
  });
});

describe('encodeProgramStatusText', () => {
  it('replaces control characters and collapses to one line', () => {
    expect(decode(encodeProgramStatusText('a\nb\tc\x1b[31m\u0085d', 100)!)).toBe(
      'a b c [31m d',
    );
  });

  it('cuts to the byte limit on a code point boundary', () => {
    const out = decode(encodeProgramStatusText('é'.repeat(200), 192)!);
    expect(Buffer.byteLength(out, 'utf8')).toBe(192);
    expect(out).toBe('é'.repeat(96));
    expect(out).not.toContain('�');
  });

  it('keeps encoded msg within the spec limit of 2732 bytes', () => {
    const encoded = encodeProgramStatusText('😀'.repeat(2000), 2048)!;
    expect(encoded.length).toBeLessThanOrEqual(2732);
  });
});

describe('truncateUtf8', () => {
  it('does not split a 4-byte code point', () => {
    expect(truncateUtf8('a😀', 3)).toBe('a');
    expect(truncateUtf8('a😀', 5)).toBe('a😀');
  });
});

describe('ids and clear sequences', () => {
  it('sanitizes ids to the spec charset and length', () => {
    expect(sanitizeProgramStatusId('a-explore-abc123')).toBe('a-explore-abc123');
    expect(sanitizeProgramStatusId('a/b c:d')).toBe('a-b-c-d');
    expect(sanitizeProgramStatusId('x'.repeat(40))).toHaveLength(32);
    expect(sanitizeProgramStatusId('///')).toBeUndefined();
  });

  it('builds probe and clear sequences', () => {
    expect(PROGRAM_STATUS_QUERY).toBe('\x1b]7501;?\x1b\\');
    expect(CLEAR_PROGRAM_STATUS).toBe('\x1b]7501;state=clear\x1b\\');
    expect(clearProgramStatusRecord('a-1')).toBe(
      '\x1b]7501;state=clear:id=a-1\x1b\\',
    );
  });
});
