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

此前样本未覆盖的是 plumbing 这一类，也正是本次改动要解决的部分。以最近十三次 `ci.yml` 提交（而非两个分支）为样本测量，其中七次属于纯 plumbing，现在可以通过。其中 #16551 也在那个样本的 9 次失败之中——所以「9 次中修复 0 次」是所选两个分支的属性，而不是该方法的属性。那个样本中的主要触发源，即 #16200 的全局 ignore 新增，仍属于另一份设计的范围。

这个计数是「某个具名修订上的测量」，不是常量：`main` 前进时窗口会滑动。本文档的两个修订先后报出六次与七次纯 plumbing 通过，原因正是如此，而比对逻辑一次都没改——语料在更晚的 `main` tip 上重取，少了一个改变闸门的提交、多了一个纯 plumbing 提交。下文所有数字背后的语料都在 `main` `2a9c4f8732` 上重取，并连同这个锚点一起报告，不沿用更早修订的数字。

## 修订说明：行模型已被替换

本改动的早期修订比对 `ci.yml` 的**行切片**：四个结构锚点的精确匹配表（`jobs:`、两空格的 job key、`steps:`、`- name: '<name>'`），然后逐行走过 job，追加或丢弃每一行，被排除的区域用 `[[dropped …]]` 标记占位。

评审找到了这个模型关不上的一类：YAML 的合法写法不是有限清单——块标量指示符写在 key 的**下一行**、写在 tag 后面（`run: !!str |`）、或写成 `|2-` 而不是 `|-2`；标量本身是块序列项（`- |`）；多行 flow scalar；任何结构 token 之后的行尾注释；跨文件引用的锚点。每一轮评审都再点出一种写法，而后果完全一样：runner 会读取的内容掉进「prose」分支，从比对文本里被**删除**，于是真实的闸门改动被比对成相同、stale 判定被丢掉、分支被认证为 fresh——正是本检查存在的意义所要阻止的 #11117 → #11216 形态，只是换了个写法抵达。

为每种写法加一条拒绝分支不会收敛，因为输入是一门文法，而模型是一台行扫描器。本修订改为解析文件、比对解析出的闸门，因此比对的是**语义**而不是拼写。现在被拒绝的不再是一串 YAML 拼写，而是一小组关于闸门的结构性事实（缺 job、未命名步骤、指向闸门之外的依赖边）。

## 现状

`findStaleGateFiles()` 对每个闸门文件花两次 API 调用——base 侧最近一次触碰该文件的提交，然后是交换方向的三点比较 `S...head`，其 `ahead`/`identical` 状态表示分支包含该提交。`diverged` 或 `behind` 表示 stale。

`NARROWINGS` 分发表已经为 `eslint.config.js` 与 `.prettierignore` 对 stale 判定做后置过滤：纯粹收缩范围的改动不会使分支失效。不在表中的文件保持整文件包含判定，`ci.yml` 今天就属于这一类。narrowing 路径是 fail-closed 的：抓取或提取失败会保留判定并输出 `::warning::`，因为向上抛出会到达 `main()` 的 fail-open，从而把其他所有闸门文件的判定一并丢弃。

## 目标

- 当 base 侧 `ci.yml` 改动使该文件定义的 lint 闸门在结构上保持相同，不再让分支失败。
- 对任何可能使分支的绿色不再充分的 base 侧改动继续失败，包括 lane 参数、profile 分类器、linter 版本，以及 `HELPER_TESTS` 清单的改动。
- 绝不制造整文件包含判定本来会拒绝的绿色：解析器拒绝的文档，或形状不构成该模型的网关的文档，一律退回今天的判定。

## 范围边界

范围内：`.github/scripts/check-lint-gate-freshness.mjs`、其同目录测试、`.github/workflows/ci.yml` 中的两个步骤、钉住这两个步骤位置的两个 workflow 元测试（`scripts/tests/sdk-java-workflow.test.js`、`scripts/tests/ci-platform-lanes.test.js`），以及这份双语文档。

与早期修订不同，`ci.yml` **确实被修改**。两处改动都由解析器逼出来，都不改变闸门检查什么：

- `Check lint gate freshness` 从 `Install dependencies` 之前移到之后。它用 `yaml` 包解析文件，而该包要等依赖安装完才存在。它的 `if:` 表达式、profile 门控与 `::warning::` 文案一律不变——**只改位置**。
- 新增 `Run lint gate freshness tests` 步骤，在 `github_ci_only` profile 上运行本测试套件——安装前的 helper 电池已经装不下它（见「测试套件在哪里运行」）。

明确不在范围内：

- `GATE_FILES` 不变；`ci.yml` 仍在清单上，其包含判定仍然先行计算。
- 其余八个闸门文件保持既有行为，包括那两处范围 narrowing。它们的测试没有被本修订触碰。
- 不解决 `HELPER_TESTS` 的跑步机；而且与 plumbing 不同，它不是误报。追加一个套件是增加了这条 lane 必须执行的工作；缺少该条目的分支从未运行过那个套件，所以它的绿色确实更弱。把清单移到独立文件只会把同一个判定换个位置，并不能消除 rebase，因此这**不**作为后续建议提出。
- `main()` 的 fail-open 策略不变。

## 方案

新增第三个 `NARROWINGS` 条目 `narrowsToUnchangedLintSlice`，它比对解析出的闸门文档，而不是 ignore 条目之间的序关系。

### 闸门文档

`lintGateDocument(text)` 用 `parseDocument(text, { uniqueKeys: true })` 解析，返回一个普通对象，包含：

1. 除 `jobs:` 之外的所有顶层 key——触发条件、`concurrency`、`permissions`、`defaults`，以及 workflow 级 `env`，`ACTIONLINT_VERSION`、`SHELLCHECK_VERSION`、`YAMLLINT_VERSION` 和两个 `HELPER_TESTS` 清单都在那里。
2. `classify_pr` 的全部内容。它选择 CI profile，而 profile 选择运行哪些 linter，所以尽管是另一个 job，它仍属于闸门定义。其 4 个步骤保留（它的 checkout 属于 plumbing）。
3. `lint_and_static`，去掉下述 plumbing：43 个步骤中保留 32 个。

其余全部丢弃——整个 workflow 13 个 job 中的 11 个，每个 test、build 与 E2E lane。

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

在 job 层面只丢弃 `runs-on` 与 `timeout-minutes`。`env`、`if`、`needs`、`outputs`、`permissions` 与 `steps` 保留：它们决定运行什么，而不是在哪里运行。`needs` 尤其保留，因此 base 侧改动「这条 lane 依赖哪些 job」会被比对到——而指向闸门 job 名单之外的边会拒绝 narrowing，而不是被跟随，因为该模型不走依赖图。

### 被拒绝的形态

`lintGateDocument` 在文档不是它愿意背书的闸门时返回 `null`，调用方随即保留整文件判定：

- 解析器报错，包括重复 key（`uniqueKeys`）；
- 没有 `jobs:` 映射，或两个闸门 job 之一缺失/不是映射，因此给 lint job 改名不会被读成「没有闸门需要比对」；
- 步骤不是映射，或没有 `name`——未命名步骤无法与白名单匹配，也就无法说明它做什么；
- 同一 job 里两个步骤同名，丢弃/保留的区分因此有歧义；
- 某个 plumbing 步骤自身的内容调用了 linter：标签与正文矛盾，于是拒绝而不是放行（见下文）；
- 闸门 job 的 `needs:` 指向闸门名单之外的任何 job。

`null` 会抛出而不是返回 `false`，以便既有的 fail-closed catch 输出其 `::warning::`。静默返回 `false` 会让 narrowing 对每个 PR 都失效，而除了一个无人能解释的 stale 判定之外不留任何痕迹。

两侧以文本比对：`extractLintGateSlice` 用 `canonical()` 序列化闸门——对象 key 排序、不写空白——因此两个文档相等恰好等价于两侧闸门结构相等。对当前文件，被比对的载荷是 34,534 字节。

### 为什么默认是「保留」

白名单列出的是**可以被忽略**的部分，而不是重要的部分。漏掉对某个新闸门步骤的分类，会让它留在切片里，代价最多是今天的过度拒绝；而白名单里的错误条目会隐藏真实的闸门改动。这种不对称是刻意的，并由三道保护支撑：

- 若白名单中某个步骤的内容调用了 linter，则直接拒绝 narrowing。标签本身不被信任——一个仍在运行 `scripts/lint.js` 的步骤被移入白名单是矛盾，而不是通过。匹配覆盖实际调用的写法：`npm run`、`pnpm run`、`corepack pnpm run`、裸 `pnpm lint`、`npx`/`pnpx`，以及 `node --test`（它本身也是闸门）。只锚定 `npm run` 会漏掉所有 `pnpm` 写法，因为 `pnpm` 里 `npm` 前面没有词边界。管理器与子命令之间的参数同样被跳过，理由相同：`pnpm -w run lint` 与 `pnpm --filter ./packages/core run lint` 走的是同一条 lane。管理器后面跟 `config`/`set` 属于配置，仍然通过——`npm config set fetch-retries 5` 是真实的 plumbing 步骤，拒绝它会让 narrowing 对每个 PR 都失效。这项检查跑在步骤的**规范形式**上，所以无论它怎么写、怎么排版都看得见内容。
- 测试会读取真实 workflow，要求每个 plumbing 名称都存在于**两个闸门 job** 中，因此步骤改名不会留下一个「静默地什么都没排除」的过期条目。限定范围是必要的：全文件清单会被某个 test lane 里的同名步骤续命，即使闸门 job 里那份已经改名。
- 丢掉非闸门 job 就等于把它从比对文本里移除，所以本模型不再需要行模型那套名单标记。它们原本承载的保护现在由管线本身承担：把某个 job 重新归类为非闸门是对 `CI_GATE_JOBS` 的一行修改，评审看得见；而标记当初正是为「安装前置步骤拆进新 job、闸门 job 再 `needs:` 它」这个形态引入的，现在由 `needs:` 拒绝覆盖。

Node 供给相关步骤（`setup-node`、pnpm store action、self-hosted Node action）刻意**保留**在切片中：它们决定 linter 运行所用的工具链，因此版本升级可能改变 lint 语义。只排除缓存位置与 npm 重试设置。

安装前置步骤同样保留。#16900 与 #16920 正是扩大了这段前置步骤来补上合入后的 lint 缺口：某个 profile 跳过的安装，就是该 profile 永远不会运行的 linter。

### 为什么用解析器，代价是什么

本 narrowing 做出的是关于一份 YAML 文档的**相等**断言。任何基于行的模型都必须枚举文档的写法才能做出这个断言，而这种枚举是开放的——四轮评审因此得到四种写法，且四种都比对成相同。解析器消掉的是这一类，而不是逐个实例：锚点会被解析、flow scalar 会被拼接、块标量带着自己的正文，注释与排版在比对发生的那一刻已经不存在。两个文档相等，恰好等价于 runner 会看到同一个闸门。

三项代价，都被接受：

- **测试套件需要 `yaml`。** 它离开 `HELPER_TESTS_DEP_FREE`（该桶的 import 闭包必须只用 `node:` 内置模块），加入 `HELPER_TESTS`。在 `full` profile 上仍是同一个电池，只是排在安装之后。
- **检查改在 `Install dependencies` 之后运行。** stale 的分支现在要先付一次安装才知道要 rebase。这是延迟代价，不是正确性代价：安装在三个 profile 上本来就都跑，因此没有任何 profile 增减覆盖，而该检查仍然排在它能使其变得多余的 lint lane 之前。
- **`docs_only` 仍然不运行本套件。** 这点不变——它原先所在的安装前电池本来就只在 `github_ci_only` 上跑。

### 测试套件在哪里运行

| Profile          | 之前                                               | 之后                                      |
| ---------------- | -------------------------------------------------- | ----------------------------------------- |
| `full`           | `Run .github/scripts helper tests`（安装后）       | 同一步骤，`HELPER_TESTS`（安装后）        |
| `github_ci_only` | `GitHub CI helper checks`（安装前，dep-free 电池） | `Run lint gate freshness tests`（安装后） |
| `docs_only`      | 从不                                               | 从不                                      |

中间那一行正是新步骤的意义：修改本脚本的 PR 最常被分类成 `github_ci_only`，而安装前的电池已经装不下一个 import `yaml` 的套件。没有这个专门步骤，最相关的 profile 会停止执行本套件。

### 比对基线是 merge base

两侧分别是 **base tip** 与 **merge base**，而不是 head。比对 head 的闸门会因为分支自身的闸门改动而判定失败，并且在它按要求 rebase 之后仍然失败，因为 `main` 要等该分支合入才会带上那次改动。真正要问的是闸门是否在这个分支**下面**移动了，所以分支自己的版本从不进入比对。

因此分支自身的改动不在本检查范围内，而且**并不是**因为有别的机制兜住：包含判定只读 compare 的 status，从不读它的文件列表，所以一个删掉自己那份 lint 步骤的分支，连整文件规则也照样通过。这是刻意的分工——削弱闸门属于产品决定，由人在 diff 上 review、并由合入后 `main` 上的 lint 变红来兜——而不是机械兜底。

merge base 取自该检查**已经做过**的包含比较，因此 narrowing 不额外付出一次比较调用。这是被测量逼出来的结论：在本仓库上新发一次 `GET /compare/main...head` 会返回约 4 MB 的 commits 与 files，对一个真实的一周前分支在 curl 的 30 秒上限处超时。该失败会到达 `main()` 的 fail-open，把其他所有闸门文件的判定一并丢弃——把一个可选的精化变成无条件放行。

复用既有比较不仅便宜，也是正确的。它比较的是 base 侧闸门提交 `S` 与 head；`S` 在 `main` 上且未被包含（判定为 stale），所以它的 merge base 就是该分支从 `main` 的分叉点。万一它解析出的提交比真实分叉点更旧，切片比对会过度拒绝，而那是安全方向。

## 约束

- Node 内置模块加上 `yaml` 包，后者已是根依赖（`^2.8.1`，lockfile 解析为 `2.9.0`）；不对分支可控文本求值，不新增依赖。
- 每个 PR 除两次内容读取外不新增 API 调用，且这两次只在判定已经为 stale 时发生。
- 判定对象的形状不变，因此报告与既有断言仍然成立；比较结果保存在判定旁边，而不是挂在判定上。

## 风险

- **误分类才是真正的风险。** 把某个闸门定义步骤错误地列入 plumbing 会隐藏 base 侧的闸门改动。缓解手段是默认保留规则、linter 调用拒绝、`needs:` 拒绝，以及测试中的锚点漂移守卫。风险并未消除：任何修改该清单的 PR，review 都必须核对这份清单。
- **闸门 job 名单只是一个常量。** `CI_GATE_JOBS` 指定被比对的两个 job。新增一个同样定义闸门的 job——第二个 lint job、拆成两个的 profile 分类器——在更新该名单之前是不可见的。接受：该名单就是 plumbing 白名单旁边的一行，而 base 侧对它的改动本身就是一次 `GATE_FILES` 改动。
- **一个解析器依赖进入了 required check。** `yaml` 出现回归、或 lockfile 状态下该模块缺失，会让 `extractLintGateSlice` 抛错、catch 输出 `::warning::`——narrowing 停止生效，每个 base 侧 `ci.yml` 提交又会要求 rebase。方向是 fail-safe 而非造绿，而且这条 lane 会在 import 处就变红，不会静默通过。
- **比对解析后的值意味着排版不在断言之内。** base 侧只重排 `ci.yml`、或调整 key 顺序与 `HELPER_TESTS` 条目顺序的提交会比对成相同并通过。这正是意图：runner 不读这些。代价是评审者不能靠本检查得知文件被动过，只能得知它的闸门被动过。
- **YAML merge key（`<<`）按原样比对，不展开。** `ci.yml` 中没有这种写法；若出现，被锚定的映射仍会经由该 key 的值进入比对文本，所以其中的 base 侧改动可见，但合并本身未被建模。如实说明，不做处理。
- **本 PR 合入会要求所有在途 PR rebase 一次。** 该检查以整文件包含判定监听自身文件，所以这次修改本身就是一次 base 侧闸门改动——与它引入时造成的那一次性波及相同。
- 切片只覆盖 `Lint & Static` lane 的闸门。`test_build` 自带两个静态检查（`check-serve-fast-path-bundle.js`、`check:core-subpath-exports`）；整文件包含时，它们 base 侧的改动曾受覆盖，本次收窄后**不再覆盖**。这是**接受的净缩减**：它们不属于 `Lint & Static` lane，分支在那条 lane 上的绿本来就不依赖它们。
- **接受的残余风险：** `Checkout` 与 `Verify checkout includes expected head commit` 在切片之外。单改 `ref:` 会被抓住：checkout 是 `fetch-depth: 1`，若 ref 指向的不是期望的 head，那个 commit 就不在浅克隆里，校验步骤会 fail-closed 变红。真正不可见的是**成对**改动——`ref:` 指向 merge ref 且 `fetch-depth:` 深到足以包含期望 head：此时守卫通过，lint 却跑在合并树上。合并树包含分支，坏代码不会因此逃逸；代价是归因，而 `Lint & Static` 是 required check，这条 lane 并非 advisory。单独改 `fetch-depth:` 并不会移动被 lint 的树：增量范围的深度由切片内的 `Fetch incremental lint history` 负责，只有它在深度上限内仍无法解析 merge base 时，`lint-scope.js` 才回退到 `full: true`（更宽，不是更窄）。改校验步骤的正文会移除守卫，但不改变被检查的树。
- **接受的残余风险：** `classify_pr` 的 `Checkout trusted CI classifier` 属同一类——checkout 被排除，而真正选择 profile 的步骤保留在切片内。
- **接受的残余风险：** job 级的 `runs-on` 与 `timeout-minutes` 被丢弃。routing 可以经 self-hosted Node action 间接改变 linter 的运行时；收紧 timeout 会在合入后打红 `main`，而不是打红分支。
- **接受的残余风险：** `.github/actions/**` 不在 `GATE_FILES` 中。保留步骤对本地 action 的引用在切片内，但 action 的实现不在，因此 base 侧对该实现的改动对本检查不可见——这是本 PR 之前就存在的缺口，留待 follow-up。
- **接受的残余风险：** 缓存相关的 plumbing 在切片之外。本 lane 的 `Create isolated HOME` 导出 `COREPACK_HOME` 与 `XDG_CACHE_HOME`，别处的 `Configure persistent npm cache (self-hosted)` 导出 `NPM_CONFIG_CACHE`。若 base 侧改动把 corepack 的 home 指向共享目录，就形成本检查看不见的缓存投毒通道——每次运行独立 home 正是为阻断它。
- **接受的残余过度拒绝：** `jobs:` 之上的内容整体保留，因此 base 侧对 `on:` 或 `concurrency:` 的改动仍会让所有在途 PR 变 stale，尽管它不可能改变 lint 检查什么。把这段前置内容收窄到只有 `env` 也能消掉这些红，但它同时承载 `permissions` 与 `defaults.run.shell`，而这两者确实会改变每个步骤的行为。刻意留在安全方向。
- **接受的过度拒绝：依赖闭包。** `needs:` 会被比对，因此 base 侧改动「这条 lane 依赖哪些 job」可见。该模型仍然不走依赖图，但改为拒绝这条边而不是跟随它：闸门 job 一旦 `needs:` 闸门名单之外的任何 job，就返回 null、保留整文件包含判定。没有这条拒绝时，那个洞是静默且永久的——把安装前置拆进新 job 会让所有在途 PR stale 一次（这是对的），此后该 job 内部的每次改动都比对相等，因为 job 被丢弃、而它的名字与 `needs:` 条目完全相同。今天不存在这样的边（lint job 只依赖 `classify_pr`，它本身在切片内），所以这条拒绝当前零成本，并且恰好在切片不再等于整个闸门时触发。列表的三种 YAML 写法——内联、单引号、块式——都被覆盖，因为解析会把它们归一成同一个值。扩充闸门 job 名单与读这条 lane 的 `needs:` 仍然必须一起做；区别在于现在忘记了是过度拒绝，而不是错误认证。

## 测试套件账目

套件共 1,489 行 / 69 个用例。评审要求重写时删掉行模型的拼写夹具而不动行为覆盖；以下是它停在哪里的账，以及为什么没有更小。

| 修订                                 | 行数  | 用例数 |
| ------------------------------------ | ----- | ------ |
| 本 PR 之前的 `main`                  | 962   | 47     |
| 本 PR 更早的修订（行模型、拼写夹具） | 2,009 | 83     |
| **本修订**                           | 1,489 | 69     |

69 个用例里，22 个针对 `ci.yml` 闸门文档、其接线与共享的判定 pin；其余 47 个是 `eslint.config.js` 与 `.prettierignore` narrowing 的行为覆盖，由更早的评审轮次要求，本重写没有触碰。两组用例在同一个文件里交错，所以删掉的行无法按组归属——可分离的是用例数，不是行数。

拼写夹具已经删掉：17 行块标量修饰符表、行吸收模型的六条形态 witness（裸 `-` 步骤、步骤之间的注释、run 正文里以 `#` 开头的行、放在 `steps:` 之后的 job key、只用单个 CR 隐藏被改 flag、锚点/别名对），以及随机制一起消失的 `[[dropped …]]` 标记断言。脚本本身从 975 行降到 751 行，那是解析式文档模型加上解释「为什么用解析器替换行扫描器」的头部注释。

**相对更早的修订，总量为 −26%，不是 −50%**，因为剩下的不是拼写：69 个用例中 47 个是更早评审轮次要求的 narrowing 行为覆盖，为凑数字去删除或合并它们，等于用无关覆盖的损失来换一个模型改动。那次裁剪需要单独的评审，所以不在本修订做。相对 `main`，套件是 +527 行 / +22 个用例，全部是 `main` 本来没有的 `ci.yml` 模型。

## 验证计划

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs` —— 本修订上 **69 个用例全绿**（`main` 为 47，本 PR 增加 22）。CI 通过 `Run .github/scripts helper tests`（`full`）与 `Run lint gate freshness tests`（`github_ci_only`）在 Linux 上佐证。此处的计数一律是「某个具名修订上的运行时计数」，不是跨评审轮累加的账。
2. mutation witness：八个刻意植入的缺陷都必须让测试变红。以下为在本修订上逐个单独施加的实测结果：

   | 变异                                   | 结果         |
   | -------------------------------------- | ------------ |
   | 从 `NARROWINGS` 移除 `ci.yml`          | 红，5 个失败 |
   | 把整个文件当作切片返回                 | 红，12       |
   | 只保留步骤 header                      | 红，7        |
   | 比对 head 而非 merge base              | 红，5        |
   | 吸收未命名步骤而不是拒绝               | 红，2        |
   | 把缺失 merge base 当作 fresh           | 红，1        |
   | 去掉 linter 检查而只信任 plumbing 标签 | 红，1        |
   | 把 workflow `env` 从切片中移除         | 红，2        |

   另有五条 witness 针对本修订新增的套件步骤。每条都单独施加在真实 `ci.yml` 上，先确认本修订变红、上一修订仍绿，再还原：

   | 对 `Run lint gate freshness tests` 的变异      | 结果         |
   | ---------------------------------------------- | ------------ |
   | 去掉 `github_ci_only` 这个 profile 分支        | 红，1 个失败 |
   | 把 run 行指向另一个套件                        | 红，1        |
   | 加上 `continue-on-error: true`                 | 红，1        |
   | 把它移回 `Install dependencies` 之前           | 红，1        |
   | 在它的 run 行后追加 `\|\| true`（或 `\|\| :`） | 红，1        |

3. 与被替换的行模型做等价对照：取十三个历史 `ci.yml` 提交，父提交作为分叉点，内容按真实 ref 读取。两个模型跑在同一对上；`旧`/`新` 是 stale/fresh 判定，两列拒绝表示该侧是否对这一对返回了 `null`：

   | tip          | parent       | 行模型 | 解析器 | 旧侧拒绝 | 新侧拒绝 |
   | ------------ | ------------ | ------ | ------ | -------- | -------- |
   | `4a03945f9a` | `441bd9abe1` | fresh  | fresh  | 否       | 否       |
   | `51c8b617c0` | `e58bf09add` | fresh  | fresh  | 否       | 否       |
   | `e58bf09add` | `92b9f6df3b` | fresh  | fresh  | 否       | 否       |
   | `71193fe367` | `6a999b20b7` | stale  | stale  | 否       | 否       |
   | `4a69cf2eb5` | `031c6e80af` | stale  | stale  | 否       | 否       |
   | `e8061d4937` | `138185d781` | fresh  | fresh  | 否       | 否       |
   | `2aac39a17b` | `2a191acfce` | fresh  | fresh  | 否       | 否       |
   | `0dd106d42f` | `c73a98951f` | stale  | stale  | 否       | 否       |
   | `65e1f1aeaa` | `1feab51dd7` | fresh  | fresh  | 否       | 否       |
   | `708ba347d3` | `d85e911c78` | stale  | stale  | 否       | 否       |
   | `8660f75430` | `ad83860092` | fresh  | fresh  | 否       | 否       |
   | `7cb46d9fed` | `e61ad3959e` | stale  | stale  | 否       | 否       |
   | `1b1f4455d9` | `1d64177286` | stale  | stale  | 否       | 否       |

   Summary：**13/13 判定一致，七个 fresh、六个 stale，两侧都没有拒绝任何一对。** 语料在 `main` `2a9c4f8732` 上重取，而不是沿用本文档更早修订的那一批，这就是七/六的划分与该处报告的六/七不同的原因：窗口里进来了 #16945 那个纯 plumbing 的重试提交，走了一个改变闸门的提交。同一批 tip 上判定逐点相同，所以差异是语料漂移，不是两个模型互相矛盾。

4. 模型完备性 witness，每个对应一条拒绝：重复步骤名、重复 job key、缺失闸门 job、指向闸门 job 之外的 `needs:` 边、无法解析的 YAML、未命名步骤、以及调用 linter 的 plumbing 步骤。去掉对应守卫会让该用例变红。
5. 针对真实 workflow 的切片完整性：每个 `scripts/lint.js` lane 参数与两个 `HELPER_TESTS` 清单都必须在切片中存活，且每个 plumbing 名称都存在于两个闸门 job 中。
6. 真实 API 验证触发本次报告的那个分支（#16939 在 `07d89196bd21`）：它必须保持 stale，因为 #16920 确实改了 Prettier lane。

## 验收标准

- 测试通过，且十三个 mutation 都能让它变红——模型上的八个，加上套件步骤接线上的五个。
- 十三个历史 `ci.yml` 提交中，十三个都从解析器得到的 stale-or-fresh 判定与被替换的行模型相同，且两侧都没有拒绝任何一对。
- 在 `main` `2a9c4f8732` 上，其中七次不再要求 rebase，另外六次仍然要求。这七次全部属于纯 plumbing，那六次全部都改变了闸门。
- #16939 的失败被保留。
- `ci.yml` 只增加一个步骤、移动一个步骤，且两者都不改变它定义的闸门——被比对的那份文档。freshness 步骤保持其 `if:`、profile 门控与 `::warning::` 文案。

## 回退预案

重写之前的 head 是 `fc5d814aca`：行模型、它的拼写夹具、`[[dropped …]]` 标记，以及 freshness 步骤位于安装之前的 `ci.yml`。本修订是它之上的单个提交，所以回退是 revert 而不是 rebase：

```
git revert <the rewrite commit>
git push
```

这会精确恢复行模型，包括本修订移动过的 `ci.yml` 接线，分支的检查针对回退后的树重新计算。回退不创建 tag 或分支，因此仓库层面没有任何 ref 指向被取代的模型；上面这个 SHA 与这一段就是记录。

## 待决问题

- `ci.yml` 剩余的失败来自 `HELPER_TESTS` 新增，而它们是真阳性：分支确实跳过了 base 闸门现在会运行的一个套件。唯一诚实的补救是运行 base 的清单而非分支的清单（这意味着在分支的树上执行 base 可控的代码，是这条 lane 刻意回避的信任决定），或者接受这次 rebase。两者本次都未尝试，而移动清单位置不是补救办法。
- 这条 lane 在 `main` 上已经是 required status check：`main` ruleset 的 required contexts 含 `Lint & Static (ubuntu-latest, Node 22.x)`。因此一次误红会挡住合并，而不只是留个注解——这正是 narrowing 的价值所在。
