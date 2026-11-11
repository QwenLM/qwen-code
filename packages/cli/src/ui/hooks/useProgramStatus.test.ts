/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatProgramStatus } from '../../ink/termio/programStatus.js';
import { encodeProgramStatusRecords } from '../utils/programStatus.js';
import { diffProgramStatusRecords } from './useProgramStatus.js';

const idle = formatProgramStatus({ state: 'idle' });
const working = formatProgramStatus({ state: 'working' });
const child = formatProgramStatus({ state: 'working', id: 'a-1', title: 'x' });

describe('diffProgramStatusRecords', () => {
  it('writes every record the first time and nothing when unchanged', () => {
    const sent = new Map<string, string>();
    const wanted = encodeProgramStatusRecords({ state: 'idle' }, []);
    expect(diffProgramStatusRecords(sent, wanted)).toBe(idle);
    expect(diffProgramStatusRecords(sent, wanted)).toBe('');
  });

  it('writes only the record that changed', () => {
    const sent = new Map<string, string>();
    diffProgramStatusRecords(
      sent,
      encodeProgramStatusRecords({ state: 'idle' }, [
        { id: 'a-1', state: 'working', title: 'x' },
      ]),
    );
    expect(
      diffProgramStatusRecords(
        sent,
        encodeProgramStatusRecords({ state: 'working' }, [
          { id: 'a-1', state: 'working', title: 'x' },
        ]),
      ),
    ).toBe(working);
  });

  it('clears a child record that disappeared', () => {
    const sent = new Map<string, string>();
    diffProgramStatusRecords(
      sent,
      encodeProgramStatusRecords({ state: 'working' }, [
        { id: 'a-1', state: 'working', title: 'x' },
      ]),
    );
    expect(sent.get('a-1')).toBe(child);
    expect(
      diffProgramStatusRecords(sent, encodeProgramStatusRecords({ state: 'working' }, [])),
    ).toBe('\x1b]7501;state=clear:id=a-1\x1b\\');
    expect(sent.has('a-1')).toBe(false);
  });
});
