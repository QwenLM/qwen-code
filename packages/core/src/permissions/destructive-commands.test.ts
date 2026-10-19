/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isDestructiveCommand,
  registerSessionCommit,
  clearSessionCommits,
} from './destructive-commands.js';

beforeEach(() => {
  clearSessionCommits();
});

const UNVERIFIABLE = 'could not verify';

async function reasonFor(command: string, cwd?: string) {
  const result = await isDestructiveCommand(command, cwd);
  if (result) expect(result.blocked).toBe(true);
  return result?.reason ?? null;
}

describe('isDestructiveCommand — text that is not executed', () => {
  it.each([
    `printf '%s\\n' 'git reset --hard'`,
    'printf ok # git reset --hard',
    `echo 'git reset --hard'`,
    'echo git reset --hard',
    `grep -rn 'terraform destroy' docs`,
    `rg 'git stash drop'`,
    `grep -rn 'git reset --hard' . || true`,
    // Search patterns and file names are data, not a wrapped command.
    'grep -e git -e reset -e --hard notes.txt',
    'rg -e git -e reset -e --hard notes.txt',
    `rg --regexp '--pre' 'git reset --hard'`,
    `rg -ne '--pre' 'git reset --hard'`,
    `rg -efizz 'git reset --hard'`,
    `rg --pre-glob '--pre' 'git reset --hard'`,
    `rg -- --pre 'git reset --hard'`,
    `rg -- 'git reset --hard' *.md`,
    `rg --pre= 'git reset --hard'`,
    `rg --pre bash --no-pre 'git reset --hard'`,
    `cat .git/config && echo 'git reset --hard'`,
    `cat < .git/HEAD && echo 'git reset --hard'`,
    `rg 'git reset --hard' .git/config`,
    `path=notes.txt; rg 'git -C /repo reset --hard' "$path"`,
    `rg 'git checkout -- .' . src`,
    `git commit -m 'docs: explain git reset --hard'`,
    `git log --grep 'git checkout -- .'`,
    `cat <<'EOF' > notes.md\ngit reset --hard\nEOF`,
    `NOTE='git clean -fd' && echo "$NOTE"`,
    `[ "$x" = 'terraform destroy' ]`,
  ])('allows %j', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — executed git and IaC operations', () => {
  it.each<[string, string]>([
    ['git reset --hard', 'git reset --hard'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    // Git accepts any unambiguous prefix of a long option.
    ['git reset --har', 'git reset --hard'],
    ['git -C /repo reset --hard', 'git reset --hard'],
    ['git -C /a -C b -c core.pager=less reset --hard', 'git reset --hard'],
    ['git -c advice.detachedHead=false reset --hard', 'git reset --hard'],
    ['git --git-dir=/x/.git --work-tree=/x reset --hard', 'git reset --hard'],
    ['git checkout -- .', 'git checkout -- .'],
    ['git checkout .', 'git checkout -- .'],
    ['git checkout HEAD -- ./', 'git checkout -- .'],
    ['git checkout -q -- ../..', 'git checkout -- .'],
    ['git clean -fd', 'git clean -f'],
    ['git clean -d -f', 'git clean -f'],
    ['git clean -xdf', 'git clean -f'],
    ['git clean --force', 'git clean -f'],
    ['git stash drop', 'git stash drop'],
    ['git stash drop stash@{1}', 'git stash drop'],
    // Options may come before the action.
    ['git stash -q drop', 'git stash drop'],
    ['git stash --quiet drop', 'git stash drop'],
    // `-f` throws away local changes whatever it checks out.
    ['git checkout -f', 'git checkout -f'],
    ['git checkout --force main', 'git checkout -f'],
    // These resolve to the top of the tree.
    ['git checkout -- src/..', 'git checkout -- .'],
    ['git.exe reset --hard', 'git reset --hard'],
    ['/usr/bin/git reset --hard', 'git reset --hard'],
    ['terraform destroy', 'terraform destroy'],
    ['terraform -chdir=infra destroy -auto-approve', 'terraform destroy'],
    ['pulumi -C infra destroy --yes', 'pulumi destroy'],
    ['cdk --profile prod destroy MyStack', 'cdk destroy'],
    ['npx cdk destroy', 'cdk destroy'],
  ])('blocks %j as %s', async (command, label) => {
    expect(await reasonFor(command)).toContain(`"${label}"`);
  });

  it('names destructive git and infrastructure commands differently', async () => {
    expect(await reasonFor('git stash drop')).toBe(
      'Blocked destructive git command: "git stash drop".',
    );
    expect(await reasonFor('cdk destroy')).toBe(
      'Blocked infrastructure destroy command: "cdk destroy".',
    );
  });

  it.each([
    'git status',
    'git reset --soft HEAD~1',
    'git reset HEAD~1',
    'git checkout feature-branch',
    // A single file or directory is not the whole tree.
    'git checkout -- ./src',
    'git checkout .gitignore',
    // Reflog selectors are not brace expansions.
    'git checkout HEAD@{1} -- src',
    `git 'rese{t..t}' --hard`,
    `git re"se{t..t}" --hard`,
    String.raw`git rese\{t..t\} --hard`,
    `'./g*t' reset --hard`,
    String.raw`./g\*t reset --hard`,
    // `-b` consumes `.x` as the new branch name.
    'git checkout -b .x',
    // A dry run wins over --force and deletes nothing.
    'git clean -n -f',
    'git clean --dry-run -fd',
    // `-e` consumes `-f` as its exclude pattern.
    'git clean -e -f',
    'git stash',
    'git stash pop',
    'git stash list',
    // The message value is not an option.
    'git commit -m --amend',
    // A prefix of a value option takes the next word as its value.
    'git commit --mes --amend',
    'git clean --ex -f',
    'git commit -m "fix" -- ./',
    'git -C /repo reset -- --hard',
    'terraform plan -out destroy',
    'terraform apply',
    'pulumi stack rm destroy',
    'cdk deploy',
    'npm install',
    'command -v git',
    'git.exe status',
    // `--orphan` takes `.` as the new branch name.
    'git checkout --orphan .',
  ])('allows %j', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — wrappers and shell structure', () => {
  it.each([
    `bash -c 'git reset --hard'`,
    `bash -o pipefail -c 'git reset --hard'`,
    `sh -lc "git -C /repo reset --hard"`,
    `sh -c "bash -c 'git reset --hard'"`,
    `env FOO=1 git reset --hard`,
    `command git reset --hard`,
    `sudo -u build git reset --hard`,
    `timeout 30 git reset --hard`,
    `xargs git reset --hard`,
    `git status && git reset --hard`,
    `git status\ngit reset --hard`,
    `git reset --hard 2>/dev/null | tail -1`,
    `(git reset --hard)`,
    `f() { git reset --hard; }`,
    `if true; then git reset --hard; fi`,
    `echo "$(git reset --hard)"`,
    'echo `git reset --hard`',
    `cat <<EOF\n$(git reset --hard)\nEOF`,
    `bash <<'EOF'\ngit reset --hard\nEOF`,
    `bash <<< 'git reset --hard'`,
    `eval "git reset --hard"`,
    `git -c alias.x=status submodule foreach 'git reset --hard'`,
    // Wrappers that run a command line.
    `env -S 'git reset --hard'`,
    `env --split-string='git reset --hard'`,
    `flock /tmp/lock -c 'git reset --hard'`,
    `su -c 'git reset --hard' build`,
    `watch -n 5 git reset --hard`,
    `cmd /c "git reset --hard"`,
    `powershell -Command "git reset --hard"`,
    `pwsh -Command 'git reset --hard'`,
    // Every shell the guard knows, so none can drop off the list unnoticed.
    `zsh -c 'git reset --hard'`,
    `dash -c 'git reset --hard'`,
    `ksh -c 'git reset --hard'`,
    `fish -c 'git reset --hard'`,
    `ash -c 'git reset --hard'`,
    `mksh -c 'git reset --hard'`,
    `csh -c 'git reset --hard'`,
    `tcsh -c 'git reset --hard'`,
    // Git runs these option values as commands.
    `git rebase --exec 'git reset --hard' main`,
    `git rebase --exec='git reset --hard' main`,
    `git rebase -i -x 'git reset --hard' main`,
    `git difftool -y -x 'git reset --hard #' HEAD~1`,
    `bash -c 'git difftool -y --extcmd="git reset --hard #" HEAD~1'`,
    // A heredoc attached to the group the shell sits in.
    `{ bash; } <<'EOF'\ngit reset --hard\nEOF`,
    `g"it" reset --hard`,
    'g\\it reset --hard',
  ])('blocks %j', async (command) => {
    expect(await reasonFor(command)).toContain('"git reset --hard"');
  });

  it('does not treat a wrapper option value as the program', async () => {
    expect(await reasonFor('bash -o pipefail -c "git status"')).toBeNull();
    expect(await reasonFor('timeout 30 npm test')).toBeNull();
  });
});

describe('isDestructiveCommand — commands it cannot verify', () => {
  it.each([
    // The program, its arguments or the script only exist at run time.
    '$GIT reset --hard',
    'git reset $MODE',
    'git checkout "$TARGET"',
    // Brace expansion yields `.` among other words.
    'git checkout {.,src}',
    'git rese{t..t} --hard',
    'git clea{n..n} -fd',
    'terraform destro{y..y}',
    './g*t reset --hard',
    './g?t reset --hard',
    './g[i]t reset --hard',
    'gi{t..t} rese{t..t} --hard',
    './g*t rese{t..t} --hard',
    'gi{t..t} re""se{t..t} --hard',
    'SUFFIX=set; gi{t..t} re$SUFFIX --hard',
    'ACTION=reset; ./g*t $ACTION --hard',
    'ACTION=reset; gi{t..t} $ACTION --hard',
    `TOOL=git; ARGS='reset --hard'; $TOOL $ARGS`,
    `printf 'git reset --hard\\n' > fix.sh && ba{s..s}h fix.sh`,
    'git stash "$ACTION"',
    'terraform "$COMMAND"',
    `bash -c "git reset $MODE"`,
    `echo 'git reset --hard' | bash`,
    `git -c alias.nuke='!git reset --hard' nuke`,
    // An unquoted expansion may split into several words.
    `X='msg --amend'; git commit -m $X`,
    'git checkout feature/$X',
    `X='. reset --hard'; git -C $X status`,
    // xargs appends what it reads; find and xargs fill in `{}`.
    `printf -- '--hard\\n' | xargs git -C /repo reset`,
    'echo reset --hard | xargs git -C /repo',
    'find . -maxdepth 0 -exec git checkout {} \\;',
    `X='git reset --hard'; $X`,
    `echo 'git reset --hard' | xargs -I{} sh -c '{}'`,
    // A script the same command writes and then runs.
    `printf 'git reset --hard\\n' > fixup.sh && bash fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg --pre bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg --pre=bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg --pr{e..e} bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg --glob {x,--pre} bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg -ng {x,--pre} bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && rg --max-columns-preview --pre bash . fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && . ./fixup.sh`,
    `cat > fix.sh <<'EOF'\ngit stash drop\nEOF\nchmod +x fix.sh && ./fix.sh`,
    `printf 'git clean -fd\\n' | tee fix.sh > /dev/null && sh ./fix.sh`,
    `printf 'git clean -fd\\n' | sudo tee fix.sh && command . ./fix.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && bash < fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && cat fixup.sh | bash`,
    `printf 'git reset --hard\\n' > fixup.sh && bash "$PWD/fixup.sh"`,
    `printf '#!/bin/sh\\ngit reset --hard\\n' > fixup.sh && ./fixup.sh`,
    `printf 'git reset --hard\\n' > a.sh && cp a.sh fixup.sh && bash fixup.sh`,
    `printf 'git reset --hard\\n' > "$PWD/fixup.sh" && bash fixup.sh`,
    `printf '\\x67it reset --hard\\n' > fixup.sh && bash fixup.sh`,
    `printf 'git reset --hard\\n' > fixup.sh && eval "$(cat fixup.sh)"`,
    `bash -c "printf 'git reset --hard' > f; bash f"`,
    `printf 'git reset --hard\\n' > f && git -c alias.x='!sh f' x`,
    `printf 'git reset --hard\\n' > f.sh && chmod +x f.sh && timeout 60 ./f.sh`,
    `bash <(echo 'git reset --hard')`,
    `source <(printf 'git reset --hard\\n')`,
    // Git prints what it is given: a commit message, a log format.
    `git commit -q --allow-empty -m 'git reset --hard' && git log -1 --format=%s | bash`,
    `git log -1 --format='git stash drop' | sh`,
    // Code handed to another interpreter.
    `python3 -c "import os; os.system('git reset --hard')"`,
    `node -e "require('child_process').execSync('git clean -fd')"`,
    `python3 <<'EOF'\nimport os\nos.system('git stash drop')\nEOF`,
    `echo "import os; os.system('git reset --hard')" | python3`,
    `printf 'import os\\nos.system("git reset --hard")\\n' > f.py && python3 f.py`,
    `awk 'BEGIN { system("git reset --hard") }'`,
    // Pathname patterns, magic and run-time pathspecs may name the whole
    // tree; a split global option value can add any subcommand.
    'git checkout *',
    'git checkout -- *',
    `git checkout -- '*'`,
    'git checkout :/',
    'git checkout -- "feature/$X"',
    'git checkout "feature/$X"',
    'git checkout --pathspec-from-file=paths.txt',
    'git -C $DIR status',
    'git -C $(cat .repo-dir) status',
    // Escapes printf decodes, and ones a shell drops.
    `printf '\\U00000067it reset --hard\\n' > fixup.sh && bash fixup.sh`,
    `printf '\\U00000067it reset --hard' | bash`,
    `printf '\\g\\x69t reset --hard' | bash`,
    // Code run later or elsewhere: a trap, a startup file, a script file.
    `trap 'git reset --hard' EXIT`,
    `printf 'git reset --hard\\n' > f.sh; BASH_ENV=$PWD/f.sh bash -c :`,
    `printf 'git reset --hard\\n' > f.sh; bash --rcfile ./f.sh -i -c :`,
    `pwsh -File fix.ps1; echo 'git reset --hard'`,
    `lua -e 'os.execute("git reset --hard")'`,
    `osascript -e 'do shell script "git clean -fd"'`,
    `deno eval 'Deno.run({ cmd: ["git", "reset", "--hard"] })'`,
    `printf 'git.exe reset --hard\\n' > f.sh && bash f.sh`,
    // A run-time command for git to run.
    'git bisect run "$W" reset --hard',
    'git rebase --exec "$CMD" main',
    // Aliases and settings that run a protected operation.
    `git config alias.r 'reset --hard'; git r`,
    `printf '[alias]\\nnuke = !git reset --hard\\n' >> .git/config && git nuke`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='!git reset --hard' git nuke`,
    // xargs appends what it reads behind a wrapper too.
    'sudo xargs git checkout',
    'env xargs git checkout',
    'echo . | sudo xargs git checkout',
    // A shell reading a pipe from inside a group.
    `echo 'git reset --hard' | (bash)`,
    `echo 'git reset --hard' | { bash; }`,
    // Backquotes nested inside backquotes.
    'echo `echo \\`git reset --hard\\``',
    // The parser cannot read these.
    `case "$1" in x) git reset --hard ;; esac`,
    `case x in a) eval "$(printf '\\g\\x69t reset --hard')" ;; esac`,
    `echo 'git reset --hard`,
  ])('blocks %j', async (command) => {
    expect(await reasonFor(command)).toContain(UNVERIFIABLE);
  });

  it.each([
    'echo $HOME',
    '$EDITOR notes.md',
    '$EDITOR "$FILE"',
    '$EDITOR $FILE',
    'TOOL=printf; TEXT=hello; $TOOL $TEXT',
    'TOOL=printf; TEXT=hello; $TOOL "$TEXT"',
    `bash -c 'TOOL=printf; TEXT=hello; $TOOL $TEXT'`,
    `bash -c 'TOOL=printf; TEXT=hello; $TOOL "$TEXT"'`,
    'TOOL=printf; TEXT=hello; env $TOOL ${TEXT}',
    'TOOL=printf; $TOOL $(printf hello)',
    './tool{1,2} --version',
    `case "$1" in x) npm test ;; esac`,
    `echo 'npm test' | bash`,
    // The shell reads its program from the here-string, not from the pipe.
    `bash <<< 'git status' | cat`,
    'git commit -m "$(cat msg.txt)"',
    'git commit --message="$MSG"',
    'git checkout -b "feature/$NAME"',
    'git reset --soft "HEAD~$N"',
    // After `--` a run-time word can only be a pathspec.
    'f=app.txt; git reset -q -- "$f"',
    `f=app.txt; git commit -q -m 'update' -- "$f"`,
    'git -C "$DIR" status',
    'git ls-files -m | xargs git add',
    `cat > t.sh <<'EOF'\nnpm test\nEOF\nbash t.sh && git commit -m done`,
    'bash scripts/test.sh && git commit -m done',
    'bash "$SCRIPT" && git commit -m done',
    `python3 -c 'print(1)' && git commit -m done`,
    'python3 manage.py migrate',
    'git stash list | python3 parse.py',
    `cat notes.txt | bash -c 'wc -l'`,
    `awk '{print $1}' app.txt`,
    `printf 'echo hello\\n' > hello.sh && bash < hello.sh`,
    // A commit is only protected when amended.
    `printf 'echo "remember to run git commit"\\n' > note.sh && bash note.sh`,
    `python3 -c "import subprocess; print(subprocess.run(['git', 'status']).returncode or 'nothing to commit')"`,
    // Commands checked word for word and comments are not hidden code.
    './scripts/build.sh && git checkout main',
    `timeout 300 bash -c 'npm ci && ./scripts/test.sh && git checkout -- package-lock.json'`,
    './scripts/test.sh # then git reset --hard if it fails',
    // Settings and commands that cannot run anything.
    "git -c commit.gpgsign=false commit -m 'docs: explain git reset --hard'",
    './scripts/build.sh && sudo git checkout main',
    "trap 'npm test' EXIT",
    "git config --get-regexp '^alias\\.'",
    'git nuke',
    // File names are not words.
    `printf 'echo cleaning\\n' > git-clean-branches.sh && bash git-clean-branches.sh`,
    'bash ./scripts/git-reset-hooks.sh .git/hooks',
  ])('allows %j, which cannot reach a protected operation', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — limits', () => {
  /** `X=git` outside, `$X reset --hard` inside `depth` nested shells. */
  function nested(depth: number): string {
    let script = '$X reset --hard';
    for (let level = depth; level > 0; level--) {
      script = `bash <<'E${level}'\n${script}\nE${level}`;
    }
    return `export X=git\n${script}`;
  }

  it.each([2, 4, 5, 7])(
    'blocks a run-time program %i shells deep',
    async (depth) => {
      expect(await reasonFor(nested(depth))).toContain(UNVERIFIABLE);
    },
  );

  it('reads a long run of slashes in a pathspec quickly', async () => {
    await reasonFor('git status');
    const started = performance.now();
    expect(await reasonFor(`git checkout .${'/'.repeat(60)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('blocks when the parser rejects the command', async () => {
    // The parser throws on `case`; the payload's spelling defeats the
    // program-name test, so only the operation's name is left to go on.
    expect(
      await reasonFor(
        `case x in a) eval "$(printf '\\147\\151\\164 reset --hard')" ;; esac`,
      ),
    ).toContain(UNVERIFIABLE);
    expect(await reasonFor(`case "$1" in x) npm test ;; esac`)).toBeNull();
  });
});

describe('isDestructiveCommand — git commit --amend', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A repo with one commit; registers that commit when `own` is set. */
  function makeRepo(parent: string, name: string, own: boolean): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
    git('init', '-q');
    // Independent of the host's git config: no signing, no hooks.
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--no-verify',
      '--allow-empty',
      '-m',
      name,
    );
    if (own) registerSessionCommit(git('rev-parse', 'HEAD'));
    return dir;
  }

  function makeRepos() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-guard-'));
    tmpDirs.push(root);
    return {
      root,
      own: makeRepo(root, 'own', true),
      other: makeRepo(root, 'other', false),
    };
  }

  it('allows amending a commit the agent made in this session', async () => {
    const { own } = makeRepos();
    expect(await reasonFor('git commit --amend --no-edit', own)).toBeNull();
    expect(
      await reasonFor(`bash -c 'git commit -m "msg" --amend'`, own),
    ).toBeNull();
    // Only a setting's value can run a command, not its name.
    expect(
      await reasonFor('git -c commit.gpgsign=false commit --amend', own),
    ).toBeNull();
  });

  it('resolves git -C against the command directory', async () => {
    const { root, own, other } = makeRepos();
    expect(await reasonFor('git -C own commit --amend', root)).toBeNull();
    expect(
      await reasonFor(`git -C ${other} commit --amend --no-edit`, own),
    ).toContain('git commit --amend');
  });

  it.each([
    'cat .git/HEAD',
    'cat < .git/HEAD',
    'head -n 1 .git/HEAD',
    'rg ref .git/HEAD',
    'sort .git/HEAD',
    'sort --"rev"erse .git/HEAD',
    'uniq .git/HEAD',
    'uniq -""f 1 .git/HEAD',
    'ls .git/HEAD',
  ])('allows a session amend after reading metadata with %s', async (read) => {
    const { own } = makeRepos();
    expect(
      await reasonFor(`${read} && git commit --amend --no-edit`, own),
    ).toBeNull();
  });

  it.each([
    'cat other-head > .git/HEAD',
    'cat other-head >> .git/HEAD',
    'cat other-head >| .git/HEAD',
    'cat other-head <> .git/HEAD',
    'sort other-head -o .git/HEAD',
    'sort --"output" .git/HEAD other-head',
    String.raw`sort \-o .git/HEAD other-head`,
    String.raw`sort $'\055o' .git/HEAD other-head`,
    'uniq other-head .git/HEAD',
    'cp other-head .git/HEAD',
  ])(
    'blocks a session amend after changing metadata with %s',
    async (write) => {
      const { own } = makeRepos();
      expect(
        await reasonFor(`${write} && git commit --amend --no-edit`, own),
      ).not.toBeNull();
    },
  );

  it.each([
    [
      'another repository',
      (dirs: Repos) => `git -C ${dirs.other} commit --amend`,
    ],
    [
      'a directory change',
      (dirs: Repos) => `cd ${dirs.own} && git commit --amend`,
    ],
    [
      'a repository variable',
      (dirs: Repos) => `GIT_DIR=${dirs.other}/.git git commit --amend`,
    ],
    ['a wrapper', () => 'env git commit --amend'],
    ['a run-time directory', () => 'git -C "$REPO" commit --amend'],
    ['an option with unknown effect', () => 'git --bare commit --amend'],
    [
      'a commit made earlier on the same line',
      () => 'git commit --allow-empty -m x && git commit --amend --no-edit',
    ],
    [
      'a replaced .git',
      (dirs: Repos) =>
        `rm -rf .git && ln -s ${dirs.other}/.git .git && git commit --amend`,
    ],
    [
      'an editor variable',
      () => "GIT_EDITOR='git reset --hard' git commit --amend",
    ],
  ])('blocks an amend whose target goes through %s', async (_label, build) => {
    const dirs = makeRepos();
    expect(await reasonFor(build(dirs), dirs.own)).toContain(
      'could not be verified as one the agent made in this session',
    );
  });

  it('never falls back to the process directory', async () => {
    // The session commit is the HEAD of the directory the process runs in;
    // without a cwd the guard must not read it.
    const { own } = makeRepos();
    const cwd = process.cwd();
    process.chdir(own);
    try {
      expect(await reasonFor('git commit --amend')).toContain(
        'git commit --amend',
      );
    } finally {
      process.chdir(cwd);
    }
  });
});

type Repos = { root: string; own: string; other: string };
