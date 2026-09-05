/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildResumeCall,
  RESUME_ARGS_CHARS,
  serializeResumeArgs,
} from './workflow-resume-call.js';

describe('workflow resume call', () => {
  it('quotes Windows paths as a round-trippable string literal', () => {
    const scriptPath = 'C:\\Users\\nina\\tasks\\wf_0123.js';
    const call = buildResumeCall({ runId: 'wf_0123', scriptPath });
    const literal = call?.match(/scriptPath: (.*), resumeFromRunId:/)?.[1];

    expect(literal).toBeDefined();
    expect(JSON.parse(literal!)).toBe(scriptPath);
  });

  it('keeps model-visible calls on one sanitized line', () => {
    const call = buildResumeCall({
      runId: 'wf_0123',
      scriptPath: '/tmp/evil\n\r\u001b[31m.js',
    });

    expect(call).not.toContain('\n');
    expect(call).not.toContain('\r');
    expect(call).not.toContain('\u001b');
  });

  it('bounds serialized args without emitting partial JSON', () => {
    expect(serializeResumeArgs('x'.repeat(RESUME_ARGS_CHARS - 2))).toHaveLength(
      RESUME_ARGS_CHARS,
    );
    expect(serializeResumeArgs('x'.repeat(RESUME_ARGS_CHARS - 1))).toBeNull();
    expect(serializeResumeArgs(undefined)).toBeNull();
  });

  it('preserves background mode only when requested by the surface', () => {
    const call = buildResumeCall({
      runId: 'wf_0123',
      scriptPath: '/tmp/wf.js',
      resumeInBackground: true,
    });

    expect(call).toContain('run_in_background: true');
  });
});
