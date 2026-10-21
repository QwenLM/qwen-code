/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tailPerJob } from './ci-log.js';

describe('tailPerJob', () => {
  it('keeps the last lines of each job and says how many were dropped', () => {
    const log = [
      'build\tsetup\tone',
      'build\tsetup\ttwo',
      'test\trun\talpha',
      'build\tcompile\tthree',
      '',
    ].join('\n');
    expect(tailPerJob(log, 2)).toEqual({
      text: [
        'build\t… 1 earlier lines omitted',
        'build\tsetup\ttwo',
        'build\tcompile\tthree',
        'test\trun\talpha',
        '',
      ].join('\n'),
      jobs: ['build', 'test'],
    });
  });

  it('keeps a short log whole', () => {
    expect(tailPerJob('test\trun\tok', 200)).toEqual({
      text: 'test\trun\tok\n',
      jobs: ['test'],
    });
  });
});
