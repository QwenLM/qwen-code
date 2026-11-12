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
Recreate runner Git metadata                     Configure npm for rate limiting
Checkout                                         Report npm cache usage (self-hosted)
Verify checkout includes expected head commit    Clean isolated HOME
Select Linux runner                              Dump disk state on failure
Verify trusted classifier checkout is clean      Upload disk-pressure samples
Checkout trusted CI classifier                   Disk floor gate (self-hosted)
```

有两个「加固被 lint 的树」的步骤刻意**不在**名单里：`Restore workspace ownership` 与 `Clean stale .qwen before checkout` 在 checkout 之前清理工作区，而该 job 会运行不可信的 fork 代码。base 侧对其中任一步的加固属于安全修复，必须传导到在途分支；而它们因事故而改、不因路由调整而改，因此留在切片里，像其他闸门改动一样让分支变 stale。

在 job 层面只丢弃 `runs-on` 与 `timeout-minutes`，并连带丢弃它们的整段区域。`env`、`if`、`needs`、`outputs`、`permissions` 与 `steps` 保留：它们决定运行什么，而不是在哪里运行。`needs` 尤其保留，因此 base 侧改动「这条 lane 依赖哪些 job」会被比对到。

**没有任何区域被静默丢弃。** 每一块被排除的内容——每个非闸门 job、每个 plumbing 步骤、每个被丢弃的 job key——都会在比对文本中留下一个 `[[dropped ...]]` 标记，携带类别与名称，并留在该区域原本的位置。`[[...]]` 不是 YAML 注释，因此标记既不会被误当作 prose，也不会与真实行冲突。这才让比对成为**完整**模型而不是「记得建模的部分」的抽样：base 侧把内容挪进被丢弃区域的改动（安装前置步骤拆进新 job、步骤改名成 plumbing 名单里的名字）会改变标记序列，从而拒绝 narrowing。

唯一不进入比对的一类是 prose：block scalar 之外的空白行与整行注释。这是本 narrowing 的前提——`ci.yml` 的改动大多是文字说明——而且 prose 不可能承载闸门语义，因为 runner 从不读取它。它在读取任何结构**之前**用一次前置遍历移除，因此既不能开启步骤、不能被吸收进步骤，也不能截断某个 job。

block scalar 正文正好相反：`run: |` 的内容是 runner 实际执行的脚本，因此逐字比对（空行除外），包括以 `#` 开头的行——那是 shell 注释，不是 YAML 注释。旧模型会丢弃它们，而文件头却声称「绝不会移除 runner 会读取的行」；那句话是假的，现在这类行保留。

行分隔符为 `\r\n`、`\n`、单独的 `\r`，以及 Unicode 分隔符 `\u2028`/`\u2029`。只按 `\n` 切分会把 CR 结尾的文件读成一行，并丢掉 CR 另一侧 `#` 之后的所有内容——这正是 #11117 → #11216 的形态：base 上 flag 被改，分支却被认证为 fresh。

在当前文件上测量，切片为 3560 行中的 624 行，其中 28 行是被排除的 job 与 plumbing 步骤的标记。

### 为什么默认是「保留」

白名单列出的是**可以被忽略**的部分，而不是重要的部分。漏掉对某个新闸门步骤的分类，会让它留在切片里，代价最多是今天的过度拒绝；而白名单里的错误条目会隐藏真实的闸门改动。这种不对称是刻意的，并由两道保护支撑：

- 若白名单中某个步骤的正文调用了 linter，则直接拒绝 narrowing。标签本身不被信任——一个仍在运行 `scripts/lint.js` 的步骤被移入白名单是矛盾，而不是通过。匹配覆盖实际调用的写法：`npm run`、`pnpm run`、`corepack pnpm run`、裸 `pnpm lint`、`npx`/`pnpx`。只锚定 `npm run` 会漏掉所有 `pnpm` 写法，因为 `pnpm` 里 `npm` 前面没有词边界；而管理器后面跟 `config`/`set` 属于配置，仍然通过。
- 测试会读取真实 workflow，要求每个 plumbing 名称都存在于**两个闸门 job** 中，因此步骤改名不会留下一个「静默地什么都没排除」的过期条目。限定范围是必要的：全文件清单会被某个 test lane 里的同名步骤续命，即使闸门 job 里那份已经改名。

Node 供给相关步骤（`setup-node`、pnpm store action、self-hosted Node action）刻意**保留**在切片中：它们决定 linter 运行所用的工具链，因此版本升级可能改变 lint 语义。只排除缓存位置与 npm 重试设置。

安装前置步骤同样保留。#16900 与 #16920 正是扩大了这段前置步骤来补上合入后的 lint 缺口：某个 profile 跳过的安装，就是该 profile 永远不会运行的 linter。

### fail-closed 的提取

这个模型是白名单式的：一行要么被枚举（进入比对，或被标记替换），要么整次提取被拒绝。「不认识就删掉」在这里不存在。对任何它未建模的形态，`extractLintGateSlice` 返回 `null`，调用方随即保留整文件判定：

- 序列项不是 `      - name: '<单引号名称>'` 的形态，包括未命名的 `- uses:` 步骤，以及名字写在下一行的裸 `      -`。该检查在把任何正文追加进当前步骤**之前**执行，因此它不会被当作上一步骤的内容吸收、从而从切片中消失；
- 重复的 job key——YAML 会取最后一份，而 `Map` 会静默保留解析器最后到达的那份；
- 缺少 `jobs:`、`classify_pr` 或 `lint_and_static`，因此给 lint job 改名不会被读成「没有闸门需要比对」；
- job key 不在缩进 2、job 正文行落在任何 key 区域之外、或 `jobs:` 之后出现列 0 的内容——这些是本行模型无法定位的形态；
- 缩进里出现制表符；
- 值位置以 `|` 或 `>` 开头、但修饰符不在枚举之内。两种顺序都是合法 YAML 且都被接受——`|`、`|-`、`|+`、`|2`、`|2-`、`|+2` 以及 `>` 一族。其余（如 `|2+-`）直接拒绝，而不是让正文掉进结构路径、把其中的 `#` 行当作 prose 丢掉；
- 引号标量在该行内未闭合。多行 flow scalar 的续行是 runner 会读取的数据，逐行模型无法把那里的 `#` 与注释区分开，因此拒绝；
- 任何结构行上出现锚点（`&name`）或别名（`*name`）。本模型逐行处理、无法跟随跨行引用：当锚点落在被丢弃的步骤上时，`&lintcmd 'node scripts/lint.js --prettier'` 与 `--write` 两种取值，在引用 `*lintcmd` 的地方会渲染出完全相同的切片。

`null` 会抛出而不是返回 `false`，以便既有的 fail-closed catch 输出其 `::warning::`。静默返回 `false` 会让 narrowing 对每个 PR 都失效，而除了一个无人能解释的 stale 判定之外不留任何痕迹。

这里采用行锚定、不使用 YAML 解析器：该测试位于 `HELPER_TESTS_DEP_FREE`，其 import 闭包必须只用 `node:` 内置模块，且该步骤在任何依赖安装之前运行。

### 比对基线是 merge base

两侧分别是 **base tip** 与 **merge base**，而不是 head。比对 head 的切片会因为分支自身的闸门改动而判定失败，并且在它按要求 rebase 之后仍然失败，因为 `main` 要等该分支合入才会带上那次改动。真正要问的是闸门是否在这个分支**下面**移动了，所以分支自己的版本从不进入比对。

因此分支自身的改动不在本检查范围内，而且**并不是**因为有别的机制兜住：包含判定只读 compare 的 status，从不读它的文件列表，所以一个删掉自己那份 lint 步骤的分支，连整文件规则也照样通过。这是刻意的分工——削弱闸门属于产品决定，由人在 diff 上 review、并由合入后 `main` 上的 lint 变红来兜——而不是机械兜底。

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
- 切片只覆盖 `Lint & Static` lane 的闸门。`test_build` 自带两个静态检查（`check-serve-fast-path-bundle.js`、`check:core-subpath-exports`）；整文件包含时，它们 base 侧的改动曾受覆盖，本次收窄后**不再覆盖**。这是**接受的净缩减**：它们不属于 `Lint & Static` lane，分支在那条 lane 上的绿本来就不依赖它们。
- **接受的残余风险：** `Checkout` 与 `Verify checkout includes expected head commit` 在切片之外。单改 `ref:` 会被抓住：checkout 是 `fetch-depth: 1`，若 ref 指向的不是期望的 head，那个 commit 就不在浅克隆里，校验步骤会 fail-closed 变红。真正不可见的是**成对**改动——`ref:` 指向 merge ref 且 `fetch-depth:` 深到足以包含期望 head：此时守卫通过，lint 却跑在合并树上。合并树包含分支，坏代码不会因此逃逸；代价是归因，而 `Lint & Static` 是 required check，这条 lane 并非 advisory。单独改 `fetch-depth:` 并不会移动被 lint 的树：增量范围的深度由切片内的 `Fetch incremental lint history` 负责，只有它在深度上限内仍无法解析 merge base 时，`lint-scope.js` 才回退到 `full: true`（更宽，不是更窄）。改校验步骤的正文会移除守卫，但不改变被检查的树。
- **接受的残余风险：** `classify_pr` 的 `Checkout trusted CI classifier` 属同一类——checkout 被排除，而真正选择 profile 的步骤保留在切片内。
- **接受的残余风险：** job 级的 `runs-on` 与 `timeout-minutes` 被丢弃。routing 可以经 self-hosted Node action 间接改变 linter 的运行时；收紧 timeout 会在合入后打红 `main`，而不是打红分支。
- **接受的残余风险：** `.github/actions/**` 不在 `GATE_FILES` 中。保留步骤对本地 action 的引用在切片内，但 action 的实现不在，因此 base 侧对该实现的改动对本检查不可见——这是本 PR 之前就存在的缺口，留待 follow-up。
- **接受的残余风险：** 缓存相关的 plumbing 在切片之外。本 lane 的 `Create isolated HOME` 导出 `COREPACK_HOME` 与 `XDG_CACHE_HOME`，别处的 `Configure persistent npm cache (self-hosted)` 导出 `NPM_CONFIG_CACHE`。若 base 侧改动把 corepack 的 home 指向共享目录，就形成本检查看不见的缓存投毒通道——每次运行独立 home 正是为阻断它。
- **接受的残余过度拒绝：** `jobs:` 之上的内容整体保留，因此 base 侧对 `on:` 或 `concurrency:` 的改动仍会让所有在途 PR 变 stale，尽管它不可能改变 lint 检查什么。把这段前置内容收窄到只有 `env` 也能消掉这些红，但它同时承载 `permissions` 与 `defaults.run.shell`，而这两者确实会改变每个步骤的行为。刻意留在安全方向。

- **接受的过度拒绝：job 名单。** 每个非闸门 job 都会在比对文本中留下名字，因此 base 侧新增、删除或改名一个 job 都会拒绝 narrowing，哪怕它的内容碰不到 lint 闸门。另一种做法——不加痕迹地丢弃这些 job——正是标记要消除的暴露面：把安装前置步骤拆进新 job 时，两个闸门 job 看起来完全相同。job 名单的变动比步骤变动稀少，所以代价是偶尔一次 rebase，而不是本 narrowing 要消除的每周跑步机。
- **残余风险：依赖闭包。** `needs:` 会被比对，因此 base 侧改动「这条 lane 依赖哪些 job」可见。但提取器不走依赖图：若 lint job 将来 `needs:` 某个非闸门 job，那个 job 的内容会被丢弃，而它的名字与 `needs:` 条目却完全相同。今天不存在这样的边——lint job 只依赖 `classify_pr`，它本身在切片内——一旦新增这种依赖，这个洞就会生效，因此闸门 job 名单与这条 lane 的 `needs:` 必须一起读。

## 验证计划

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs`——81 个用例全绿，数字取自本修订上 `node --test` 的运行时计数（`main` 为 47，本 PR 增加 34）。CI 通过 `Run .github/scripts helper tests` 在 Linux 上佐证这一点，该步骤从 `${{ env.HELPER_TESTS }}` 收集本测试。此处的计数一律是「某个具名修订上的运行时计数」，不是跨评审轮累加的账。
2. mutation witness：八个刻意植入的缺陷都必须让测试变红——从 `NARROWINGS` 移除 `ci.yml`、把整个文件当作切片返回、只保留 header、比对 head 而非 merge base、吸收未命名步骤、把缺失 merge base 当作 fresh、去掉 linter 检查而只信任 plumbing 标签，以及把 job `env` 从切片中移除。
3. 模型完备性 witness，每个对应一种「旧的行吸收模型会比对成相同」的形态：裸 `-` 步骤、步骤清单头部与步骤之间的注释、`run: |` 正文里以 `#` 开头的行、放在 `steps:` 之后的 job 级 key、只用一个 CR 隐藏被改 flag 的换行、以及锚点定义在被丢弃 job 而别名被保留步骤引用。每一例都必须返回 `null` 或不同的切片，且去掉对应守卫时该例变红。
4. job 名单本身进入比对：base 侧新增一个 job 会改变切片，因此「把安装前置步骤拆进新 job、再让闸门 job `needs:` 它」这种形态会拒绝 narrowing。
5. 针对真实 workflow 的切片完整性：每个 `scripts/lint.js` lane 参数都必须在切片中存活。
6. 真实 API：取十三个历史 base tip，各自的分叉点落后一个提交，内容按真实 ref 读取——六个纯 plumbing 提交必须通过，七个改变闸门的提交必须保持 stale。
7. 真实 API 验证触发本次报告的那个分支（#16939 在 `07d89196bd21`）：它必须保持 stale，因为 #16920 确实改了 Prettier lane。

## 验收标准

- 测试通过，且八个 mutation 都能让它变红。
- 最近十三次 `ci.yml` 提交中有六次不再要求 rebase，另外七次仍然要求。
- #16939 的失败被保留。
- 不修改 `ci.yml`、不改 `.size-baseline`、不改 workflow 元测试。

## 待决问题

- `ci.yml` 剩余的失败来自 `HELPER_TESTS` 新增，而它们是真阳性：分支确实跳过了 base 闸门现在会运行的一个套件。唯一诚实的补救是运行 base 的清单而非分支的清单（这意味着在分支的树上执行 base 可控的代码，是这条 lane 刻意回避的信任决定），或者接受这次 rebase。两者本次都未尝试，而移动清单位置不是补救办法。
- 这条 lane 在 `main` 上已经是 required status check：`main` ruleset 的 required contexts 含 `Lint & Static (ubuntu-latest, Node 22.x)`。因此一次误红会挡住合并，而不只是留个注解——这正是 narrowing 的价值所在。
