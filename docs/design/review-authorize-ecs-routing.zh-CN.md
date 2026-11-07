# 将命令权限门路由到 ECS 池

[English](review-authorize-ecs-routing.md) | [简体中文](review-authorize-ecs-routing.zh-CN.md)

状态：已随本 PR 实现。

## 问题陈述

每一条 bot 命令——`qwen-code-pr-review.yml` 里的 `/review`、`/resolve`，以及
`qwen-triage.yml` 里的 `/triage`、`/tmux`、`/verify`——都先经过一个 `authorize`
job。该 job 是写权限门：从事件元数据读出触发主体，并调用一个只读 API
（`repos/{owner}/{repo}/collaborators/{principal}/permission`）。它不跑 agent、不
checkout 任何代码、也不处理任何 pull-request 内容。

尽管这是一个只需四秒的纯 API job，实测 `authorize` 曾在 GitHub 托管队列里等待
**3 小时 10 分**才得以启动（PR #15286，run 42201221971，2026-11-06：创建于
10:15:08Z，`authorize` 于 13:25:52Z 启动）。当时自建 ECS 池是空闲的。由于
`authorize` 是硬门，它不结束，下游的任何 job 连队列都进不了，因此托管积压会把每
一条命令都卡死在门口。

这份收益落在下游 job 本就已上池的命令上：`/review`、`/triage`、`/tmux`、
`/verify`。它**并不**改变 `/resolve` 的端到端延迟。所引事故是一条 `/resolve`，其
`resolve-pr` agent 出于设计仍留在 `ubuntu-latest`，因此门在几秒内返回后，
`resolve-pr` 仍会并入同一托管队列：该 run 里它在 `authorize` 结束的那一刻启动，约
29 分 36 秒后被取消，未能完成解冲突。本 PR 消除的是门口的等待，而非 `/resolve`
agent 的排队。

## 现状

`authorize` 的 runner 路由为：

```
(github.repository == 'QwenLM/qwen-code' &&
 vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' &&
 github.event.pull_request &&
 github.event.pull_request.head.repo.full_name == github.repository)
  && ECS || ubuntu-latest
```

同仓守卫读取 `github.event.pull_request.head.repo.full_name`。该字段存在于携带
PR 载荷的事件（`pull_request_target`、`pull_request_review`、
`pull_request_review_comment`），但**不**存在于 `issue_comment` 与
`workflow_dispatch`：

- `issue_comment` 载荷携带 `github.event.issue`（其下有一个 `.pull_request` URL
  子对象），绝没有顶层的 `github.event.pull_request`。
- `workflow_dispatch` 载荷只携带 dispatch 输入。

因此对这两个命令触发器，守卫恒短路为 false，job 在**每一次** `/review` 与
`/resolve` 都回落到 `ubuntu-latest`，无论 ECS 池多空闲。这是一个路由盲区，而非有意
的托管钉死。

## 目标

- 把当前回落到托管的命令触发器的 `authorize` 门路由到持久 ECS 池，使拥堵的托管队列
  不再在门口卡死 `/review` 与 `/resolve`。
- 对携带 PR 载荷的事件保留既有的 fork 隔离。
- 改动最小且可回退（`MAINTAINER_ECS_RUNNER_DISABLED` 开关仍能强制托管）。

## 范围边界

- **范围内：** `authorize` 门的 `runs-on` 表达式、说明注释，以及其携带 PAT 步骤的
  gh 配置加固，涵盖 `qwen-code-pr-review.yml`（/review、/resolve）与
  `qwen-triage.yml`（/triage、/tmux、/verify）两者；pin 住新路由与加固的 meta-test。
- **范围外：** `resolve-pr` agent job 与 `publish-resolution` job。两者出于一次性
  （ephemerality）考虑被有意钉在 `ubuntu-latest`（agent 以 `tools.sandbox: false`
  运行不可信 PR 内容；publish job 在一个从未执行过 agent 的 runner 上持有推送
  PAT）。把它们搬到持久池是另一个独立的安全问题——见
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md) 以及
  `resolve-pr` settings 块的理由。本改动**并不**让整条 `/resolve` 流水线脱离托管，
  它只消除门口的数小时等待。

## 方案

为无载荷的命令事件在路由条件中增加两个析取项：

```
(github.repository == 'QwenLM/qwen-code' &&
 vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' &&
 ((github.event.pull_request &&
   github.event.pull_request.head.repo.full_name == github.repository) ||
  github.event_name == 'issue_comment' ||
  github.event_name == 'workflow_dispatch'))
  && ECS || ubuntu-latest
```

按事件划分的行为：

| 事件                                 | 改动前 | 改动后  |
| ------------------------------------ | ------ | ------- |
| `pull_request_target` 同仓           | ECS    | ECS     |
| `pull_request_target` fork           | 托管   | 托管    |
| `pull_request_review(_comment)` 同仓 | ECS    | ECS     |
| `pull_request_review(_comment)` fork | 托管   | 托管    |
| `issue_comment`（/review、/resolve） | 托管   | **ECS** |
| `workflow_dispatch`                  | 托管   | **ECS** |

只有最后两行发生变化。

该门步骤还以兄弟 job 的 gh 配置 pin 开场——`export GH_HOST=github.com` 加一个私有、
带守卫的 `GH_CONFIG_DIR`——使携带 PAT 的 API 调用不会被改道经由池上共享且可写的
`~/.config/gh`（见「风险」）。

## 设计决策与理由

1. **因为没有任何 fork 代码进入该 job，所以在持久池上是安全的。** 让 fork 触发的
   工作远离持久 runner 的威胁，是 job *执行*攻击者撰写的分支代码、并留下幸存进程攻
   击同一主机上后续 job。`authorize` 不执行任何来自 PR 的东西：它只读事件元数据（一
   个用户名）并调用一个只读 API。评论正文只在 GitHub 侧的 `if:` 表达式里被匹配，绝
   不传入 shell。因此把它路由到 ECS 并不扩大 fork 攻击面。

2. **与仓库既有模式一致。** `qwen-autofix.yml` 的 `route` 与 `review-scan` job 早
   已对其纯 API 步骤应用"无 PR 载荷 → 无 fork 代码 → 持久池"规则：它们的路由把一切
   非 `pull_request`/`pull_request_review` 事件送往 ECS。其中 `review-scan` 在此
   同时加载 `CI_DEV_BOT_PAT`（`route` 只用只读的 `github.token`）。`authorize` 形态
   相同（纯 API、加载一个 bot PAT），故遵循同一规则。

3. **外科手术式，而非重写。** 同仓守卫对 PR 载荷事件原样保留；两个新析取项只覆盖那
   些根本没有 `github.event.pull_request` 可供守卫的事件。托管回落与 ECS 开关均不
   变。

## 约束

- PR 载荷事件的 fork 守卫行为必须逐字节保持不变。
- `MAINTAINER_ECS_RUNNER_DISABLED=true` 仍必须把一切事件强制到托管。
- 仓库守卫（`github.repository == 'QwenLM/qwen-code'`）必须保留，使本仓库的 fork 不
  会路由到它们无法访问的池。

## 风险

- **命令触发对任何 GitHub 用户开放。** `issue_comment` 析取项使该门可以被任何人在
  fork PR 上评论 `@qwen-code /review` 或 `@qwen-code /resolve` 触发；
  `workflow_dispatch` 仍要求写权限。该门不运行该 PR 的任何内容，故未新增执行路径
  ——但它确实把 `CI_BOT_PAT` 与该 job 的 `should_review` 决定，放到了由外部人员排程
  的一次运行所在的共享池上，而 `should_review` 正是每个下游 job 不经重新推导即消费
  的授权事实。两者都属于
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md) 跟踪的同一
  共享主机类别；本条记录这次触发面扩大，以免被误认为触发集未变。
- **共享主机上的 PAT 暴露。** `authorize` 加载 `CI_BOT_PAT`。在持久池上，先前 job
  的同驻幸存进程原则上可能以它为目标——尤其是经由池上共享且可写的 `~/.config/gh`：
  在那里植入的 `http_unix_socket` 会收到该 PAT，并能伪造下游 job 当作 `should_review`
  消费的权限响应。因此该步骤以与 `qwen-autofix.yml` 的 `route`/`review-scan` 相同的
  gh pin 开场——`export GH_HOST=github.com` 加一个私有、带守卫的 `GH_CONFIG_DIR`
  （`mktemp` 失败即 exit 1；该门 fail closed）——并由一条 meta-test pin 住它们。
  **带着这些 pin**，其暴露才与 `review-scan` 已被接受的相同（它在同一池上加载
  `CI_DEV_BOT_PAT`；`route` 只加载只读的 `github.token`），且 `authorize` 严格更轻
  （一个只读 API、无 checkout）。没有这些 pin，该对等就不成立。共享池上携带 PAT 步骤
  的结构性收口在 [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md)
  中单独跟踪；本改动不使其倒退。
- **下游仍有托管队列。** `resolve-pr` 与 `publish-resolution` 仍在托管上运行，因此
  饱和的托管池仍可能延迟 agent 与推送。本改动只消除门口等待，并不宣称 `/resolve` 变
  得无队列。

## 扩展到 triage 命令门

`qwen-triage.yml` 的 `authorize` 对其 `/triage`、`/tmux`、`/verify` 评论（及其
`tmux_pr` dispatch）存在同样的仅载荷盲区，因此其 `runs-on` 应用相同的两个析取项。
与 review 门的单步骤不同，该 job 有**三个**步骤用 `CI_BOT_PAT` 调 `gh`——权限检查、
verify 确认、以及停用通告——每一步现在都以相同的自包含 `GH_HOST` + 带守卫
`GH_CONFIG_DIR` 前导开场，遵循仓库的每步约定。把该门搬上池却不加固其中任何一步，都会
复现 R2-1 改道，因此这里的加固不是可选项。`.github/scripts/qwen-triage-workflow.test.mjs`
中的一条 meta-test pin 住析取项、无 checkout/无拼接不变量、每个步骤（不限于携带 PAT
的步骤——不携带凭据的步骤若执行植入文件，同样会在持久主机上留下幸存进程）不得执行
仓库代码的不变量、以及每个调 gh 步骤的 gh 配置加固。该 workflow 的记录体积基线
（`.github/workflows/.size-baseline`）相应上调以匹配新增加固。

## 验证计划

- `scripts/tests/qwen-pr-review-workflow.test.js` 中的一条 meta-test pin 住
  `authorize` 的精确 `runs-on` 表达式，并断言安全不变量：命令事件到达 ECS；同仓
  fork 守卫、托管回落、ECS 开关全都仍在；该 job 保持无 checkout（无 `uses:` 步骤）；
  其步骤清单恰为那一个权限步骤、且任何 `run:` 正文都不拼接 `${{`。对剥离注释后的有效
  行，还 pin 住带守卫的 `mktemp` 形式与 fail-closed 形状（`exit 1 … fi … export`）、
  `GH_HOST`/`GH_CONFIG_DIR` 必须先于第一个 `gh api` 导出、且正文不得以相对路径或解释器
  执行仓库代码（池上 cwd 是复用的 `$GITHUB_WORKSPACE`）。
- 变异见证（已在本机验证）：还原表达式、加 `uses:` 步骤、加仅 `run:` 的第二步、删 gh
  前导、把守卫块换成无守卫单行、或向正文追加 `node ./…` 执行行，都会使测试失败；恢复后
  通过。
- 完整 `qwen-pr-review-workflow.test.js`（271 个测试）与
  `qwen-resolve-workflow.test.js`（55 个测试）通过。
- triage 门由 `.github/scripts/qwen-triage-workflow.test.mjs`（131 个测试）
  pin 住；`.github/scripts/ci-runner-routing.test.mjs`（103 个测试）中的路由
  矩阵也全部通过（它 pin 住的是兄弟上池 job，而非本门）。还原 triage 析取项、
  删某 gh 步前导、或向任一步骤正文（含不携带凭据的 budget 步骤）追加仓库代码
  执行行，均使 triage 测试变红。

## 验收标准

- 在仓库守卫与开关允许时，两个 `authorize` 门（review 与 triage）都把
  `issue_comment` 与 `workflow_dispatch` 路由到 ECS 池。
- PR 载荷事件保持既有的同仓/fork 路由。
- 门的每个步骤保持无 checkout/无拼接/不执行仓库代码不变量，每个携带 PAT 的步骤
  保持 gh 配置 pin（带守卫、先于 gh 调用）；pin 住它们的 meta-test 能杀死针对每一
  项的变异。
- 其他任何 job 的路由都不变。

## 未决问题

- 是否把 `resolve-pr` agent 也搬到一个可用的 docker 沙箱之后的 ECS（需 dry-run 证
  据）是一个独立实验；此处明确不作决定。
