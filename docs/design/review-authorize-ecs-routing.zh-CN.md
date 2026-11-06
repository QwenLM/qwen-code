# 将 /review 与 /resolve 的权限门路由到 ECS 池

[English](review-authorize-ecs-routing.md) | [简体中文](review-authorize-ecs-routing.zh-CN.md)

状态：已随本 PR 实现。

## 问题陈述

每一条 `@qwen-code /review` 与 `@qwen-code /resolve` 命令都先经过
`.github/workflows/qwen-code-pr-review.yml` 里的 `authorize` job。该 job 是写权限
门：从事件元数据读出触发主体，并调用一个只读 API
（`repos/{owner}/{repo}/collaborators/{principal}/permission`）。它不跑 agent、不
checkout 任何代码、也不处理任何 pull-request 内容。

尽管这是一个只需四秒的纯 API job，实测 `authorize` 曾在 GitHub 托管队列里等待
**3 小时 10 分**才得以启动（PR #15286，run 42201221971，2026-11-06：创建于
10:15:08Z，`authorize` 于 13:25:52Z 启动）。当时自建 ECS 池是空闲的。由于
`authorize` 是硬门，它不结束，下游的任何 job——包括解冲突 agent——连队列都进不
了，因此托管积压会把整条命令卡死在门口。

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

- **范围内：** `authorize` job 的 `runs-on` 表达式及其说明注释；一条 pin 住新路由的
  meta-test。
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

## 设计决策与理由

1. **因为没有任何 fork 代码进入该 job，所以在持久池上是安全的。** 让 fork 触发的
   工作远离持久 runner 的威胁，是 job *执行*攻击者撰写的分支代码、并留下幸存进程攻
   击同一主机上后续 job。`authorize` 不执行任何来自 PR 的东西：它只读事件元数据（一
   个用户名）并调用一个只读 API。评论正文只在 GitHub 侧的 `if:` 表达式里被匹配，绝
   不传入 shell。因此把它路由到 ECS 并不扩大 fork 攻击面。

2. **与仓库既有模式一致。** `qwen-autofix.yml` 的 `route` 与 `review-scan` job 早
   已对其携带 PAT 的纯 API 步骤应用"无 PR 载荷 → 无 fork 代码 → 持久池"规则：它们的
   路由把一切非 `pull_request`/`pull_request_review` 事件送往 ECS。`authorize` 形态
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

- **共享主机上的 PAT 暴露。** `authorize` 加载 `CI_BOT_PAT`。在持久池上，先前 job
  的同驻幸存进程原则上可能以它为目标。这与 `route`/`review-scan` 已被接受的暴露相
  同（它们在同一池上加载 `CI_DEV_BOT_PAT`），且 `authorize` 严格更轻（一个只读
  API、无 checkout）。共享池上携带 PAT 步骤的结构性收口在
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md) 中单独跟踪；
  本改动不使其倒退。
- **下游仍有托管队列。** `resolve-pr` 与 `publish-resolution` 仍在托管上运行，因此
  饱和的托管池仍可能延迟 agent 与推送。本改动只消除门口等待，并不宣称 `/resolve` 变
  得无队列。

## 验证计划

- `scripts/tests/qwen-pr-review-workflow.test.js` 中的一条 meta-test pin 住
  `authorize` 的精确 `runs-on` 表达式，并断言安全不变量（命令事件到达 ECS；同仓
  fork 守卫、托管回落、ECS 开关全都仍在）。
- 变异见证：把表达式还原为旧的同仓唯一形式会使新测试失败（已在本机验证）；恢复后套
  件通过。
- 完整 `qwen-pr-review-workflow.test.js`（271 个测试）与
  `qwen-resolve-workflow.test.js`（55 个测试）通过。

## 验收标准

- 在仓库守卫与开关允许时，`authorize` 把 `issue_comment` 与 `workflow_dispatch` 路
  由到 ECS 池。
- PR 载荷事件保持既有的同仓/fork 路由。
- pin 住路由的 meta-test 通过，并能杀死"还原表达式"的变异。
- 其他任何 job 的路由都不变。

## 未决问题

- 是否把 `resolve-pr` agent 也搬到一个可用的 docker 沙箱之后的 ECS（需 dry-run 证
  据）是一个独立实验；此处明确不作决定。
