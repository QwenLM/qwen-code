/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRunOutput,
  createRunClassifier,
  describeSilentFailure,
  escapeAnnotation,
  runAndReport,
} from '../run-release-workspace-tests.js';

// Trimmed from release run 33576013293, the failure this script exists for:
// every test passed and the job still exited 1.
const GREEN_WITH_UNHANDLED_ERROR = `
 ✓ src/utils/env.test.ts (12 tests) 3ms
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: write after end
 ❯ wt.write ../../node_modules/tar/node_modules/minipass/src/index.ts:547:26
 ❯ wt.[process] ../../node_modules/tar/src/pack.ts:352:15
This error originated in "src/extension/archive-safety.test.ts" test file.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  211 passed (211)
      Tests  9480 passed | 1 skipped (9481)
`;

const ORDINARY_TEST_FAILURE = `
 ✓ src/utils/env.test.ts (12 tests) 3ms
 FAIL  components/MessageList.dom.test.tsx > MessageList > drops the anchor
Error: Test timed out in 5000ms.

 Test Files  2 failed | 82 passed (84)
      Tests  3 failed | 9477 passed (9480)
`;

const CLEAN_RUN = `
 ✓ src/utils/env.test.ts (12 tests) 3ms

 Test Files  211 passed (211)
      Tests  9480 passed | 1 skipped (9481)
`;

describe('classifyRunOutput', () => {
  it('reads a green run that leaked an unhandled error', () => {
    const result = classifyRunOutput(GREEN_WITH_UNHANDLED_ERROR);

    expect(result.hasFailingTests).toBe(false);
    expect(result.unhandledBlocks).toHaveLength(1);
    expect(result.unhandledBlocks[0]).toContain('Error: write after end');
    expect(result.unhandledBlocks[0]).toContain('archive-safety.test.ts');
    expect(result.summaryLines.join('\n')).toContain('9480 passed');
  });

  it('reads an ordinary test failure', () => {
    const result = classifyRunOutput(ORDINARY_TEST_FAILURE);

    expect(result.hasFailingTests).toBe(true);
    expect(result.unhandledBlocks).toEqual([]);
  });

  it('reads a clean run', () => {
    const result = classifyRunOutput(CLEAN_RUN);

    expect(result.hasFailingTests).toBe(false);
    expect(result.unhandledBlocks).toEqual([]);
  });

  it('sees through the colour codes vitest writes on a TTY-less runner', () => {
    const coloured = ORDINARY_TEST_FAILURE.replace(
      ' FAIL ',
      '[41m[1m FAIL [22m[49m',
    );

    expect(classifyRunOutput(coloured).hasFailingTests).toBe(true);
  });

  it('keeps every unhandled block when a sharded run leaks more than once', () => {
    const result = classifyRunOutput(
      GREEN_WITH_UNHANDLED_ERROR +
        GREEN_WITH_UNHANDLED_ERROR.replace(
          'write after end',
          'premature close',
        ),
    );

    expect(result.unhandledBlocks).toHaveLength(2);
    expect(result.unhandledBlocks[1]).toContain('premature close');
  });

  it('bounds a runaway block instead of quoting the whole log', () => {
    const runaway = [
      '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      ...Array.from({ length: 500 }, (_, i) => `line ${i}`),
    ].join('\n');

    const [block] = classifyRunOutput(runaway).unhandledBlocks;
    expect(block).toContain('truncated at');
    expect(block.split('\n').length).toBeLessThan(70);
  });
});

describe('createRunClassifier', () => {
  // The run is classified as it streams, so the wrapper never holds a
  // multi-megabyte log in memory outside a process that already runs under a
  // heap cap. Chunk boundaries fall wherever the pipe puts them, so the
  // streamed reading has to match the whole-text one exactly.
  const feed = (text, chunkSize) => {
    const classifier = createRunClassifier();
    let pending = '';
    for (let at = 0; at < text.length; at += chunkSize) {
      pending = classifier.write(text.slice(at, at + chunkSize), pending);
    }
    return classifier.finish(pending);
  };

  it.each([1, 3, 7, 64, 4096])(
    'reads a chunked stream the same way at chunk size %i',
    (chunkSize) => {
      expect(feed(GREEN_WITH_UNHANDLED_ERROR, chunkSize)).toEqual(
        classifyRunOutput(GREEN_WITH_UNHANDLED_ERROR),
      );
      expect(feed(ORDINARY_TEST_FAILURE, chunkSize)).toEqual(
        classifyRunOutput(ORDINARY_TEST_FAILURE),
      );
    },
  );

  it('does not split a FAIL line that straddles two chunks', () => {
    const classifier = createRunClassifier();
    let pending = classifier.write(' FA', '');
    pending = classifier.write('IL  some.test.ts > a case\n', pending);
    expect(classifier.finish(pending).hasFailingTests).toBe(true);
  });

  it('keeps only the last few summary lines however many workspaces ran', () => {
    const classifier = createRunClassifier();
    let pending = '';
    for (let workspace = 0; workspace < 200; workspace += 1) {
      pending = classifier.write(
        `      Tests  ${workspace} passed (${workspace})\n`,
        pending,
      );
    }
    const { summaryLines } = classifier.finish(pending);
    expect(summaryLines.length).toBeLessThanOrEqual(4);
    expect(summaryLines.at(-1)).toContain('199 passed');
  });
});

describe('describeSilentFailure', () => {
  it('says nothing about a passing run', () => {
    expect(describeSilentFailure(classifyRunOutput(CLEAN_RUN), 0)).toBeNull();
  });

  it('says nothing when failing tests already explain the exit', () => {
    expect(
      describeSilentFailure(classifyRunOutput(ORDINARY_TEST_FAILURE), 1),
    ).toBeNull();
  });

  it('names the unhandled error when no test failed', () => {
    const report = describeSilentFailure(
      classifyRunOutput(GREEN_WITH_UNHANDLED_ERROR),
      1,
    );

    expect(report?.title).toBe('Workspace tests exited 1 with no failing test');
    expect(report?.body).toContain('Error: write after end');
    expect(report?.body).toContain('dangerouslyIgnoreUnhandledErrors');
  });

  it('falls back to the run tail when even the unhandled block is missing', () => {
    const report = describeSilentFailure(
      classifyRunOutput('building...\nnpm ERR! code ELIFECYCLE\n'),
      137,
    );

    expect(report?.title).toContain('exited 137');
    expect(report?.body).toContain('npm ERR! code ELIFECYCLE');
  });
});

describe('escapeAnnotation', () => {
  it('encodes the characters that would truncate a workflow command', () => {
    expect(escapeAnnotation('a\nb\rc%d')).toBe('a%0Ab%0Dc%25d');
  });
});

describe('runAndReport', () => {
  // scripts/tests/test-setup.ts mocks appendFileSync repo-wide so script tests
  // cannot append to a real GITHUB_STEP_SUMMARY, so the job summary is asserted
  // through the mock rather than through the filesystem.
  const summaryPath = path.join(os.tmpdir(), 'qwen-release-tests-summary.md');
  let stdout;
  let stderr;
  let stdoutText;
  let stderrText;

  beforeEach(() => {
    vi.mocked(appendFileSync).mockReset();
    stdoutText = '';
    stderrText = '';
    // Plain sinks rather than streams: a PassThrough delivers 'data'
    // asynchronously, so the annotation written last would not have landed by
    // the time the assertions run.
    stdout = {
      write: (chunk) => {
        stdoutText += chunk.toString();
        return true;
      },
    };
    stderr = {
      write: (chunk) => {
        stderrText += chunk.toString();
        return true;
      },
    };
  });

  /** Runs a fake suite that prints `output` and exits with `code`. */
  function fakeRun(output, code, summaryTarget = undefined) {
    return runAndReport({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write(${JSON.stringify(output)}); process.exit(${code});`,
      ],
      stdout,
      stderr,
      summaryPath: summaryTarget,
    });
  }

  it('annotates a run that exited non-zero with everything green', async () => {
    const exitCode = await fakeRun(GREEN_WITH_UNHANDLED_ERROR, 1, summaryPath);

    expect(exitCode).toBe(1);
    // The suite's own output still reaches the log untouched.
    expect(stdoutText).toContain('Test Files  211 passed');
    expect(stdoutText).toContain(
      '::error title=Workspace tests exited 1 with no failing test::',
    );
    expect(stdoutText).toContain('Error: write after end');
    // The annotation must survive as one workflow command.
    const annotation = stdoutText
      .split('\n')
      .find((line) => line.startsWith('::error '));
    expect(annotation).not.toContain('\r');
    expect(vi.mocked(appendFileSync)).toHaveBeenCalledWith(
      summaryPath,
      expect.stringContaining('Workspace tests exited 1 with no failing test'),
    );
  });

  it('stays quiet when tests failed', async () => {
    const exitCode = await fakeRun(ORDINARY_TEST_FAILURE, 1);

    expect(exitCode).toBe(1);
    expect(stdoutText).not.toContain('::error');
    expect(stderrText).toBe('');
  });

  it('stays quiet when the run passed', async () => {
    const exitCode = await fakeRun(CLEAN_RUN, 0);

    expect(exitCode).toBe(0);
    expect(stdoutText).not.toContain('::error');
  });

  it('reports an unwritable job summary without changing the exit code', async () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const exitCode = await fakeRun(GREEN_WITH_UNHANDLED_ERROR, 1, summaryPath);

    expect(exitCode).toBe(1);
    expect(stderrText).toContain('could not write the job summary');
    // The annotation the operator actually reads still went out.
    expect(stdoutText).toContain('::error title=');
  });
});
