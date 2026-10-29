# 在 `/review` 或 `/verify-pr` 被接纳时绑定 PR

[English](2026-10-22-review-prompt-pr-binding.md) | [简体中文](2026-10-22-review-prompt-pr-binding.zh-CN.md)

日期：2026-10-22
状态：已实现
更新：2026-10-26 —— `/verify-pr` 复用同一套命令语法与闸门。

## 问题

Web Shell 的 PR 徽标来自会话 PR sidecar。用户可以在 Web Shell 会话里输入
`/review 15172` 或 `/verify-pr 15172 --publish`。命令会执行，但会话在这一刻
没有 PR 绑定。绑定模型与 sidecar 格式见
[会话 PR 绑定设计](2026-08-20-webshell-session-pr-binding.md)。

按需回填（`POST /sessions/backfill-prs`）可以从用户输入的命令推导绑定。结果里的
`repoDeclined` 按「被拒绝的声明」计数——号码或 URL 形态——因此即使另一个来源仍然
绑定了该号码，策略性拒绝与空运行也可以区分。它读取
transcript。这个设计有两个缺口：

1. 正常的 Web Shell 流程不会触发回填。
2. 新会话可能在 transcript 文件存在之前就绑定。回填扫描不到尚未落盘的命令。

## 决策

daemon 接纳 `/review` 或 `/verify-pr` 提示词时，立即绑定 PR。

- 钩子放在 daemon 的提示词路由（`POST /session/:id/prompt`）。Web Shell 客户端
  不负责会话持久化。
- 钩子把命令交给现有回填管线。解析器、URL 解析、sidecar 写入各只有一份。
- 实时路径只扫描目标会话，不扫描整个 workspace。
- 钩子异步执行、best-effort，绝不延迟或失败该轮对话。

## 护栏

- **只认显式命令。** 共享语法只读命令位置上的 `/review` 与 `/verify-pr`，
  各自支持 `<N|#N|PR URL>`。assistant 散文与工具输出不能创建绑定。命令名之后必须
  紧跟空格或制表符，因此 `/verify-pr-watch` 与 `/review77` 都是另一条命令；按文件名
  字符收口的是号码——`/verify-pr 001_init.sql` 是文件，不是 PR 1。
- **`--repo` 作用域。** `/verify-pr` 接受 `--repo <owner>/<repo>`（gh 的
  `[HOST/]OWNER/REPO` 形态）。号码被限定到既非本 workspace 自身、也非 gh 页
  已确认 fork 父仓库时，它是另一个仓库的 PR，不产生绑定；本 workspace 的同号
  PR 是另一个 PR。该限定从任何提示词命令上读取，因此既有 `/review <N>` 提示词里
  误写的 `--repo a/b` 也会 fail closed，而不是绑定本 workspace 的 N；且匹配需要
  workspace 仓库 key——`origin` 无法解析时，即使限定本身正确，也不产生绑定。仅由
  `--repo` 命名的号码，只在解析出的 PR 属于被点名的那个仓库时才绑定——fork 的另
  一侧是同号但不同的 PR——匹配不上时拒绝绑定而不是替换。
- **来源。** 只有本地用户键入的提示词会绑定。渠道转发的轮次按原始渠道标记跳过，
  外部发送者不能把 PR 绑定写进本地会话。
- **输入上限。** 语法最多扫描 16 KiB。惰性 URL 分支呈二次方回溯，而 live 钩子
  在每个被接纳提示词的同步前缀上执行匹配；该上限同时覆盖回填扫描。
- **仓库身份。** GitHub 号经 gh 页与 workspace 仓库 key 解析。fork 父仓库只有
  在确认后才接受。remote URL 是兜底。
- **Aone。** Aone 号经 `mr view` 解析。代码绝不拼 `<origin>/pull/<N>` 链接。
- **来源等级。** 两条命令都写 `source: 'review'`：会话只是看过该 PR，不引入新的
  sidecar 取值。`create` 与 `worktree` 的等级更高。现有上限裁剪会保留更强的绑定。
- **上限。** 实时审查加入现有上限计划。旧的 `review` 绑定可被淘汰；`create`、
  `worktree` 与无 provenance 条目保留槽位。满额会话因此替换最旧的 review，
  而不是冻结徽标。
- **归档状态。** 在 archive lane 内重新解析会话位置并写入对应 sidecar。已归档
  会话写 archived sidecar；已删除会话跳过。
- **transcript 缺失。** 只有 bridge 仍持有的会话可以在 transcript 未落盘时绑定——
  即新会话。位置无法确定时 fail closed。
- **发布。** 实时写入会失效会话列表缓存并标记 catalog 变更。徽标在正常的
  live-state 刷新中出现。
- **幂等。** 同一号码重复 `/review` 不会重排或刷新绑定。

## 不注册的情况

- 不使用 `record_source`。被审查的 PR 是动作目标，不是 assistant 引用过的来源。
- 本地审查不绑定：无参数、文件路径、本地 diff、PR 0。
- 非 trusted workspace 不绑定。

## 验证

- 回填测试覆盖：无 transcript 的实时绑定、归档与 URL 形态、仅扫描目标会话、
  catalog 标记、文件目标拒绝、untrusted 闸门、超长提示词上限、满额淘汰（含
  create 保护与目标已绑定时的重复审查）、conflict 分支、trusted wrapper 的
  仅目标会话/非 review 场景、归档/删除/位置解析失败的生命周期竞争。
- 提示路由测试覆盖：首个文本块的传递、后续文本块、untrusted workspace、渠道
  提示词、binder 拒绝/挂起、coordinator 交接。
- `/verify-pr` 覆盖：实时接受/拒绝成对（`--repo` 指向本 workspace 时绑定；指向
  另一仓库时拒绝并上报 `repoDeclined`）、取值语法读不出的 `-R` 各种写法（裸写、
  附着、带引号、URL 形态、取值在下一行）、
  `--repo=` 形态、`--assets-repo` 不受影响、后一次指向本 workspace 的声明胜过
  先前的他仓声明、不带限定的 `/review` 声明清除限定、分歧页面下绑定到号码被限定
  的那个仓库、transcript `slash_command` 扫描，以及拒绝 `/verify-pr-watch` 与
  `/review77` 的分隔符。
- `packages/cli` 的 typecheck、ESLint、Prettier 通过。

## 验收标准

- Web Shell 会话里执行 `/review 15172` 后，PR #15172 在正常 catalog 刷新后出现在
  会话徽标与搜索中。
- `/verify-pr 15172` 与 `/review 15172` 绑定同一枚徽标，实时路径与 transcript
  回填路径都成立。
- 不带限定、或限定指向本 workspace 仓库（含 gh 页已确认的 fork 父仓库）的
  `/verify-pr <N>` 绑定 PR `<N>`，且解析出的 PR 必须属于该仓库：解析结果是 fork
  另一侧的同号 PR、或在该仓库中无法解析时，号码保持不绑定。全部限定都指向另一
  仓库的号码不产生绑定，除非该号码由 URL 形态或 worktree 约定提供。
- 被限定到另一仓库的 `/verify-pr` 号码不产生绑定、不写 sidecar、不标记 catalog
  变更；拒绝会计入 `repoDeclined` 并进入 live 钩子的告警。
- 非显式 PR 审查的提示词不创建绑定，也不发起平台查询。
