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
    classifyChangedFiles(['packages/web-shell/package.json']),
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
  // A compound that names something else. `packages/web-shell/**` is one of
  // this repository's largest packages and a browser UI, not a shell: the
  // first spelling of this rule split on dashes anywhere in a segment and
  // summoned both expensive lanes on every change to it. A directory that IS
  // named for the subsystem still counts, wherever it sits.
  for (const [file, expected] of [
    ['packages/web-shell/client/App.tsx', PLATFORM_INSENSITIVE],
    ['packages/web-shell/client/index.html', PLATFORM_INSENSITIVE],
    ['packages/web-shell/client/components/shell/Term.tsx', PLATFORM_SENSITIVE],
    ['packages/cli/src/pty-host/index.ts', PLATFORM_SENSITIVE],
  ]) {
    assert.equal(classifyChangedFiles([file]), expected, file);
  }

  // The substring trap: these contain "shell", "pty", "os" or "platform"
  // inside a longer word and must NOT drag both lanes in.
  //
  // `Shellfish.tsx` is the one that pins the segment boundary itself: the
  // keyword is the HEAD of the stem, not buried mid-word, so a rule that
  // accepts a keyword prefix followed by anything would classify every
  // `Shell*.tsx` component as sensitive and summon both expensive lanes on
  // each change. The case above covers the sibling trap — `web-shell` as a
  // compound — which a different loosening breaks.
  for (const file of [
    'packages/core/src/utils/cryptic.ts',
    'packages/cli/src/ui/emptyState.ts',
    'packages/core/src/telemetry/uploader.ts',
    'packages/cli/src/services/plateauDetector.ts',
    'packages/web-shell/client/components/Shellfish.tsx',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_INSENSITIVE, file);
  }
});

test('native build workspaces are caught by the subsystem they name', () => {
  // packages/audio-capture is a node-gyp module compiled per-host on exactly
  // the two lanes this gate feeds: its native sources carry no shell
  // extension, `mac_permission` names `mac` and not the keyword `macos`, and
  // the workspace manifest is not the root one — so the subsystem rule is the
  // only net under it. The keyword names the workspace directory, so every
  // file below it counts.
  for (const file of [
    'packages/audio-capture/native/mac_permission.mm',
    'packages/audio-capture/native/audio_capture.cc',
    'packages/audio-capture/native/miniaudio.h',
    'packages/audio-capture/install.js',
    'packages/audio-capture/binding.gyp',
  ]) {
    assert.equal(classifyChangedFiles([file]), PLATFORM_SENSITIVE, file);
  }
  // The keyword names a subsystem, not a file extension: an ordinary `.cc`
  // elsewhere is still ordinary source.
  assert.equal(
    classifyChangedFiles(['packages/core/src/utils/parser.cc']),
    PLATFORM_INSENSITIVE,
  );
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

test('a CRLF listing does not smuggle a carriage return into a filename', () => {
  // The suffix rules are end-anchored, so a trailing `\r` defeats every one
  // of them and a script-layer change would classify as ordinary source. The
  // sibling classifier splits on /\r?\n/ for the same reason.
  const parsed = parseChangedFiles(
    '{"filename":"scripts/build.sh","status":"modified"}\r\n{"filename":"src/a.ts","status":"modified"}\r\n',
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].filename, 'scripts/build.sh');
  assert.equal(classifyChangedFiles(parsed), PLATFORM_SENSITIVE);
  // And the raw-line path, where the `\r` would land on the name itself.
  assert.equal(
    classifyChangedFiles(parseChangedFiles('scripts/build.sh\r\nsrc/a.ts\r\n')),
    PLATFORM_SENSITIVE,
  );
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
