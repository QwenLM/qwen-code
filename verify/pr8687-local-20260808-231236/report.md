# PR 8687 Verification Report — `feat(daemon): guard cross-worktree Git mutations`

## Verdict

**findings** — the central claim is proven by A/B, with one concrete finding on the
read-only allowlist and one documented fail-closed edge. Scripted assertions:
**142 pass / 2 fail / 144 total** (the two fails are one root cause, see F1).

Verified head: `b11585bc62ca01ed22309f30cef3b3d26394a414` (current PR head; the PR
advanced while this round ran — see the delta section for the earlier head
`7f66be62`). Base: `845d6cf77e60a04b3e5c4fdd6b346b2aec58ee46`. Merge into current
`main` (`6ddb0307`): GitHub merge ref `17cd50473efdf6d955737bd9e663f88762484ef9`
fetched cleanly; `gh` reports `mergeable: MERGEABLE`.

<details>
<summary><b>中文摘要</b></summary>

**结论:findings(有发现,核心声明成立)。** 144 条脚本断言:142 通过 / 2 失败(同一根因)。

- **A/B 核心证明(成立)**:62 条命令矩阵,base 无守卫时 **43/62 真实突变外部仓库**(33/33 核心控制行全部突变);head(b11585bc6)上 **45/45 重定位 mutation 全部拒绝**且拒绝前不执行。只读重定位(`rev-parse`/`cat-file`/`describe`)与边界内命令全部放行。
- **发现 F1(中等,真实)**:只读允许列表的 `ls-files` 会刷新目标 index 并执行其 `core.fsmonitor` hook——与 PR 排除 `status`/`grep` 的书面理由完全相同,违反 PR 自己声明的不变量。实测复现;建议从允许列表移除 `ls-files`。
- **发现 F2(低,有意为之)**:`echo 'git -C …'` 等可被 shell 函数遮蔽的内建命令对含 `-C` 参数 fail-closed,误伤面窄;守卫自带测试只覆盖无 `-C` 提及。
- **本轮的 7f66be62 中间 head 实测**:独立复现了 3 个真实逃逸(brace expansion、here-string、`-C <symlink>/..`),随后确认 b11585bc6 提交将其全部关闭(见 Delta 表)。这与 CI 两轮 verify 的发现趋势一致:18e997a1 的 N1(`cd && nice`)、F2(monitor)在本轮验证的 head 均已被修复。
- **更正**:PR 描述中"25 个 daemon guard 测试"已过时(当前 200 个);"run-qwen-serve.test.ts 无法收集"是作者本地缺包的环境问题,完整安装后可收集且通过。
- **未覆盖**:真实 LLM 的完整 daemon 端到端(无模型凭据)、external provider 路径、Windows/Linux、全仓套件、bundle 构建。
</details>

## Previous-finding status (this round re-measured each; nothing carried by hash)

| # | finding (source round) | status at `b11585bc6` | evidence |
|---|---|---|---|
| N1 | `cd <outside> && nice git reset --hard` / opaque substitution after cwd shift (CI run 2) | **fixed** | matrix rows `cd-nice` deny, `subst-body`/`subst-backtick` deny |
| F2 | `monitor` tool never reaches the guard (CI run 1 & 2) | **fixed** | matrix row `monitor-tool` deny |
| F1 | argv-prefix wrappers `nice`/`setsid`/`stdbuf`/`ionice`/`script`/`find -exec`/`xargs` (CI run 1) | **fixed** | matrix rows `cd-nice`, `nice-direct-c`, `xargs-sh-c` deny; probe `sudo-*`, wrappers deny |
| F3 | forged model `directory` trusted as basis (CI run 1) | **fixed** | matrix row `dir-outside` deny; probe `dir-inside` allow |
| F5 | `status` allowlisted → index refresh (CI run 1) | **superseded** | `status-fsmonitor` now denied; `ls-files` remains allowlisted (see F1) |
| F4 | `--output` clause behaviorally dead / unpinned (CI run 2) | **carried** | the read-only early-return and allowlist are byte-unchanged across `7f66be62..b11585bc6` (diff touches only the tokenizer, `resolvePhysicalPath`, and tests); not re-mutated this round |
| F1 (this round) | `ls-files` runs target `core.fsmonitor` + refreshes target index | **stands** | `git -C <outside> ls-files` executed the configured hook (marker created) |
| F2 (this round) | `echo` with `-C`-bearing args denied (fail-closed) | **stands, adjudicated** | probe rows `fp-echo-quoted`/`fp-echo-dquoted`/`echo-quoted-c` all deny; deliberate fail-closed on function-shadowable builtins |

## Central claim + A/B

**Central claim**: a model-issued mutating `run_shell_command`/`monitor` that relocates
Git (`-C`, `--work-tree`, `--git-dir`, env relocations, shell front-ends) outside the
session's `effectiveCwd` is denied *before execution*, while read-only relocations and
in-boundary commands keep working.

Method: one 62-row command matrix, two arms. **Base arm** (base `845d6cf7`, which has
no daemon guard — the `externalToolGuard` bridge option is absent without an external
provider): every command executed for real against a scratch victim repo. **Head arm**:
the compiled `createDaemonToolGuard` (head build at `b11585bc6`) decides each command;
allowed commands were then executed for real and the victim repo re-checked for escape.
Oracle: victim HEAD sha, tracked content, branch list, recursive file tree,
fsmonitor/textconv markers. Real bash 5.3.15 + git 2.55.0, macOS arm64.

| Arm | mutating relocations executed | victim repo mutated | result |
|---|---|---|---|
| base (no guard) | 43/62 commands mutated the victim repo | 33/33 core control rows mutated | attack class real and broad |
| head (guard, `b11585bc6`) | 0 — all 45/45 deny rows denied before execution | no delta anywhere | central claim holds |

Key cells (full matrices in `01-ab-head-matrix.png` / `02-ab-base-matrix.png`;
compact summary `03-ab-summary.png`; extended forms `04-probe.png`):

| row | command (paths elided) | base | head |
|---|---|---|---|
| basic-c / work-tree / git-dir / namespace / shallow-file | `-C`, `--work-tree`+`--git-dir`, `--git-dir`, value-taking globals | MUTATED | denied |
| env-worktree / env-pair / env-S-fused / env-c / unset-name-export | env relocations incl. `env -C` (works on macOS) | MUTATED | denied |
| status-fsmonitor / cat-file-textconv / diff-textconv / show-output / ro-log | index refresh, textconv, `--output`, log | MUTATED (hook/driver ran, file written) | denied |
| gitfile-decoy / symlink-gitdir / wt-admin-outside | gitfile, symlink, worktree-admin indirection | MUTATED | denied |
| cd-basic / cd-nice / cd-case / cd-unreadable / builtin-cd / cd-P / cd-semicolon / cd-P-symlink-dotdot | shell front-ends | MUTATED | denied |
| wrapper-sh-c / wrapper-bash-lc / xargs-sh-c | wrapper payloads | MUTATED | denied |
| subst-body / subst-backtick / eval-export | substitutions / eval | MUTATED | denied |
| trailing-comment / backslash-cont / glob / dollar-quote / cmd-subst-flag / dynamic-var / tilde | token forms | MUTATED (glob/dollar-quote/subst-flag) | denied |
| config-alias / config-editor / config-ssh / config-pager / config-merge-driver | command-executing `-c` | MUTATED / hook ran | denied |
| brace-exp / here-string / c-symlink-dotdot | new semantics (see delta) | MUTATED | denied |
| monitor-tool | `monitor` tool | MUTATED | denied |
| dir-outside | model `directory` outside boundary | — | denied |
| ro-rev-parse / ro-cat-file / ro-describe / ro-gitdir-* | read-only relocations | no delta | allowed + executed safely |
| inside-* / plain-cmd / git-version / fp-* | in-boundary + non-git | no delta | allowed + executed |

Head-arm **escapes (guard allowed, execution mutated the victim repo)**: exactly one —
`ro-ls-files`, see F1.

### Delta `7f66be62` → `b11585bc6` (the PR advanced during this round)

The head moved from `7f66be62` to `b11585bc6` ("fix(serve): match chdir,
brace-expansion and here-string semantics", +94/−21, guard + tests only) while
verification was running. The full matrix was re-measured at both heads with identical
fixtures (`06-old-vs-new.png`):

| row | old head `7f66be62` | new head `b11585bc6` | note |
|---|---|---|---|
| brace-exp `git {-C,<o>} reset --hard` | **ALLOW → executed → outside repo mutated** | denied | brace expansion hid the relocation |
| here-string `sh <<< 'git -C <o> reset --hard'` | **ALLOW → executed → outside repo mutated** | denied | redirect operand now analyzed |
| c-symlink-dotdot `git -C <symlink>/.. reset --hard` | **ALLOW → executed → outside repo mutated** | denied | `-C` now resolved physically (chdir(2)); lexical `path.resolve` had collapsed `link/..` back inside |
| ro-ls-files | allowed (fsmonitor ran) | allowed (fsmonitor ran) | unchanged — F1 stands at both heads |

Old-head failures: 4 (the three above + `ro-ls-files`); new-head failures: 1
(`ro-ls-files`). The `b11585bc6` commit's three fixes are all load-bearing — each
flips a demonstrated allow-with-escape into a deny at the real guard.

## Corrections (to the PR description)

- The PR body cites "25 daemon guard tests" and "97 ACP bridge tests". At the verified
  head the guard suite contains **200 tests** (all passed), `acpAgent` +
  `run-qwen-serve` **620** (passed), `bridgeClient` **100** (passed). The body's counts
  predate the final commits.
- The PR body says `run-qwen-serve.test.ts` "could not be collected … because the
  workspace is missing `@qwen-code/channel-github`". That was an environment issue of a
  partial install: with a full `npm ci` it collects and passes (620 includes it; the
  suite asserts the serve path always installs the guard
  (`QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD=required-v1`) and that the installed
  `externalToolGuard` handler denies a `git -C <outside> reset --hard` request).

## Findings

### F1 — `ls-files` in the relocated read-only allowlist runs the target repo's `core.fsmonitor` hook and refreshes its index (Medium)

`RELOCATED_READ_ONLY_GIT_SUBCOMMANDS` still contains `ls-files` at the verified head.
`git ls-files` refreshes the target index (writes `.git/index` — a file write) and
invokes the target repository's configured `core.fsmonitor` program. The allowlist
comment says the set is "limited to subcommands verified to neither write files nor
execute programs configured by the target repository", and the PR excludes
`status`/`grep` for exactly this mechanism — so `ls-files` violates the PR's own
invariant. `cat-file`, `describe`, `rev-parse` were verified NOT to run the hook;
`ls-files` always does (even with a clean index).

Repro (victim repo configured with `core.fsmonitor = "sh -c 'touch MARKER'"`):

```
$ git -C <outside> ls-files        # guard: allowed
warning: Empty last update token.   # target repo's fsmonitor hook executed
$ ls MARKER                         # MARKER exists
```

Impact is bounded: no repo-content mutation (relative-path output of a piped
`ls-files | xargs rm` resolves against the shell cwd, not the target), no privilege
escalation (everything already runs as the daemon user). The concrete cost is
executing target-configured programs and writing the target's index — the same class
the PR closed for `status`/`grep`.

Minimal suggested fix (preserves intent — read-only relocations stay useful):

```diff
 const RELOCATED_READ_ONLY_GIT_SUBCOMMANDS = new Set([
   'cat-file',
   'describe',
-  'ls-files',
   'rev-parse',
 ]);
```

### F2 — `echo` (and other function-shadowable builtins) with `-C`-bearing args is denied (Low, deliberate fail-closed)

`echo 'git -C /outside reset --hard'` (quoted or not) is denied with "…may run a
relocated Git command through an unrecognized program". Defensible fail-closed
behavior — `echo` can be shadowed by a shell function that executes its arguments, so
the guard cannot distinguish inert text from an executed payload; every other
unrecognized program word with relocation markers is treated the same. Narrow
usability cost: a model echoing command examples containing `-C` gets an explicit
denial. The guard's own tests only cover flagless mentions (`echo 'git status'`,
`grep -rn 'git reset' src`), so this edge is untested there. Documented for
completeness, not a defect.

## Not covered

- **Full daemon end-to-end with a real model**: this environment has no LLM
  credentials; the A/B drives the compiled guard at the production call site
  (`createDaemonToolGuard` receives the same request shape the daemon host builds),
  plus the real-serve integration tests in `run-qwen-serve.test.ts` (passed). The
  child→daemon request path is covered by `acpAgent.test.ts` (620 passed).
- **External tool-guard provider path**: `createDaemonToolGuard(externalGuard)` with a
  live provider (composition, prompt-less refusal) is covered by unit tests only.
- **Windows / Linux**: all measurements ran on macOS arm64 (bash 5.3.15, git 2.55.0).
  Git versions other than 2.55.0 untested (the CI sandbox rounds ran Linux; the
  author's rounds ran Linux with git 2.47.3 — the two environments complement).
- **CI-round claims not re-measured here**: CI run 2's F4 (`--output` mutation
  survivor) was carried, not re-mutated (input closure shown unchanged by diff);
  CI perf-ladder/recursion claims were not re-run.
- **Repo-wide suite / bundle / web-shell / desktop**: only the affected workspaces
  (core, acp-bridge, cli) were built, tested, linted; `npm run bundle` and the full
  root suite were not run.
- **Shallow-repo merge-tree**: local `git merge-tree` impossible (shallow checkout,
  no merge base); mergeability evidenced by the fetched GitHub merge ref and `gh pr
  view` instead.

## Methodology

Environment: macOS arm64 (darwin 25.4.0), Node 24.18.1, npm 11.16.0, bash 5.3.15,
git 2.55.0. Head (`b11585bc6`) and base (`845d6cf7`) checked out into isolated
worktrees; head ran `npm ci` then `tsc --build` for core, acp-bridge, cli (all clean;
ESLint on changed files clean, liveness proven by planting a violation). Harnesses
(`harness/ab-harness.mjs`, `harness/probe.mjs`, `harness/old-vs-new.mjs`) build real
scratch git repos (victim outside the boundary with configured fsmonitor/textconv;
session repo inside; decoy gitfile, symlink, linked-worktree fixtures) and call the
compiled guard with the exact request shape the daemon uses (`sessionId`, `promptId`,
`toolCallId`, `toolName`, `arguments{command,directory}`, `effectiveCwd` — the
daemon-owned session cwd maintained via the `sessionCd` ext method). Allowed commands
execute through real `bash -lc`; the victim repo is re-snapshotted (HEAD, tracked
content, branches, file tree, markers) to prove no escape. The `7f66be62` arm used
the build captured before the head advanced (same fixtures, byte-identical harness).
Vacuity: disabling the `relocated` detection branch made 116/200 guard tests fail
(restored 200/200) — `05-vacuity.png`. One harness bug found and fixed during the
round: the base arm's `--work-tree … clean -fd` row deletes the untracked fixture dir
the `-C sub-link/..` row needs; that row's prep now recreates it (reported for
transparency — it does not affect any guard decision, only the base control cell).
Raw logs in `logs/`, results JSONs and harness sources in this directory, captures
under `evidence/`.
