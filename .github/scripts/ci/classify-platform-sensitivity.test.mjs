import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLATFORM_INSENSITIVE,
  PLATFORM_SENSITIVE,
  classifyChangedFiles,
  parseChangedFiles,
} from './classify-platform-sensitivity.mjs';

test('an ordinary source change does not summon the expensive lanes', () => {
  // The whole point of a gate: the common pull request pays nothing. If this
  // ever flips, the lanes are back on every PR and the cost that moved them
  // off is back with them.
  assert.equal(
    classifyChangedFiles([
      'packages/cli/src/ui/components/Header.tsx',
      'packages/core/src/prompts/system.ts',
      'docs/users/configuration.md',
    ]),
    PLATFORM_INSENSITIVE,
  );
});

test('shell scripts pull in the lanes, on every dialect', () => {
  for (const file of [
    'scripts/build.sh',
    'tools/release.bash',
    'installer/setup.ps1',
    'ci/run.bat',
    'ci/run.cmd',
    'deep/nested/dir/helper.SH',
    'tools/setup.zsh',
  ]) {
    assert.equal(
      classifyChangedFiles([`packages/core/src/x.ts`, file]),
      PLATFORM_SENSITIVE,
      file,
    );
  }
});

test('CI definitions and the scripts they call are shell too', () => {
  // The failure this gate exists for lived in a workflow's `run:` block and
  // in the suite that drove it: `realpath -m` is GNU-only, so the guard it
  // canonicalized with silently did nothing on macOS.
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/actions/configure-windows-runner/action.yml',
    '.github/scripts/ci/classify-profile.mjs',
    'scripts/tests/qwen-pr-review-workflow.test.js',
    'scripts/version.js',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_SENSITIVE, file);
  }
});

test('the runner configuration decides which lane runs what', () => {
  // An exclusion keyed on process.platform is how a suite ends up unrun on
  // one host and red on another; a change to it must be seen by both lanes.
  for (const file of [
    'vitest.config.ts',
    'scripts/tests/vitest.config.ts',
    'vitest.terminal-bench.config.ts',
    'packages/cli/vitest.config.mts',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_SENSITIVE, file);
  }
  // Not every config is the runner's.
  assert.equal(
    classifyChangedFiles(['packages/cli/eslint.config.js']),
    PLATFORM_INSENSITIVE,
  );
});

test('the manifests change what each lane executes', () => {
  assert.equal(classifyChangedFiles(['package.json']), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles(['package-lock.json']), PLATFORM_SENSITIVE);
  // A workspace manifest is not the root one; it reaches the lanes through
  // the subsystem rules or not at all.
  assert.equal(
    classifyChangedFiles(['packages/webui/package.json']),
    PLATFORM_INSENSITIVE,
  );
});

test('platform-coupled subsystems match on segments, not substrings', () => {
  for (const file of [
    'packages/core/src/sandbox/index.ts',
    'packages/cli/src/ui/pty-host.ts',
    'packages/cli/src/utils/clipboard.ts',
    'packages/core/src/tools/shell.ts',
    'packages/cli/src/platform/paths.ts',
    'packages/cli/src/utils/win32.ts',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_SENSITIVE, file);
  }
  // The substring trap: these contain "shell", "pty", "os" or "platform"
  // inside a longer word and must NOT drag both lanes in.
  for (const file of [
    'packages/webui/src/components/Shellfish.tsx',
    'packages/core/src/utils/cryptic.ts',
    'packages/cli/src/ui/emptyState.ts',
    'packages/core/src/telemetry/uploader.ts',
    'packages/cli/src/services/plateauDetector.ts',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_INSENSITIVE, file);
  }
});

test('a rename is judged on both of its names', () => {
  // A script moved out of the script layer is still a script change on the
  // lane that used to run it — and one moved in is a new one to run.
  assert.equal(
    classifyChangedFiles([
      {
        filename: 'tools/build.mjs',
        status: 'renamed',
        previous_filename: 'scripts/build.mjs',
      },
    ]),
    PLATFORM_SENSITIVE,
  );
  assert.equal(
    classifyChangedFiles([
      {
        filename: 'scripts/build.mjs',
        status: 'renamed',
        previous_filename: 'tools/build.mjs',
      },
    ]),
    PLATFORM_SENSITIVE,
  );
  assert.equal(
    classifyChangedFiles([
      {
        filename: 'src/b.ts',
        status: 'renamed',
        previous_filename: 'src/a.ts',
      },
    ]),
    PLATFORM_INSENSITIVE,
  );
});

test('every unknown answers sensitive, never insensitive', () => {
  // A gate that fails open silently stops testing. Each of these is a way the
  // input can arrive broken, and each one must still run the lanes.
  assert.equal(classifyChangedFiles([]), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles(null), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles(undefined), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles('scripts/x.sh'), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles([{ status: 'added' }]), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles([null]), PLATFORM_SENSITIVE);
  assert.equal(classifyChangedFiles([{ filename: '' }]), PLATFORM_SENSITIVE);
});

test('parses the wrapper JSONL contract, and survives a non-JSON line', () => {
  const parsed = parseChangedFiles(
    [
      '{"filename":"src/a.ts","status":"modified","previous_filename":null}',
      '',
      'scripts/raw-line.sh',
    ].join('\n'),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].filename, 'src/a.ts');
  assert.equal(parsed[1], 'scripts/raw-line.sh');
  assert.equal(classifyChangedFiles(parsed), PLATFORM_SENSITIVE);
});

test('windows path separators classify the same as posix ones', () => {
  // The listing is API-shaped and uses forward slashes, but a caller feeding
  // this from a local `git diff` on Windows must not silently classify a
  // script layer change as ordinary source.
  assert.equal(
    classifyChangedFiles(['scripts\\tests\\install-script.test.js']),
    PLATFORM_SENSITIVE,
  );
});
