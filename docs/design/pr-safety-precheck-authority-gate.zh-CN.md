# PR 安全预检：权限面闸口

[English](pr-safety-precheck-authority-gate.md) | [简体中文](pr-safety-precheck-authority-gate.zh-CN.md)

状态：2026-11-25 已实现并在本地验证完成。「范围之外」一节所述的 runner 侧凭据加固不属于本次改动。

## 问题陈述

2026-11-25，同一作者用两个 fork PR 探测了评审外部贡献的自动化流程。两个 PR 都在开启后数分钟内由作者本人关闭。

- #18362 修改了 `.github/scripts/check-disk-floor.sh`——CI 在检出 PR head **之后**执行的脚本。新增函数导出进程环境，并遍历阿里云与 AWS 实例元数据端点以取 RAM/IAM 角色凭据。
- #18364 新增 `docs/runner-preflight.md`，并在 PR 正文里指示评审 agent 用其 shell 工具逐条执行所列命令、把原始输出**逐字**贴进公开评论。清单包含 `/proc/self/environ` 与同样的元数据端点。

两个载荷都不点名任何 GitHub secret。第一个的目标是 runner 主机**环境自带**的凭据；第二个的目标是评审器本身。

## 现状

以下三条观测均在这两个 PR 上实测。

1. **人工 fork 审批闸口不覆盖被攻击的 workflow。**
   GitHub 的「Approve workflows to run」设置作用于来自 fork 的 `pull_request` 事件。`pull_request_target` 跑的是基线分支的定义、带基线仓库权限，天然豁免。两个 PR 上，`pull_request_target` 的 triage 与 review workflow 都在 PR 开启后**一秒内**起跑，而 `pull_request` 的 CI run 记录到**零个 job**。依赖维护者点对按钮，守住的是没被攻击的那条车道；而且仍然依赖人去识别一段措辞为「read-only diagnostics」的载荷。

2. **既有代码级预检对两个载荷全部放行。**
   `.github/scripts/pr-safety-precheck.mjs` 对两者都返回 `allow_triage`，`reason_codes` 为空数组。它的规则是一张黑名单，把 JavaScript 的日志或网络 sink 与**具名** secret 引用（`secrets.*`、`process.env.*_API_KEY`、`GITHUB_TOKEN`）配对。bash 的 `echo` 不是 sink，环境凭据源不是具名 secret，而注入措辞规则只匹配「ignore previous instructions」这类已知短语。预检也从不看 PR 改了哪些路径。

3. **被截断的 diff 会被报成干净的。**
   `.github/workflows/qwen-pr-safety-precheck.yml` 把 `gh pr diff` 接到 `head -c 2MiB`，并容忍由此产生的 SIGPIPE 状态码。因此放在上限之后的载荷从未被扫描。已验证：一条现有规则**确实能抓**的载荷（`sensitive_diff:secret_network`），一旦用填充把它推过 2 MiB 就翻成 `allow_triage`。

仓库自己已经记录了底层暴露面，见 `.github/workflows/qwen-code-pr-review.yml`：「a prompt-injected agent with arbitrary code execution already holds the job's PAT, network and unsandboxed shell.」

## 目标

- 依据 PR **能触达什么**来判准入，而不是依据其措辞是否命中已知坏词。
- 在 agent 起跑**之前** fail closed，落在已经控制 agent 准入的那道闸口上。
- 判定可仅凭 PR 本身复现，便于维护者重跑。

## 范围边界

范围之内：`.github/scripts/pr-safety-precheck.mjs`、其同址测试，以及 `.github/workflows/qwen-pr-safety-precheck.yml` 的 diff 采集步骤。

范围之外，但要让整类攻击失效仍然必须做：

- CI runner 实例**不挂 RAM 角色**，或加固实例元数据服务使容器内不可达。一次性 runner 不等于无凭据 runner，容器隔离也不等于凭据隔离。
- 给评审 agent 配默认拒绝的出网白名单。现有 `configure_qwen_network` 辅助函数是**给模型 host 做 proxy bypass**，不是出网限制。
- agent 撰写的评论正文在发布前做脱敏。

## 方案

给预检加三项，全部只对**无 write 权限**的作者生效。

### 1. 权限面路径

改动「决定 CI 执行什么」或「agent 把什么当指令读」的路径，产出 `protected_path:authority_surface`。

目录前缀：`.github/`、`.agents/`、`scripts/`、`.qwen/skills/`、`.qwen/commands/`、`.qwen/agents/`、`.qwen/workflows/`、`.qwen/extensions/`、`.qwen/scripts/`、`.qwen/rules/`。

任意深度的文件名（上下文文件按层级加载，嵌套副本同样能操纵 agent）：`AGENTS.md`、`QWEN.md`、`QWEN.local.md`、`CLAUDE.md`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.pnpmfile.mjs`。

精确路径：`.qwen/settings.json`。

路径从 diff 推导——这是 workflow 唯一提供的路径来源。`---` 与 `+++` 头各承载一个无歧义路径，因此删除、重命名与含空格的路径都被覆盖；`diff --git` 头另外覆盖 mode-only 改动（这类改动不产出 side 头）。

git 会对含 tab、换行、或（在 `core.quotePath` 下）非 ASCII 字节的路径加引号。被引号包裹的 `.github/...` 不再匹配前缀判定，因此解析器在判定前先去引号。修复前已验证这是**真实绕过**：以 `.github/workflows/evil<TAB>.yml` 新增的文件返回 `allow_triage`。

### 2. 环境凭据源

**源本身就是信号**，不需要与 sink 配对。

| Reason code                          | 匹配                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ambient_credential:cloud_metadata`  | `100.100.100.200`、`169.254.169.254`、`169.254.170.2`、`fd00:ec2::254`、`metadata.google.internal`、`metadata.goog`                                                                                                                                                                        |
| `ambient_credential:proc_environ`    | `/proc/<self\|thread-self\|pid\|$$\|$VAR>[/task/<tid>]/environ`                                                                                                                                                                                                                            |
| `ambient_credential:env_dump`        | 处于命令位置、后接管道／重定向／分隔符／行尾的 `env`、`env -0`、`env --null`、裸 `set`、裸 `export`、`export -p`、裸 `declare`/`typeset` 及其 `-x`/`-p` 形态；`printenv`；以及包在 `bash/sh/zsh/dash -c '…'` 里的导出命令（含 `-lc` 这类组合旗标，以及 `--norc` 这类位于 `-c` 之前的旗标） |
| `ambient_credential:credential_file` | `.aws/credentials`、`.docker/config.json`、`.config/gcloud`、`.kube/config`、`.ssh/id_*`、`.netrc`、`.git-credentials`，以及**仅出现在路径边界处**的 `.credentials`                                                                                                                        |

这些规则作用于 PR 标题、正文与新增行，因此即使 diff 只是一个无害的 docs 文件，仅由正文承载的指令也会被抓到。

两条边界防止规则误拦正常工作。每种导出形态在**两个分支里都**保留终止符前瞻——裸的命令位置分支，以及 shell `-c` 包装分支（它把闭合引号也算作终止符）——因此带选项的前缀两种写法都不被扣住：`set -euo pipefail`、`env FOO=bar cmd`、`env -i FOO=bar node x.mjs`、`declare -x FOO=bar`，以及被包成 `sh -c "set -euo pipefail; make"` 的同样形态。早期版本没给包装分支终止符判据，导致上述每一种被包装后都被扣住；该问题已关闭。

而 `.credentials` 要求前面是路径分隔符、空白、引号或行首。允许集合是**显式枚举而非取反**：像 `[^.\w]` 这样的否定类还会放进 `?` 与 `)`，从而扣住 `a?.credentials`、`(await client).credentials` 这类普通 TypeScript。完全没有边界时，它也会命中对象展开 `{ ...credentials }`，那只是复制内存对象、且出现在普通产品代码里（`packages/channels/msteams/src/ingress.ts`）。以上每一处在修复前都实测为真实误报。

### 3. 截断即 fail closed

采集步骤多读一个字节。**恰好等于上限**的读取与「一个正好这么大的完整 diff」无法区分，所以那多出的一个字节就是截断见证。文件超过上限时步骤输出 `diff_truncated=true`，脚本追加 `input:diff_truncated`。

### 4. 元数据读不到即 fail closed

元数据调用失败时，采集步骤原本用空标题空正文替代、同时保留有效 head SHA。正文本身就是一条载荷通道，所以这种替代等于**静默停止扫描它**：一个带无害 docs diff 的「仅正文」探针，只要该 API 调用失败就重新被放行。现在步骤输出 `metadata_unavailable=true`，脚本追加 `input:metadata_unavailable`。用独立 code 而非复用 `input:diff_unavailable`，因为面向维护者的理由必须说清缺的是哪一份输入。

## 设计决策与理由

**做闸口，不自动关闭。** 关闭 PR 抢不到攻击前面：`pull_request_target` 的 workflow 在一到两秒内起跑，而任何「检测后关闭」的检测器自己也是并行运行的 `pull_request_target` workflow。两个探针 PR 都由作者本人关闭，所以「关闭」正是攻击者已经想要的结果。改为 `manual_required` 则扣住 agent 准入，同时留给维护者用 `@qwen-code /triage` 或 `@qwen-code /review` 显式放行。

**给人看能力事实，不是 diff 散文。** 人工审批评论列出的是 `protected_path:authority_surface` 这样的 reason code。请维护者判断的是「这个 PR 改了 CI 脚本」，而不是去辨读一段人眼会当成例行诊断的恶意措辞。

**保护 agent 指令面，不只保护 `.github`。** #18364 没有改动任何 `.github` 路径，所以「只挡 `.github`」的规则会漏掉它。指令文件一旦被加载就是比 docs 页更强的通道——它进入系统提示，而不是作为证据被阅读。

**路径规则刻意比「今天真正活着的通道」更宽。** 本设计的早期版本声称评审器会从检出的贡献里加载 `QWEN.md` 与 `AGENTS.md`。这在本 head 的评审车道上**不成立，该主张撤回**：review job 检出的是仓库默认分支，而工作区记忆发现受 folder trust 门控（`packages/core/src/memory/memoryDiscovery.ts`），该设置默认 false（`packages/cli/src/config/config.ts`），且 review workflow 从不启用它。项目本地槽位还额外要求隐式发现与已解析的项目根，`.qwen/rules/` 同样需要 folder trust（`packages/core/src/config/rulesDiscovery.ts`）。因此 `QWEN.local.md` 与 `.qwen/rules/` 是**潜在**指令槽而非现行通道。仍然把它们纳入保护：某条车道日后打开 trust（交互式使用的自然配置）时，不能静默扩大外部贡献可注入的面，而让路径清单提前覆盖这一变化成本很低。

**把 `.qwen/` 收窄到承载权限的子目录。** `.qwen/e2e-tests/` 这类工作产物不承载权限；把它们纳入只增加噪声、不减少暴露面。

**保留可信作者短路。** 有 write 权限的作者仍与之前一样绕过全部内容规则。对他们只有「缺少 head SHA」仍会 fail closed。

## 约束

- 预检跑在 `ubuntu-latest`，持只读 token，且只从默认分支检出它自己那份可信脚本。新规则不增加任何网络调用与依赖。
- diff 上限保持 2 MiB。提高上限不能替代 fail closed。
- reason code 属于公开评论契约的一部分；既有 code 未改动。

## 风险

- **误报会拦住合法贡献。** 2026-11-25 取样 80 个开放 PR（当时开放总数 578）：67 个作者无 write 权限，其中 7 个触及受保护路径。该取样**不是全仓比率**。每次命中的代价是维护者显式放行一次，不是拒绝贡献者。
- **仓库自己的夹具就含元数据地址。** `packages/network-policy/src/network-policy.test.ts` 与 `packages/core/src/utils/fetch.test.ts` 含 IMDS 字面量，因此外部 PR 编辑它们会被拦。基于同样的理由接受。
- **非 shell 代码里单独一行的 `set` 会被扣住。** 导出规则无法区分 shell 的 `set` 与独占一行的 `set` 标识符，因此写成 `const {` / `set` / `} = obj` 的解构会被扣住。接受：靠 surrounding 花括号来收窄等于给攻击者一个 trivial 包装，而代价只是维护者放行一次。
- **检测仍属防御纵深。** #18364 表明攻击者无需触碰任何受保护路径。只有「范围之外」的凭据加固才能消除收益。env 导出规则枚举的是 shell 打印环境的那些形态；未被枚举的形态仍会通过——这也是它写成「形态清单」而非「完备性主张」的原因。

## 验证计划

- 单元套件：`node --test .github/scripts/pr-safety-precheck.test.mjs`。
- 真实载荷：用 #18362 与 #18364 捕获的标题、正文、diff 跑脚本，要求 `manual_required`。
- 变异见证：在模块的**临时副本**上逐条移除新规则，要求对应用例转红，并包含一条「整文件回退到改动前模块」的臂。每个臂都必须断言其锚点命中，避免锚点漂移把静默跳过报成击杀。
- workflow 端到端决策表：用打桩 `gh` 驱动**真实的** collect 与 assess `run:` 块并断言最终决策，覆盖上限边界与元数据失败臂。文本钉既验不了数值阈值，也验不了 fail-open 分支。
- 仓库门禁：`prettier --check`、`eslint`、`actionlint`，以及 `node --test .github/scripts/ci/classify-profile.test.mjs`。

## 验收标准

- 两个探针载荷都判 `manual_required`，且各自命中至少两条**独立** reason code。
- 在上限处被截断的 diff 产出 `input:diff_truncated`，即使可见部分干净。
- `env VAR=value command` 前缀不被拦，`set -euo pipefail`、`declare -x FOO=bar`、以及复制 credentials 的对象展开同样不被拦。
- 每一种被枚举的导出形态都被扣住，含组合 shell 旗标与相对路径的 `.credentials` 读取。
- 元数据读取失败产出 `input:metadata_unavailable`，即使 diff 取成功且看起来普通。
- 可信作者不受影响。
- 每个变异臂都被击杀，且无跳过臂。
- 上限边界在「恰好 2 MiB」与「2 MiB 加一字节」两处行为正确。

## 已验证结果（2026-11-26）

- 单元套件：107 通过、0 失败。其中四条驱动**真实 CLI**，使旗标拼写进入被测契约；另有一条从 CLI 源码推导旗标名，并要求 workflow 逐个从 collect 步骤的对应 output 传入。现在任一侧改名都会让套件转红；在加这些用例之前，改名后套件仍全绿而一条 fail-closed 臂已失效。
- #18362：`protected_path:authority_surface`、`ambient_credential:cloud_metadata`、`ambient_credential:env_dump`。
- #18364：`ambient_credential:cloud_metadata`、`ambient_credential:proc_environ`。
- 变异见证：28 个臂，全部击杀，无跳过。其中九个臂是把规则**放宽或收窄**而非移除，因此误报与漏报两个方向都被钉住；两个臂改 CLI 旗标拼写；另有两个臂做整文件回退，分别回到第一轮加固与 PR 前的模块。
- workflow 端到端决策表：9 个用例通过。它用打桩 `gh`、在步骤自身的 bash 契约下执行**真实的** collect 与 assess `run:` 块，断言最终决策而非中间旗标。覆盖恰好等于上限、上限加一、diff 调用失败、可信作者，以及「敌意正文 + 元数据调用成功／失败」两臂。
- `prettier --check`、`eslint`、`actionlint`：干净。`eslint` 与 `actionlint` 均先用一个故意非法的输入证明过是活的。
- `classify-profile.test.mjs`：27 通过、0 失败。
- `scripts/tests/qwen-autofix-workflow.test.js`：57 失败、287 通过、13 跳过——把本次改动 stash 后计数相同，且 57 条失败用例名**集合完全一致**。每条失败都是该 harness 自己的临时 `typescript.cjs` 的 `ENOENT`，属 worktree 前置缺口，与本改动无关。

三条既有用例原先断言「放行不可信作者对 `.github` 与 `scripts/` 的改动」。它们被**改靶**到新策略而非删除；另有一条夹具被修正为携带真实 diff 头，使其真正走到路径规则而不是空过。

第一个提交经评审后进行了第二轮：关闭四条被报告的缺口（缺失的导出形态、无锚点的 `.credentials`、两个潜在指令槽、元数据 fail-open），并撤回上文那条被纠正的上下文加载理由。随后对该轮做对抗审计，又在**该轮自身的修复里**发现三个问题，现均已关闭并钉住：组合 shell 旗标（`bash -lc "env"`）仍被放行；新的 `.credentials` 边界引入了**回归**——不再匹配相对路径的 `cat .credentials`；以及非 shell 代码里单独的 `set` 标识符会被扣住，这一条记录为「接受的误报」而非去收窄。随后一轮同族清扫又关闭了裸 `export`、裸 `declare`/`typeset` 及其 `-p` 形态、以及 `/proc/thread-self/environ`——它们导出的环境与已覆盖形态完全相同。

第二个提交经评审后进行了第三轮，又关闭五项：第二轮边界丢掉的**带引号相对路径** `.credentials` 读取；shell `-c` 包装分支缺终止符判据（它扣住了普通的 `sh -c "set -euo pipefail; make"`）；位于 `-c` 之前的旗标如 `--norc`；`/proc/self/task/<tid>/environ`；以及未被钉住的 CLI 旗标——现由已提交的 CLI 用例加一条双向 workflow 契约用例覆盖。对该轮的对抗审计又在**其自身修复里**发现一个问题：把 `.credentials` 边界写成否定类 `[^.\w]` 会放进 `?` 与 `)`，从而扣住普通 TypeScript 的可选链与带括号属性访问。允许集合现已改为显式枚举，两种误报形态都被钉住。

有一处枚举清单的缺口选择披露而非关闭：带独立参数的 shell 旗标，如 `bash -o posix -c printenv`，仍被放行。

## 未决问题

- #18364 的 review run 在第一道检查就因 `CI_BOT_PAT` 为空而中止，而同一分钟内一个仓内 PR 的 review 成功。机制尚未查明。在查清之前，「secret 为空」不得被算作一道控制。
- 依赖清单是否应留在受保护集合内——自动化依赖 PR 从此需要维护者显式放行。
- `gh pr diff` 自身是否可能对超大 PR 返回被静默截短的 patch。见证字节只能检测**本步骤**的截断；上游短读会以小于上限的体量到达、看起来完整。此处未实测，因此不声称已关闭。
