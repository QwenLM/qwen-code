# 只比对 ci.yml 定义的 lint 闸门，而不是整个文件

[English](2026-11-11-lint-gate-freshness-ci-slice.md) | [简体中文](2026-11-11-lint-gate-freshness-ci-slice.zh-CN.md)

状态：已实现，已在本机与真实 API 上验证；尚未合入

## 问题陈述

`Check lint gate freshness` 会在 base 分支改动了某个闸门定义文件、而当前分支尚未包含该改动时让 PR 失败。清单上有九个文件，其中 `.github/workflows/ci.yml` 与其余八个不同：它承载整个 CI 定义，而另外八个只定义 lint 闸门。

这个差别让「整文件包含」判定在仓库里最繁忙的文件上变成了跑步机。2026-11-04 那一周 `ci.yml` 有十次提交，其中多数并未改变 lint lane 检查的内容：

| 提交                    | 改动                                    | 是否影响 lint 闸门 |
| ----------------------- | --------------------------------------- | ------------------ |
| `e8061d493793` (#16764) | 所有分片 lane 缩减为两个分片            | 否                 |
| `2aac39a17b6f` (#16617) | web-shell 截图采集路由到 disposable 池  | 否                 |
| `65e1f1aeaaa8` (#16551) | 外部 PR CI 直接路由到 disposable runner | 否                 |
| `8660f754305b` (#16476) | 在较旧的 PR checkout 上刷新 host 资源   | 否                 |
| `1a20792cfa93` (#16132) | no-AK 集成闸门路由到 ECS                | 否                 |
| `2b9c4a98f474` (#16328) | 为 Linux 分片固定 `COREPACK_HOME`       | 否                 |

上述每一次都要求所有在途 PR 先合入 `main` 并推送、重启整个矩阵，`Lint & Static` 才可能重新变绿。这条 lane 只 checkout 分支 head，所以重跑永远不可能让它变绿。

这正是该检查自己的头部注释声称通过排除 `package.json` 与 lockfile 所要避免的跑步机：_「在每天 50–100 个合入的频率下，依赖升级几乎每天都会落地，迫使每个在途 PR 跟在其后 rebase 就重建了『要求分支保持最新』的跑步机。」_ 排除是按文件做的，而一个文件的流量把它重新引入了。

### 与此前否决结论的关系

[2026-11-09-lint-gate-freshness-ignores-subset.md](2026-11-09-lint-gate-freshness-ignores-subset.md) 曾把 `ci.yml` lint 切片列为不在范围内，依据是：就其测量的两个分支而言，base 到 head 的全部差异都落在切片之内（`HELPER_TESTS` 那几行），因此判定依旧 stale，对该样本中 9 次失败的修复数为 0。

那次测量成立，本设计并不与之矛盾。`HELPER_TESTS` 清单**确实**是闸门定义：它们列出这条 lane 运行的测试套件，所以缺少新条目的分支确实在用更小的闸门做验证。本切片保留这些清单，对那两个分支仍然会失败。

此前样本未覆盖的是 plumbing 这一类，也正是本次改动要解决的部分。以最近十三次 `ci.yml` 提交（而非两个分支）为样本测量，其中六次属于纯 plumbing，现在可以通过。其中 #16551 也在那个样本的 9 次失败之中——所以「9 次中修复 0 次」是所选两个分支的属性，而不是该方法的属性。那个样本中的主要触发源，即 #16200 的全局 ignore 新增，仍属于另一份设计的范围。

## 现状

`findStaleGateFiles()` 对每个闸门文件花两次 API 调用——base 侧最近一次触碰该文件的提交，然后是交换方向的三点比较 `S...head`，其 `ahead`/`identical` 状态表示分支包含该提交。`diverged` 或 `behind` 表示 stale。

`NARROWINGS` 分发表已经为 `eslint.config.js` 与 `.prettierignore` 对 stale 判定做后置过滤：纯粹收缩范围的改动不会使分支失效。不在表中的文件保持整文件包含判定，`ci.yml` 今天就属于这一类。narrowing 路径是 fail-closed 的：抓取或提取失败会保留判定并输出 `::warning::`，因为向上抛出会到达 `main()` 的 fail-open，从而把其他所有闸门文件的判定一并丢弃。

## 目标

- 当 base 侧 `ci.yml` 改动使该文件定义的 lint 闸门保持逐字节相同时，不再让分支失败。
- 对任何可能使分支的绿色不再充分的 base 侧改动继续失败，包括 lane 参数、profile 分类器、linter 版本，以及 `HELPER_TESTS` 清单的改动。
- 绝不制造整文件包含判定本来会拒绝的绿色：任何提取器无法归类的形态都退回今天的判定。

## 范围边界

范围内：`.github/scripts/check-lint-gate-freshness.mjs`、其同目录测试，以及这份双语文档。

明确不在范围内：

- **不修改 `ci.yml` 本身**。切片由该文件既有结构计算得出，因此本次改动不增加任何 workflow 字节、不触碰 `.size-baseline`，也不需要更新 workflow 元测试。
- `GATE_FILES` 不变；`ci.yml` 仍在清单上，其包含判定仍然先行计算。
- 其余八个闸门文件保持既有行为，包括那两处范围 narrowing。
- 不解决 `HELPER_TESTS` 的跑步机；而且与 plumbing 不同，它不是误报。追加一个套件是增加了这条 lane 必须执行的工作；缺少该条目的分支从未运行过那个套件，所以它的绿色确实更弱。把清单移到独立文件只会把同一个判定换个位置，并不能消除 rebase，因此这**不**作为后续建议提出。
- `main()` 的 fail-open 策略不变。

## 方案

新增第三个 `NARROWINGS` 条目 `narrowsToUnchangedLintSlice`，它比对提取出的切片，而不是 ignore 条目之间的序关系。

### 切片

`extractLintGateSlice(text)` 保留：

1. `jobs:` 之前的所有行——触发条件、`concurrency`、`permissions`、`defaults`，以及 workflow 级 `env`，`ACTIONLINT_VERSION`、`SHELLCHECK_VERSION`、`YAMLLINT_VERSION` 和两个 `HELPER_TESTS` 清单都在那里。
2. `classify_pr` 的全部内容。它选择 CI profile，而 profile 选择运行哪些 linter，所以尽管是另一个 job，它仍属于闸门定义。
3. `lint_and_static`，去掉下述 plumbing。

其余全部丢弃——每个 test、build 与 E2E job。

plumbing 是**步骤名**白名单，而不是对内容的猜测：

```
Create isolated HOME                            Configure persistent npm cache (self-hosted)
Restore workspace ownership                     Configure npm for rate limiting
Clean stale .qwen before checkout                Report npm cache usage (self-hosted)
Recreate runner Git metadata                     Clean isolated HOME
Checkout                                         Dump disk state on failure
Verify checkout includes expected head commit    Upload disk-pressure samples
Select Linux runner                              Disk floor gate (self-hosted)
Verify trusted classifier checkout is clean
Checkout trusted CI classifier
```

在 job 层面只丢弃 `runs-on` 与 `timeout-minutes`，并连带丢弃它们的续行。`env`、`if`、`needs`、`outputs`、`permissions` 与 `steps` 保留：它们决定运行什么，而不是在哪里运行。

比对文本中会去掉整行注释与空行，因为 `ci.yml` 注释密集，且大量改动只是文字说明。只有首个非空白字符为 `#` 的行才被丢弃，因此 shell 正文里的 `#` 属于内容并会保留——提取器绝不会移除 runner 会读取的行。

在当前文件上测量，切片为 3514 行中的 372 行，lint job 的 65 个步骤中贡献 44 个。

### 为什么默认是「保留」

白名单列出的是**可以被忽略**的部分，而不是重要的部分。漏掉对某个新闸门步骤的分类，会让它留在切片里，代价最多是今天的过度拒绝；而白名单里的错误条目会隐藏真实的闸门改动。这种不对称是刻意的，并由两道保护支撑：

- 若白名单中某个步骤的正文调用了 linter，则直接拒绝 narrowing。标签本身不被信任——一个仍在运行 `scripts/lint.js` 的步骤被移入白名单是矛盾，而不是通过。
- 测试会读取真实 workflow，要求每个 plumbing 名称都存在其中，因此步骤改名不会留下一个「静默地什么都没排除」的过期条目。

Node 供给相关步骤（`setup-node`、pnpm store action、self-hosted Node action）刻意**保留**在切片中：它们决定 linter 运行所用的工具链，因此版本升级可能改变 lint 语义。只排除缓存位置与 npm 重试设置。

安装前置步骤同样保留。#16900 与 #16920 正是扩大了这段前置步骤来补上合入后的 lint 缺口：某个 profile 跳过的安装，就是该 profile 永远不会运行的 linter。

### fail-closed 的提取

对任何它未建模的形态，`extractLintGateSlice` 返回 `null`，调用方随即保留整文件判定：

- 步骤不是 `      - name: '<单引号名称>'` 的形态，包括未命名的 `- uses:` 步骤。该检查在把行追加进当前步骤**之前**执行，因此跟在某个 plumbing 步骤之后的未命名步骤不会被当作该步骤的内容吸收、从而从切片中消失；
- 重复的 job key——YAML 会取最后一份，而 `Map` 会静默保留解析器最后到达的那份；
- 缺少 `jobs:`、`classify_pr` 或 `lint_and_static`，因此给 lint job 改名不会被读成「没有闸门需要比对」；
- 第一个 job key 之前出现既非注释也非空行的内容。

`null` 会抛出而不是返回 `false`，以便既有的 fail-closed catch 输出其 `::warning::`。静默返回 `false` 会让 narrowing 对每个 PR 都失效，而除了一个无人能解释的 stale 判定之外不留任何痕迹。

这里采用行锚定、不使用 YAML 解析器：该测试位于 `HELPER_TESTS_DEP_FREE`，其 import 闭包必须只用 `node:` 内置模块，且该步骤在任何依赖安装之前运行。

### 比对基线是 merge base

两侧分别是 **base tip** 与 **merge base**，而不是 head。比对 head 的切片会因为分支自身的闸门改动而判定失败，并且在它按要求 rebase 之后仍然失败，因为 `main` 要等该分支合入才会带上那次改动。真正要问的是闸门是否在这个分支**下面**移动了，所以分支自己的版本从不进入比对。削弱闸门的分支会由它所修改的那个闸门文件的整文件规则、以及 review 拦住。

merge base 取自该检查**已经做过**的包含比较，因此 narrowing 不额外付出一次比较调用。这是被测量逼出来的结论：在本仓库上新发一次 `GET /compare/main...head` 会返回约 4 MB 的 commits 与 files，对一个真实的一周前分支在 curl 的 30 秒上限处超时。该失败会到达 `main()` 的 fail-open，把其他所有闸门文件的判定一并丢弃——把一个可选的精化变成无条件放行。

复用既有比较不仅便宜，也是正确的。它比较的是 base 侧闸门提交 `S` 与 head；`S` 在 `main` 上且未被包含（判定为 stale），所以它的 merge base 就是该分支从 `main` 的分叉点。万一它解析出的提交比真实分叉点更旧，切片比对会过度拒绝，而那是安全方向。

## 约束

- 只用 Node 内置模块；不使用 YAML 解析器，也不对分支可控文本求值。
- 每个 PR 除两次内容读取外不新增 API 调用，且这两次只在判定已经为 stale 时发生。
- 判定对象的形状不变，因此报告与既有断言仍然成立；比较结果保存在判定旁边，而不是挂在判定上。

## 风险

- **误分类才是真正的风险。** 把某个闸门定义步骤错误地列入 plumbing 会隐藏 base 侧的闸门改动。缓解手段是默认保留规则、linter 调用拒绝，以及测试中的锚点漂移守卫。风险并未消除：任何修改该清单的 PR，review 都必须核对这份清单。
- **本 PR 合入会要求所有在途 PR rebase 一次。** 该检查以整文件包含判定监听自身文件，所以这次修改本身就是一次 base 侧闸门改动——与它引入时造成的那一次性波及相同。
- **锚点漂移。** 破坏行锚点的重排版会让 narrowing 失效。它 fail-closed 并输出告警，且测试读取真实文件，因此漂移会先在这里变红。
- 切片只覆盖 `Lint & Static` lane 的闸门。`test_build` 自带两个静态检查（`check-serve-fast-path-bundle.js`、`check:core-subpath-exports`）；它们的定义与该 job 今天都不在本检查的范围内，本次改动也不扩大范围。

## 验证计划

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs`——60 个用例，含本次新增的 14 个。
2. mutation witness：六个刻意植入的缺陷都必须让测试变红——从 `NARROWINGS` 移除 `ci.yml`、把整个文件当作切片返回、只保留 header、比对 head 而非 merge base、吸收未命名步骤，以及把缺失 merge base 当作 fresh。
3. 针对真实 workflow 的切片完整性：每个 `scripts/lint.js` lane 参数都必须在切片中存活。
4. 真实 API：取十个历史 base tip，各自的分叉点落后一个提交，内容按真实 ref 读取——六个纯 plumbing 提交必须通过，四个改变闸门的提交必须保持 stale。
5. 真实 API 验证触发本次报告的那个分支（#16939 在 `07d89196bd21`）：它必须保持 stale，因为 #16920 确实改了 Prettier lane。

## 验收标准

- 测试通过，且六个 mutation 都能让它变红。
- 最近十三次 `ci.yml` 提交中有六次不再要求 rebase，另外七次仍然要求。
- #16939 的失败被保留。
- 不修改 `ci.yml`、不改 `.size-baseline`、不改 workflow 元测试。

## 待决问题

- `ci.yml` 剩余的失败来自 `HELPER_TESTS` 新增，而它们是真阳性：分支确实跳过了 base 闸门现在会运行的一个套件。唯一诚实的补救是运行 base 的清单而非分支的清单（这意味着在分支的树上执行 base 可控的代码，是这条 lane 刻意回避的信任决定），或者接受这次 rebase。两者本次都未尝试，而移动清单位置不是补救办法。
- 这条 lane 是否应成为 required status check？narrowing 降低了误报，是这件事的前提，但该决定是独立的，且该步骤今天仍是劝告性质。
