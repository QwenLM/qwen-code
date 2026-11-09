# 让 `gh pr create` 在命令实际执行的目录里做归因

[English](2026-11-09-gh-pr-create-directory-attribution.md) | [简体中文](2026-11-09-gh-pr-create-directory-attribution.zh-CN.md)

日期：2026-11-09
状态：已实现（本地验证完成；尚未合入）

## 问题

在 worktree 里创建 PR 的会话不会自动绑定该 PR。2026-11-09 两个在线 daemon 会话复现了它：

| 会话                                   | create 命令                                                                            | 启动目录            | 所建 PR |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------- | ------- |
| `d0911852`（workspace `qwen-code-x4`） | `cd <root>/.qwen/worktrees/fix-16712 && gh pr create …`                                | `<root>`，分支 `x4` | #16719  |
| `195215bf`（workspace `qwen-code-x9`） | `cd <root> && … && cd .qwen/worktrees/deflake-boot-retry && gh pr create … \| tail -5` | `<root>`，分支 `x9` | #16717  |

两者都没传 shell 工具的 `directory` 参数。两个 PR 都只在操作者提醒后才登记，分别晚于创建 13.6 分钟与 4 分钟。

backfill 路径救不回任何一个会话：首条 prompt 是 Actions `?pr=N` 链接（刻意不作来源），从未键入 `/review` 或 `/verify-pr` 命令，且 worktree 是用裸 `git worktree add` 建的，因此不存在 `<sessionId>.worktree.json` sidecar 供 `pr-<N>` 约定读取。所以 `bindGhPrCreate` docstring 里"backfill recovers the rest"这句承诺，对最常见的 worktree 流程是过宽的。

## 现状

`ShellTool.execute` 计算 `cwd = this.params.directory || this.config.getTargetDir()`，并把这一个目录用于两条归因腿：

- pre-run 快照（`fetchCurrentBranchPullRequest`、`fetchCurrentBranchName`、`fetchAttributionRepoKeys`），在 spawn 之前取；
- post-run 的 `bindGhPrCreate` 闸门，再问一次 gh 当前分支的 PR。

`bindGhPrCreate` 明确记录了这个选择：它解析的是**启动**目录，"not a repo the command may have `cd`'d into"。当启动目录的分支没有 PR 时，gh 回答 `no pull requests found`，快照为 `{status: 'none'}`，闸门在 post-run 解析那一臂拒绝。

所有拒绝都只写 `debugLogger.debug`。daemon 默认日志级别看不到，于是操作者只看到一次成功的 create 和没有 badge，没有任何迹象表明有东西被跳过。

## 目标

1. 当命令自身的 `cd` 链能静态确定 create 的执行目录时，绑定该 PR。
2. 把剩余无法归因的形状对模型可见，而不是静默。
3. 既有归因闸门一条不动。

## 范围边界（明确不做）

- **不引入新的归因权威。** gh 仍是唯一权威。五道闸门保留：pre-run 快照非 `error`、解析出的号不同于 pre-run 的号、repo 身份落在 pre-run 的 resolved/parent key 内、head 分支等于 pre-run 分支、解析出的 URL 出现在命令输出里。
- **不做动态跟踪。** 解析器不执行命令、不问 shell 最终落在哪、不猜任何展开式的值。
- **不建模环境态 shell 状态。** 命令内部赋值的 `CDPATH` 会让相对目标判 `opaque`，但从环境继承来的 `CDPATH` 不做检查——走查建模的是命令，不是它运行所处的环境。`$HOME` 与其它一切展开式早已适用同一条边界。
- **不改执行闸门。** `commandRunsGhPrCreate` 保持其封闭语法；解析器原样复用它来识别 create 节点。
- **不改后台与 promote 的运行。** 它们仍经后台注册表结算，不实时绑定。
- **不扩 backfill。** 教 backfill 认裸 `git worktree add` 行不通：建 worktree 时 PR 号还不存在。

## 方案

### 有效目录解析器

`packages/core/src/tools/shell.ts` 里新增一个模块级 helper：

```ts
type GhPrCreateDirectory =
  | { kind: 'launch' }
  | { kind: 'resolved'; directory: string }
  | { kind: 'opaque' };

async function resolveGhPrCreateDirectory(
  command: string,
  launchDir: string,
): Promise<GhPrCreateDirectory>;
```

它用既有的 `parseShellCommand`（web-tree-sitter + tree-sitter-bash，`shell.ts` 已为只读分类器导入）解析命令，按执行顺序走树，逐级传递一个目录，并在第一个 create 节点处停止。

节点处理：

| 节点                                                                                       | 处理                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `program` / `list`，分隔符 `&&`                                                            | 目录从左向右承接。`&&` 是唯一能证明前一条语句成功的分隔符，因此也是唯一可以承接 `cd` 的分隔符。                                                                                                                                                                                                     |
| `program` / `list`，分隔符 `;`、换行、`&` 或 `\|\|`                                        | 一旦左侧移动过目录就判 `opaque`。下一条语句无论前一条成败都会执行（`\|\|` 则只在前一条失败时执行），所以被跳过（`false && cd w`）、失败（`cd /missing`）或后台化（`cd w &`）的 `cd` 从未移动我们。左侧已找到的 create 不受影响，左侧从未移动则不付代价。                                            |
| `pipeline`                                                                                 | 每个元素都用同一个传入目录访问；pipeline 之后的目录仍是传入目录（bash 在子 shell 里跑 pipeline 元素，内部 `cd` 不外泄）。                                                                                                                                                                           |
| `redirected_statement`                                                                     | 走 body，忽略 `*_redirect` 子节点。                                                                                                                                                                                                                                                                 |
| 被 `commandRunsGhPrCreate(createCandidateText(node))` 识别的 `command`                     | 记录当前目录并停止。闸门跑在由 AST 自身 token 重建的文本上，任何携带分隔符或展开式的参数被替换为占位符，因此 `printf 'example; gh pr create'` 这类引号内的提及无法伪造出 create。带 cwd 迁移的 wrapper flag（`env -C/--chdir`、`sudo -D/--chdir`，经既有 `isShiftCwdFlag` 表判定）则记为 `opaque`。 |
| 名为 `cd` / `pushd` 的 `command`                                                           | 把字面量目标相对当前目录解析；否则 `opaque`。`pushd +N` / `-N` 是栈轮转，判 `opaque`，不是名为 `+1` 的路径。命令在任何位置赋值了 `CDPATH` 时，相对目标判 `opaque`（CDPATH 会改道），绝对目标仍可解析。                                                                                              |
| 名为 `popd`、`eval`、`source`、`.` 的 `command`                                            | `opaque` —— `popd` 轮转的是未建模的目录栈；其余三个在当前 shell 里执行代码，能在命令文本里不出现任何目标的情况下移动目录。执行脚本（`./move.sh`）不在此集合：它跑在子进程里，动不了我们。                                                                                                           |
| 其它命令                                                                                   | 目录不变。                                                                                                                                                                                                                                                                                          |
| 其它任何节点（`subshell`、`compound_statement`、`if_statement`、循环、`case`、函数定义……） | 子树里含 `cd`/`pushd`/`popd`/`eval`/`source`/`.` 命令则 `opaque`，否则目录不变。子 shell 的 `cd` 不得泄漏到外层作用域。                                                                                                                                                                             |

`cd` 目标只有在下列条件全部满足时才算字面量：是普通 word、单引号 `raw_string`（在 bash 里完全字面，因此去掉引号后即为路径），或 body 为纯内容的双引号 `string`——无展开、无命令替换、无前导 `~`、无 `$`、无反引号、无反斜杠、无 glob 或花括号字符，且不是 `-`（上一个目录）也不缺省（裸 `cd` 去 `$HOME`）。目标之前的 flag 被跳过。解析方式是 `path.resolve(currentDirectory, target)`，它是平台原生的：测试用同样方式推导期望值，而不是硬编码 POSIX 字符串，因为 Windows workspace lane 会跑这些用例。

解析失败或根节点 `hasError` 返回 `{kind: 'launch'}` —— 解析器什么都没证明，因此行为与今天完全一致，也不发 notice。

### 接线

pre-run 块本来就只在执行闸门命中且会话未开沙箱时运行。它先解析目录，再在解析出的目录里取三份快照：

```ts
const ghPrCreateDirectory = await resolveGhPrCreateDirectory(
  commandToExecute,
  cwd,
);
const attributionDir =
  ghPrCreateDirectory.kind === 'resolved' ? ghPrCreateDirectory.directory : cwd;
```

`attributionDir` 替换三份 pre-run fetch 与 `bindGhPrCreate` 调用里的 `cwd`。两条腿因此问的是同一个目录，这正是 pre-run/post-run 比较已经假设的前提。

目录不存在无需特判：那里 `findGitRoot` 返回 null，快照为 `{status: 'error'}`，既有闸门自然拒绝。

### 可见的兜底 notice

解析器返回 `opaque` 时，工具结果经既有的 `appendedMetadata` → `notices` 通道（与 `attributionWarning`、长跑提示同一通道）追加一条面向模型的 notice：

> PR auto-binding fell back to the launch directory: this command's directory
> change is not statically resolvable. Set the shell tool's `directory`
> parameter to the repository you create the PR in, or register the PR on the
> session after creating it.

这条 notice 只随以退出码 0 收尾的前台运行发出——未中断的运行，或子进程已退出后 promote 被拒的运行——这恰好就是绑定闸门能看到的那批运行。create 失败或被取消时没有 PR 需要登记，因此什么也不说：条件是 `kind === 'opaque' && (!result.aborted || wasPromoteRefused) && result.exitCode === 0`。解析结果在 spawn 之前就已算出，因此它不依赖 fire-and-forget 的绑定 hook 是否完成，但这个「已成功收尾」条件对每一种情况都成立，不只是对 `opaque`。`launch` 与 `resolved` 不发任何东西。

## 关键决策与理由

- **用 AST，不再写第二套文本走查。** `gitCommitContext` 已经在按段做文本走查，但它的 `cdTargetMayChangeRepo` 启发式回答的是相反的问题（"这会不会已经离开本仓库？"），并对绝对路径与 `~` 保守放弃。复用它会把本次要修的典型场景直接拒掉。AST 能区分子 shell 与 PR 标题里被引号包住的圆括号、区分展开式与字面路径，不需要新的引号启发式。两条事故命令都含 `fix(managed-agent)` / `test(web-shell)` 标题和一个 `>` 重定向；文本式的圆括号/操作符扫描会在它们上面放弃解析。
- **在第一个 create 处停止。** 闸门只绑一个 PR —— 当前分支的那个。create 之后的 `cd`、或 `|| gh pr view` 的重试尾巴，都改变不了答案。
- **`opaque` 选择退回而非拒绝。** 退回启动目录保留了今天对所有"解析器证明不了的形状"的行为，因此本改动只可能新增绑定，绝不可能减少绑定。
- **不新增 bundle 边。** helper 放在 `shell.ts`，它已经导入 `shellAstParser.js`。放进 `utils/github-prs.ts` 或 `services/session-pr-service.ts` 会把 WASM 解析器拉进 serve bundle closure —— 这正是 `session-pr-service.ts` 今天自带文本闸门的原因。

## 约束

- 解析器只对未开沙箱且过了执行闸门的命令运行，因此其成本（在已初始化的单例解析器上做一次 parse）只在 `gh pr create` 的运行上付出。
- create 节点的识别必须与执行闸门完全一致；解析器调用 `commandRunsGhPrCreate`，不复述其语法。
- notice 必须与其它面向模型的 notice 一起计入预算（`appendedMetadataChars`），与既有提示和告警一致。

## 风险

- **解析错了会绑到错误目录的 PR。** 五道闸门仍然生效，且两条腿用同一个解析出的目录，因此错误解析会像今天传错 `directory` 参数一样，倒在输出 URL 闸门或 pre-run 号闸门上。信任模型不变。
- **`||` 与子 shell 形状会失去本可得到的绑定。** 它们退回今天的行为，并且现在会发 notice；无回归。
- **解析器不可用。** WASM 初始化永久失败时 `parseShellCommand` 会 reject；解析器捕获并返回 `launch`。

## 验证计划

1. 在既有 `gh pr create binding` 块里加单测（真实 AST、mock 掉 gh 腿），断言两条腿收到的目录：单个与链式字面 `cd`、相对 `cd`、create 之后的管道、更早段里的重定向、含圆括号的引号标题、create 之后的 `cd`、以及 `directory` 参数与内部 `cd` 组合。
2. 负向用例断言退回启动目录并发 notice：`cd $VAR`、`cd ~/x`、裸 `cd`、`cd -`、`popd`、`(cd /other) && …`、`cd /a || …`、`env -C /other gh pr create`、以及控制流体。
3. 一条无 `cd` 的对照，断言不发 notice。
4. 真实文件系统 A/B：一个真实仓库带一个真实 linked worktree，一个按目录回答 `pr view` 的 PATH 桩 `gh`，走真实的 `findGitRoot` / `fetchCurrentBranchPullRequest` 链路。改动前内部 `cd` 的 create 什么都绑不上；改动后绑定 worktree 的 PR。
5. 变异见证：去掉目录传递、去掉 notice，各自让一条点名用例变红。
6. `npm run build && npm run typecheck`、被改动的测试文件、改动文件上的 lint 与 Prettier。

### 实测结果（2026-11-09，本地，最终树）

- `npm run build && npm run typecheck`：**exit 0**，在最后一次源码改动之后重跑；已核对 `dist/src/tools/shell.js` 比源码新、且含解析器与全部守卫，因此构建证据针对的是最终树。
- 三个改动 TS 文件上的 ESLint：**干净**。五个改动文件都跑过 Prettier。
- `src/tools/shell.test.ts` + `src/tools/shell.pr-binding-directory.test.ts` 合跑：**429 passed** —— 既有文件 422 条（22 条既有绑定用例 + 43 条新增目录解析用例），真实文件系统 7 条。
- 真实文件系统套件跑在真实 `git init` 仓库、真实 `git worktree add` 出的 linked worktree、以及一个真实 `gh` 子进程桩上（该桩只在某分支里跑过 `pr create` 之后才为该分支报告 PR）。归因链路没有任何 helper 被 mock。套件用 `describe.skipIf(process.platform === 'win32')` 守卫，与 `autofix-pr.test.ts` 里既有的可执行入口守卫一致——因为 Windows workspace lane 会跑 `test:ci:workspaces`，而该桩是 bash 脚本。
- **对抗探针。** 一个临时的无 mock 夹具把 38 个敌意命令形状灌进真实工具，跑在真实仓库加真实 linked worktree 上，由 `gh` 桩记录每次调用的 cwd 与 argv。只有归因调用（`pr view` / `repo view`）能反映解析出的目录——命令自身的 `pr create` 跑在 shell 实际 cd 到的地方，证明不了任何事。worktree 对这个 oracle 是必需的：`findGitRoot` 会把普通子目录收敛到仓库根，因此同仓库内的 `cd` 在日志里无法区分。探针抓到了下面两个静默漏绑缺陷；修完后 38 个形状全部落在预期分桶——12 个解析到 worktree，17 个退回并发 notice，9 个留在启动仓库且不发 notice（6 个因为什么都没移动，3 个因为 create 自身失败、按设计在非零退出时抑制 notice）。夹具在提交前已删除；它的发现以由此催生的八条永久用例的形式留存。
- 变异 A —— 去掉 `attributionDir` 赋值、保留 resolver 调用：**13 failed / 398 passed**。红的是两条真实文件系统绑定用例与全部断言解析目录的单测；`directory` 参数与 notice 两条对照存活，因此红的是目录传递本身，不是夹具坏了。
- 变异 B —— 把 notice 强制为 `null`：**19 failed / 392 passed**。红的恰好是十八条单测退回形状加一条真实文件系统 notice 用例；目录解析用例全部保持绿。A 与 B 杀掉的用例集合互斥。
- 变异 C —— 只去掉 `pushd` 栈轮转守卫：点名的 `pushd stack rotation` 用例在目录断言上变红。
- 变异 D —— 只去掉 `||` 臂上的 `current !== dir` 条件：点名的 `|| branch whose left never moves` 用例在 notice 断言上变红。
- 变异 E —— 从 opaque 臂去掉 `eval`/`source`/`.`：解析块内 **3 failed / 30 passed**。`function body that evals` 用例存活，因为子树扫描独立捕获了它——两套机制各自承重。
- 变异 F —— 只去掉 CDPATH 守卫：**2 failed / 31 passed**，恰好是两条 CDPATH 形状；绝对目标对照存活。
- 每次变异都从字节级备份还原；还原后的 `shell.ts` 与变异前的 SHA-256 一致（`4d9cbf2b389b69f1567254f6080e1d784fdfd75eccb8d2f7b361759bce9ce676`）。
- 实现、自审与对抗探针过程中共发现并修掉七个缺陷：`cd -` 被当成名为 `-` 的字面路径；外层 `||` 在走查到达左子树里的 create 之前就把整条链判为 opaque；解析器不调用 `tree.delete()`，在长驻 daemon 里泄漏 WASM 内存；`pushd +N` 被当成名为 `+1` 的路径；`||` 臂为 `false || gh pr create` 发出 notice，而那是一次从未发生的目录变更；`eval`/`source`/`.` 隐形移动目录，导致 create 实际跑在 worktree 而归因留在启动仓库、且不发 notice；`CDPATH` 改道相对 `cd`，而走查把它当成可证明。最后两个只有对抗探针抓到——读 diff 当时已连续两遍干净。

### 第二轮评审（2026-11-09，独立 Codex 评审 `e12e88be94`）

评审报了一个绑定回归、两个解析器缺口和一个测试可移植性问题。四条都先对 head 复现再修：分隔符与引号事实由 dump tree-sitter AST 确认，Windows 那条由求值 `path.win32.resolve` 确认（产出 `\test\dir\nested`，而非测试原先断言的 POSIX 字面量）。

1. **回归——未执行的目录变更被承接了下去。** 折叠把每个分隔符都当成保证顺序执行，于是 `false && cd w; gh pr create`、`cd /missing; gh pr create`、`cd w & wait; gh pr create` 全都归因到 `w`，而 create 实际跑在启动仓库。父提交能绑这些形状，本 head 不能，且不发 notice。修法是只在 `&&` 上承接目录——它是唯一能证明前一条语句成功的分隔符。`;`、换行、`&`、`||` 现在一旦左侧移动过就退回。这也取代了此前专门针对 `||` 的规则，那只是同一原则的特例。
2. **缺口——单引号目标被拒。** tree-sitter 把它拼作 `raw_string` 而非 `string`，于是本设计要修的那条命令，其最普通的单引号写法仍然绑不上，而双引号写法可以。现在接受 `raw_string` 并去掉引号；单引号在 bash 里完全字面，内部无需展开检查。
3. **缺口——引号参数能伪造 create。** 执行闸门按分隔符切分而不跟踪引号，于是 `printf 'example; gh pr create'` 产出一个以 `gh pr create` 开头的段；走查在那里就停在启动目录，永远到不了真正的 create。现在闸门跑在由 AST 自身 token 重建的文本上，任何携带分隔符或展开式的参数被替换为占位符。闸门语法仍是权威，只是它的输入被净化了。
4. **可移植性——解析目录的期望值是 POSIX 字面量。** 解析器用平台原生的 `path.resolve` 拼接，而 Windows workspace lane 会跑这个套件（只有独立的真实文件系统套件被跳过）。解析目录的期望值现在用 `path.resolve` 推导；启动目录的期望值保持字面量，因为那个值是原样透传、从不 resolve 的。

第二轮验证：**429 passed**（既有文件 422 条，含 43 条目录解析用例；真实文件系统 7 条），core typecheck exit 0，ESLint 与 Prettier 干净。四次新变异见证，每次都从字节级备份还原并核对校验和（`68bf56c06236ce5e5826e6316e5bc0d3e79a13d032aba61ae2ef693452acacc0`）：

| 变异                        | 结果                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| G —— 恢复无条件折叠         | 7 failed / 420 passed：五个新分隔符形状、既有的 `\|\|` 用例、以及新的真实文件系统跳过-`cd` 回归 |
| H —— 去掉 `raw_string` 处理 | 4 failed / 423 passed：两条单引号单测，以及两条对 worktree 路径加引号的真实文件系统用例         |
| I —— 把节点原始文本喂给闸门 | 2 failed / 425 passed：恰好是引号参数的单测与真实文件系统用例                                   |
| J —— 赋值原样透传不净化     | 点名的引号赋值用例在目录断言上变红                                                              |

真实文件系统套件新增三条：含空格的单引号 worktree 路径、只是在引号里提及 `gh pr create` 的参数、以及一个被跳过的 `cd`——它必须仍绑定启动分支的 PR，同时 worktree 的 marker 保持未写入。

审计第二轮 diff 时，在第三条意见的修复里发现了第十二个缺陷：只净化参数、却把 `variable_assignment` 节点原样透传，于是同一种伪造仍能经赋值自身的引号值成立（`X='; gh pr create' printf hi`）。现在赋值按同一规则净化，并用两条用例钉住两个方向——伪造被拒，而普通的内联凭据（`GH_TOKEN=abc gh pr create`）仍能解析、且凭据仍送达验证腿。写这条对照时还抓出测试自身的一个错误：带内联凭据时 env 参数是一个 overlay，而不是共享 helper 所断言的 `undefined`。

至此跨实现、自审、对抗探针与本轮评审共发现并修掉十二个缺陷。其中回归最值得记：它由本设计自己的第一版实现引入，躲过了两遍干净的读 diff 和一个 38 形状探针，只有评审者把绑定结果与父提交对比才抓到。探针的形状全都用 `&&`，因此没有一个覆盖到非保证成功的分隔符。

### 第三轮评审（2026-11-09，复评 `062a15ada7d`）

复评确认第二轮的两条已完全修好（单引号路径、引号参数与赋值伪造），并报出四条仍存的 P2——**其中两条是第二轮跟进修复自己引入的回归**。四条都先对 head 复现再修：三条靠 dump AST，一条靠 `path.win32` 模拟。

1. **回归——把 OR-list 的成功当成其 `cd` 已执行的证明。** `true || cd w && gh pr create` 解析为 `list(list(true || cd w) && create)`。第二轮的规则只问 `||` 的**左侧**是否移动过，于是被跳过的右侧 `cd` 仍被访问、其目录被返回给外层 `&&`。而 bash 经 `true` 成功、根本不跑那个 `cd`。现在 `||` 在**两个方向**上都是歧义的：任一侧可能移动目录，结果就不可证明。
2. **回归——净化展开凭据时毁掉了赋值本身。** 把整个 `variable_assignment` 替换成裸 token，会把 `GH_TOKEN=$TOK gh pr create` 变成 `X gh pr create`，闸门不再识别，于是丢掉了未净化文本本来能做出的绑定。现在只替换**值**，赋值形状以 `NAME=X` 保留——既仍满足闸门的前置赋值语法，也仍无法携带伪造的分隔符。
3. **回归——注释消费掉了待用的分隔符。** tree-sitter 把注释作为**具名**子节点放在 `&&` 与后续命令之间，于是 `cd w && # note` + 换行 + `gh pr create` 把注释当语句访问并清掉了操作符，让一条已证明的链看起来不可证明。现在跳过 comment 节点且不消费待用分隔符。
4. **修复不完整——同目录比较仍对拼写敏感。** 从启动目录 `/test/dir` 执行 `cd /test/dir` 是空操作，但 `path.resolve` 会用平台分隔符拼写它，因此裸的 `found === launchDir` 在 Windows 上判为 `resolved`。现在比较前把两侧都规范化——这是修语义，而不是改期望值。

第三轮验证：**434 passed**（既有文件 425 条，含 46 条目录解析用例；真实文件系统 9 条），core typecheck exit 0，ESLint 与 Prettier 干净。变异见证 K（去掉 OR-list 右支检查）、L（退回裸赋值 token）、M（去掉 comment 跳过）各自恰好杀掉自己的两条用例——单测与真实文件系统各一——432 条仍绿。第 4 条**在 Linux 上没有可观测的变异**：`path.resolve` 在那里是恒等，因此改用 `path.win32` 模拟验证（裸比较判 `resolved`、规范化后判 `launch`），不声称它有变异见证。

真实文件系统套件新增两条：被 OR-list 跳过的 worktree 必须仍绑定启动分支的 PR 且 worktree marker 未写入；插入注释的 AND 链必须绑定 worktree 的 PR。

**CI gate freshness。** 本 head 上 `Lint & Static` 的 `Check lint gate freshness` 失败。脚本自己给出的 remedy 是合并或 rebase 基线，而 incoming main 带着 `#16706 fix(ci): stop staling branches for eslint ignores they never excluded`——正是对该 gate 本身的修复。这是 gate 过期信号，不是本改动的缺陷，处置是合入当前 main 而非改代码。

至此共发现并修掉十五个缺陷。其中三个由本设计自己的跟进修复引入，这是值得记录的模式：第二轮的每个修复都收窄了一个洞、同时打开了相邻的另一个，只有评审者把绑定结果同时对父提交与上一个 head 重跑才抓到。本设计自己的探针与读 diff 都没抓到。

### 第四轮评审（2026-11-09，复评 `96d41924410`）

复评确认第三轮的修复，并报出两条 Critical 回归、一条 notice 措辞 Suggestion 及若干测试效力缺口。全部先对 head 复现再修。

1. **R1-1（Critical）——走查仍在证明 shell 实际不会进入的目录。** `pushd -n DIR` 只入栈不移动；同名函数（`cd() { :; }`、`gh() { … }`）遮蔽内建；`command`/`builtin`/`time` 前缀隐藏实际执行的命令；`bash -c "…"` 是独立 shell；`shopt -s lastpipe` 让管道最后一个元素移动当前 shell；`trap … DEBUG` 可在任意两条命令间移动；`git worktree add … && cd <new> && gh pr create` 快照时目标路径尚不存在。这些形状现在一律返回 `opaque`（启动目录归因 + 可见 notice），不再静默解析出错误目录。函数遮蔽按执行顺序登记且限定在当前 shell，因此 create 之后或子 shell/管道内的定义不会污染前面的 `cd`。
2. **R1-2（Critical）——解析目录替换了两条腿的启动目录且无回退。** 当解析目录没有 git 仓库（`findGitRoot` 返回 null）或命令指向**不同**仓库（`--repo` / `GH_REPO`）时，两条腿现在回退到启动目录并重新快照——即父提交一贯的行为。真实仓库内的 gh 错误仍失败关闭（不回退）。显式仓库从 create AST 节点（引号感知）与 `ghPrCreateInlineEnv` 读取；`--repo` 优先于 `GH_REPO`；`GITHUB_REPOSITORY` 是 Actions 上下文变量而非 gh 仓库覆盖，予以忽略。fork parent key 视为同一归因族。
3. **R1-4（Suggestion）——notice 措辞。** notice 段与验收标准第 2 条现在明确：notice 只在已成功收尾的前台运行（exit 0、未中断，或子进程退出后 promote 被拒）发出；create 失败或被取消则不发。
4. **R1-5（Suggestion）——否定断言缺少 happens-before 边。** 真实文件系统展开回退用例现在先等 pre-run 与 post-run 两条 `pr view` 腿都被记录（`waitForAttributionLegs`），再断言未绑定，避免仅因写入尚未落地而假绿。
5. **R1-6（Suggestion）——promote-refused notice 分支无钉子。** 新增用例断言 opaque create 在 settle 后 promote 被拒时仍发 notice，并加对照断言非 opaque 的 promote-refused create 不发。
6. **R1-7（Suggestion）——管道不泄漏无钉子。** 新增用例断言 `cd /test/dir/nested | cat && gh pr create` 归因到启动目录且不发 notice。
7. **R1-8（Suggestion）——git 夹具签名。** 真实 git 夹具在仓库本地设 `commit.gpgsign = false`，并新增一条敌对 `~/.gitconfig` 启用签名的回归，使开发机全局配置不会让所有夹具提交失败。
8. **R2-1（Suggestion）——分隔符分支的裸字符串比较。** `||` 与非 `&&` 分支现在比较 `path.resolve(current) !== path.resolve(dir)`，带尾斜杠的 `directory` 参数不再虚构目录变更并发出假 notice。

本轮自审还发现并修掉修复自身引入的四个缺陷：全局函数预扫描污染了定义之前的 create 并泄漏子 shell/管道作用域；整条命令的 `--repo` 正则误匹配 PR 正文与引号值；`--repo`/`GH_REPO` 优先级颠倒；`GITHUB_REPOSITORY` 被误当作仓库覆盖。每个都有专用用例钉住。

第四轮验证：**469 passed**（既有文件 458 条，含 74 条目录解析用例；真实文件系统 11 条），core typecheck exit 0，ESLint 与 Prettier 干净。变异见证 N–X 各自杀掉点名用例且对照存活：

| 变异                             | 结果                                          |
| -------------------------------- | --------------------------------------------- |
| N —— 去掉分隔符归一化            | 尾斜杠用例变红                                |
| O —— 禁用 wrapper 失败关闭       | 4 条 wrapper 用例红，2 条无关前缀对照绿       |
| P —— 禁用 nested-shell 守卫      | nested-shell 用例红，`sh -c 'echo ok'` 对照绿 |
| Q —— 去掉 lastpipe 检查          | lastpipe 用例红，普通管道对照绿               |
| R —— 禁用 worktree-add 守卫      | 单测 + 真实文件系统用例红                     |
| S —— 禁用 trap 守卫              | DEBUG-trap 用例红                             |
| T —— 恢复全局函数预扫描          | 3 条作用域/顺序对照红，直接遮蔽用例绿         |
| U —— 退回文本仓库匹配            | 5 条仓库用例红，等号形式 + parent 对照绿      |
| V —— 放宽 error 回退             | fail-closed 用例红，非仓库回退绿              |
| W —— 去掉 fork parent key        | parent-repo 用例红                            |
| X —— 禁用当前 shell 子树函数登记 | 复合语句遮蔽用例红，子 shell 对照绿           |

每次变异都从字节级备份还原；最终 `shell.ts` 的 SHA-256 与变异前冻结一致（`5d00698edc5738c1f5880a12104c3936d91f0b92ec7b0a097a22bd5a9cf59dfc`）。

### 第五轮评审（2026-11-09，复评 `29d8b326b9`）

复评确认第四轮的修复，并报出两条新 P2 绑定回归与一条 R1-1 残留见证。三条都先用真实 linked worktree 对 head 复现再修。

1. **带 host 的 `--repo` 被当成不同仓库。** derived key 被削成裸 `o/r`，而显式值保留 host（`github.com/o/r`），于是 `cd <o/r 的 worktree> && gh pr create --repo github.com/o/r` 把两条腿回退到启动目录、什么都没绑。现在两侧都规范化为 `host/owner/repo`（无 host 的显式值默认用 derived host）再比较。
2. **引号等号形式 `--repo='o/r'` 保留了引号。** tree-sitter 把它拼作 `--repo=` word 与引号值的 `concatenation`；裸 slice 存下带引号的 `'o/r'`，身份比较把它当成另一个仓库。新增 `literalShellValue` 解码器把 word / raw_string / string / concatenation 解析为 Bash 实际传入的字符串，分离与等号两种形式都覆盖。
3. **R1-1 残留见证——引号可执行文件伪造 create。** `'gh; gh pr create' 2>/dev/null; cd <worktree> && gh pr create` 之所以停在启动目录，是因为 `createCandidateText` 原样拷贝 `command_name`，不认引号的闸门在其中找到了 `gh pr create`。现在命令名与参数一样被净化（反斜杠/斜杠仍合法，路径限定的 gh 仍能匹配）。

第五轮验证：**475 passed**（462 单测 + 13 真实文件系统），core typecheck exit 0，ESLint 与 Prettier 干净。变异见证 Y（命令名净化）、Z（等号解码）、AA（host 规范化）各自杀掉点名用例且裸名/引号对照绿；每次从字节级备份还原（最终 `shell.ts` SHA-256 `352239efcf047ac37f931da6edd23154cff7e940f1e42fc704639a88a9688b22`）。

## 验收标准

- 两条事故命令形状都绑定到其 worktree 分支所解析出的 PR。
- 解析器证明不了的每种形状行为与之前完全一致。涉及此类目录变更时，已成功收尾的前台运行会附带一条 notice；create 失败或被取消则不发。
- 既有归因闸门一条未被削弱；22 条既有绑定用例全部仍绿。
- `bindGhPrCreate` 的 docstring 及其 post-run 解析注释不再声称启动目录是唯一的归因目录，也不再声称 backfill 能救回内部 `cd` 的 create。（2026-08-20 的会话 PR 绑定设计文档从未作出该声称，故保持不动；目录行为以本文档为准。）

## 开放问题

无。
