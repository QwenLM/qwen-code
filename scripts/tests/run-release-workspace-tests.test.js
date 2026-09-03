/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeWorkflowCommand } from '../release-script-utils.js';
import {
  classifyRunOutput,
  createRunClassifier,
  createStreamConsumer,
  describeSilentFailure,
  isTransportTimeoutOnly,
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

// Trimmed from release run 33713579913, where this exact shape reddened
// v0.23.0 twice: 10,614 tests passed and Vitest's own worker RPC gave up.
const GREEN_WITH_TRANSPORT_TIMEOUT = `
 ✓ src/utils/env.test.ts (12 tests) 3ms
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../node_modules/vitest/dist/chunks/rpc.js:53:10
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  334 passed (334)
      Tests  10614 passed | 72 skipped (10686)
     Errors  1 error
`;

describe('classifyRunOutput', () => {
  it('reads a green run that leaked an unhandled error', () => {
    const result = classifyRunOutput(GREEN_WITH_UNHANDLED_ERROR);

    expect(result.hasFailingTests).toBe(false);
    expect(result.unhandledBlocks).toHaveLength(1);
    expect(result.unhandledBlocks[0]).toMatch(/^Unhandled Errors\n/);
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

describe('classifyRunOutput — what must not look like a failure', () => {
  it('does not read a passing test whose name contains FAIL as a failure', () => {
    // A set flag suppresses the annotation, so a false positive here silently
    // undoes the whole point of the script under an innocuous test name.
    const green = [
      ' ✓ src/ui/Banner.test.tsx (3 tests) 4ms',
      '   ✓ Banner > renders FAIL banner for an expired token',
      '      Tests  3 passed (3)',
    ].join('\n');
    expect(classifyRunOutput(green).hasFailingTests).toBe(false);
  });

  it('strips colour before reading a failed count', () => {
    // Discriminating on purpose: the count line only matches once the colour
    // codes are gone, so this goes red if the ANSI stripping is removed.
    const coloured =
      ' Test Files \u001b[31m2 failed\u001b[39m | 82 passed (84)';
    expect(classifyRunOutput(coloured).hasFailingTests).toBe(true);
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

  it('flushes a block that is still open when the stream ends', () => {
    // A kill or a truncated log can take the closing rule line with it; the
    // half-read block is still the best explanation of the exit, so finish()
    // has to hand it over rather than drop it.
    const truncated = GREEN_WITH_UNHANDLED_ERROR.slice(
      0,
      GREEN_WITH_UNHANDLED_ERROR.indexOf('Error: write after end') +
        'Error: write after end'.length,
    );
    const classifier = createRunClassifier();
    const pending = classifier.write(truncated, '');

    const { unhandledBlocks } = classifier.finish(pending);
    expect(unhandledBlocks).toHaveLength(1);
    expect(unhandledBlocks[0]).toMatch(/^Unhandled Errors\n/);
    expect(unhandledBlocks[0]).toContain('Error: write after end');
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

describe('createStreamConsumer', () => {
  it('reads a multi-byte rule character split across raw chunks', () => {
    // Cut inside the three bytes of the first ⎯ (U+23AF): decoding each raw
    // chunk on its own turns it into U+FFFD, the edge strip no longer
    // recognizes the opening rule line, and the block reaches the report
    // still wearing its rule runs.
    const bytes = Buffer.from(GREEN_WITH_UNHANDLED_ERROR, 'utf8');
    const cut = bytes.indexOf(Buffer.from('⎯', 'utf8')) + 1;
    const written = [];
    const sink = {
      write: (chunk) => {
        written.push(Buffer.from(chunk));
        return true;
      },
    };
    const consumer = createStreamConsumer(createRunClassifier());

    consumer.write(bytes.subarray(0, cut), sink, 'out');
    consumer.write(bytes.subarray(cut), sink, 'out');
    const result = consumer.finish();

    expect(result.unhandledBlocks).toHaveLength(1);
    expect(result.unhandledBlocks[0]).toMatch(/^Unhandled Errors\n/);
    expect(result.unhandledBlocks[0]).not.toContain('\uFFFD');
    // The passthrough stays byte-identical whatever the decoding did.
    expect(Buffer.concat(written).equals(bytes)).toBe(true);
  });

  it('counts a FAIL line that ends stderr without a trailing newline', () => {
    // A suite killed mid-line leaves its last stderr fragment unterminated;
    // that fragment can carry the run's only FAIL text, and dropping it
    // reports the failure as "no failing test".
    const sink = { write: () => true };
    const consumer = createStreamConsumer(createRunClassifier());

    consumer.write(
      Buffer.from(' FAIL x.test.ts > a case', 'utf8'),
      sink,
      'err',
    );

    expect(consumer.finish().hasFailingTests).toBe(true);
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

describe('annotation escaping', () => {
  // The wrapper writes its annotation through the shared workflow-command
  // escaper; this pins that the contract it relies on is the shared one.
  it('encodes the characters that would truncate a workflow command', () => {
    expect(escapeWorkflowCommand('a\nb\rc%d')).toBe('a%0Ab%0Dc%25d');
  });
});

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The stub is a POSIX shell script and the entry is spawned directly, so these
// stay on POSIX; Linux CI is the authoritative coverage for the release lane,
// which is Linux-only.
describe.skipIf(process.platform === 'win32')('CLI entry', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'release-wrapper-'));
  });

  /**
   * Copies the wrapper (and the utils it imports) beside each other under
   * `home`, puts a stub `npm` recording argv on PATH, and runs the wrapper the
   * way the workflow step does.
   */
  function runEntry(home, { exitCode = 0, output = '', entry } = {}) {
    mkdirSync(home, { recursive: true });
    for (const name of [
      'run-release-workspace-tests.js',
      'release-script-utils.js',
    ]) {
      copyFileSync(path.join(SCRIPTS_DIR, name), path.join(home, name));
    }
    const binDir = path.join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'npm');
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s\\0' "$@"\nprintf '%s' ${JSON.stringify(output)}\nexit ${exitCode}\n`,
    );
    chmodSync(stub, 0o755);

    return spawnSync(
      process.execPath,
      [
        entry ?? path.join(home, 'run-release-workspace-tests.js'),
        '--',
        '--shard=1/3',
        '--passWithNoTests',
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env['PATH']}`,
          GITHUB_STEP_SUMMARY: path.join(dir, 'step-summary.md'),
          // The spawned wrapper bypasses this process's appendFileSync mock,
          // so on GitHub Actions it would append its report to the running
          // job's real step summary. Redirect it to a scratch file instead,
          // which also turns that side effect into asserted coverage below.
        },
        encoding: 'utf8',
      },
    );
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns the suite and forwards its exit code', () => {
    const result = runEntry(path.join(dir, 'plain'), { exitCode: 7 });

    // Exactly one `--`, in the position npm needs it: the entry drops only
    // the separator npm itself consumed.
    expect(result.stdout.split('\0').slice(0, 5)).toEqual([
      'run',
      'test:release:workspaces',
      '--',
      '--shard=1/3',
      '--passWithNoTests',
    ]);
    expect(result.status).toBe(7);
  });

  it('still spawns the suite from a path containing a space', () => {
    // The guard used to compare import.meta.url against a hand-built
    // `file://` + argv[1]: false for any path with a space, and a false guard
    // means the wrapper exits 0 having run nothing at all.
    const result = runEntry(path.join(dir, 'spaced dir'), { exitCode: 3 });

    expect(result.stdout).toContain('test:release:workspaces');
    expect(result.status).toBe(3);
  });

  it('still spawns the suite when invoked through a symlink', () => {
    // path.resolve(argv[1]) keeps symlinks while Node realpath-resolves the
    // ESM entry module: compared as-is the guard is false for any symlinked
    // invocation — stock macOS, where os.tmpdir() links into /private/var,
    // is one — and the wrapper exits 0 having run nothing at all.
    const home = path.join(dir, 'linked');
    const link = path.join(dir, 'wrapper-link.js');
    symlinkSync(path.join(home, 'run-release-workspace-tests.js'), link);

    const result = runEntry(home, { exitCode: 3, entry: link });

    expect(result.stdout).toContain('test:release:workspaces');
    expect(result.status).toBe(3);
  });

  it('writes the silent-exit report to the redirected step summary', () => {
    const result = runEntry(path.join(dir, 'summarized'), { exitCode: 7 });

    expect(result.status).toBe(7);
    // The child writes through its real appendFileSync; the scratch file only
    // exists because runEntry redirected GITHUB_STEP_SUMMARY — drop that
    // redirect and this assertion goes red.
    expect(readFileSync(path.join(dir, 'step-summary.md'), 'utf8')).toContain(
      '### Workspace tests exited 7 with no failing test',
    );
  });

  it('does not spawn anything when the module is only imported', async () => {
    // The suite imports these functions; a guard that fired on import would
    // launch the whole release suite inside the test run.
    const home = path.join(dir, 'imported');
    mkdirSync(home, { recursive: true });
    for (const name of [
      'run-release-workspace-tests.js',
      'release-script-utils.js',
    ]) {
      copyFileSync(path.join(SCRIPTS_DIR, name), path.join(home, name));
    }
    const probe = path.join(home, 'probe.mjs');
    writeFileSync(
      probe,
      "import './run-release-workspace-tests.js';\nprocess.stdout.write('imported');\n",
    );
    const binDir = path.join(dir, 'bin-import');
    mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'npm');
    writeFileSync(stub, '#!/bin/sh\nprintf spawned\n');
    chmodSync(stub, 0o755);

    const result = spawnSync(process.execPath, [probe], {
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH']}` },
      encoding: 'utf8',
    });

    expect(result.stdout).toBe('imported');
    expect(result.stdout).not.toContain('spawned');
  });
});

describe('isTransportTimeoutOnly', () => {
  it('recognises Vitest giving up on its own worker RPC', () => {
    const { unhandledBlocks } = classifyRunOutput(GREEN_WITH_TRANSPORT_TIMEOUT);
    expect(isTransportTimeoutOnly(unhandledBlocks)).toBe(true);
  });

  it('does not excuse a product error', () => {
    // #10842's Session.ts rejection is the class that MUST keep failing the
    // run: every test green, one unhandled rejection, exit 1.
    const { unhandledBlocks } = classifyRunOutput(GREEN_WITH_UNHANDLED_ERROR);
    expect(isTransportTimeoutOnly(unhandledBlocks)).toBe(false);
  });

  it('does not excuse a run that leaked both', () => {
    const both = `${GREEN_WITH_TRANSPORT_TIMEOUT}\n${GREEN_WITH_UNHANDLED_ERROR}`;
    const { unhandledBlocks } = classifyRunOutput(both);
    expect(isTransportTimeoutOnly(unhandledBlocks)).toBe(false);
  });

  it('is false with nothing to judge', () => {
    // The "Vitest caught N unhandled error" preamble carries no `Error:` line;
    // an absence of evidence must not read as a transport timeout.
    expect(isTransportTimeoutOnly([])).toBe(false);
    expect(
      isTransportTimeoutOnly(['Unhandled Errors', 'Vitest caught 1']),
    ).toBe(false);
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

  /** Runs a fake suite that prints `output` to `stream` and exits `code`. */
  function fakeRun(output, code, summaryTarget = undefined, stream = 'stdout') {
    return runAndReport({
      command: process.execPath,
      args: [
        '-e',
        `process.${stream}.write(${JSON.stringify(output)}); process.exit(${code});`,
      ],
      stdout,
      stderr,
      summaryPath: summaryTarget,
    });
  }

  it('passes a run whose only unhandled error is the transport timing out', async () => {
    // Release run 33713579913 died twice on this and shipped nothing, while
    // `--retry` could not help: retries re-run failing TESTS, and an unhandled
    // error fails the run outright.
    const exitCode = await fakeRun(
      GREEN_WITH_TRANSPORT_TIMEOUT,
      1,
      summaryPath,
    );

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain(
      '::warning title=Workspace tests exited 1 on a Vitest transport timeout::',
    );
    // The evidence still reaches the log; this reports, it does not hide.
    expect(stdoutText).toContain('Timeout calling');
    expect(stdoutText).toContain('Tests  10614 passed');
    expect(vi.mocked(appendFileSync)).toHaveBeenCalled();
  });

  it("still fails a run whose unhandled error is the product's", async () => {
    const exitCode = await fakeRun(GREEN_WITH_UNHANDLED_ERROR, 1, summaryPath);
    expect(exitCode).toBe(1);
    expect(stdoutText).toContain('::error title=');
  });

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

  it('treats a signal-killed suite as a failure, not a pass', async () => {
    // A vitest process OOM-killed on the release lane closes with code null.
    // Reading that as 0 would ship a release on tests that never finished.
    const exitCode = await runAndReport({
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGKILL");'],
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
  });

  it('stays quiet when tests failed', async () => {
    const exitCode = await fakeRun(ORDINARY_TEST_FAILURE, 1);

    expect(exitCode).toBe(1);
    expect(stdoutText).not.toContain('::error');
    expect(stderrText).toBe('');
  });

  it('stays quiet when the FAIL line only reached stderr', async () => {
    // Vitest prints its report on stdout, but a failure line that lands on
    // stderr still has to suppress the annotation — otherwise the wrapper
    // reports a silent failure over a log whose failing tests are right
    // there.
    const exitCode = await fakeRun(
      ORDINARY_TEST_FAILURE,
      1,
      undefined,
      'stderr',
    );

    expect(exitCode).toBe(1);
    expect(stdoutText).not.toContain('::error');
    // The stderr passthrough still delivered the suite's words untouched.
    expect(stderrText).toContain('FAIL  components/MessageList.dom.test.tsx');
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
