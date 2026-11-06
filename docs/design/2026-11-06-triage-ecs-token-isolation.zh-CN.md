# Triage 上 ECS：Token 隔离与容器化

[English](2026-11-06-triage-ecs-token-isolation.md) | [简体中文](2026-11-06-triage-ecs-token-isolation.zh-CN.md)

- 状态：提案
- 日期：2026-11-06
- 范围：仅 `.github/workflows/qwen-triage.yml` 的 triage lane、`.qwen/skills/triage/**`、一个新 publisher 脚本、workflow pin 测试

## 问题陈述

GitHub-hosted runner 资源紧张，而维护者自建的 ECS 池有余量。`qwen-triage.yml`
的 triage lane 至今仍有两类触发路由到 `ubuntu-latest`：

- `issue_comment` 重跑（`@qwen-code /triage`）：评论 payload 不带
  `github.event.pull_request` 对象，且目标可能是外部作者的 fork PR；
- 作者无 write 权限的 fork PR 的自动 `pull_request_target` triage。

这条路由是刻意的安全控制，不是技术限制。triage agent 以 `--yolo` 运行，环境里
带着 write PAT（`QWEN_CODE_BOT_TOKEN || CI_BOT_PAT`）。workflow 自己的注释块
写明：命令 denylist 不是安全边界；「fork PR 跑在临时 hosted runner」是三条真实
防线之一；残余风险——被提示注入的 agent 外泄 PAT 或伪造 bot 写入——的结构性
修复就是 token 隔离，「已记为 follow-up；尚未接线」。

不接线就把剩余触发搬上持久池，等于让被诱导的 agent 在复用的机器上跨 run 持久
化，并收割后续 job 的凭据。本设计的目标就是接上这个修复，然后把全部 triage
触发路由到 ECS。

## 现状

- `triage` job checkout 的是可信 base 仓库，从不 checkout PR 代码，只通过 API
  触达 PR/issue。agent 经 `QwenLM/qwen-code-action` 启动，action 直接拿到
  write PAT（`GITHUB_TOKEN`/`GH_TOKEN`）和真实模型 key。
- skill（`.qwen/skills/triage/`）自己执行全部 GitHub 写入：分阶段评论原地
  upsert、带票 review、关 PR/issue、issue label、加 assignee，以及由
  `qwen-triage-finalize.yml` 兑现的 `approve-on-green` marker。
- 兄弟 lane 已实现本设计复用的隔离契约：`tmux-testing` 与 `verify` 在
  `node:22-bookworm` 容器里运行，经 `runuser -u node -- env -i` 直接启动 CLI、
  GitHub token 全空，真实模型 key 放在 root 持有的 loopback 代理后面，产物交给
  独立 publisher job（`publish-tmux`、`publish-verify`）——后者持有写凭据、
  从不执行 agent 提供的代码。
- `qwen-triage-finalize.yml` 按 marker 字节与 bot 登录名消费 bot 作者的评论。
  任何替代写入路径都必须同时保住这两点。

## 目标

1. 池启用时，把每一类 triage 触发（issues、含外部 fork PR 的
   `pull_request_target`、`issue_comment`、`workflow_dispatch`）都路由到 ECS；
   `MAINTAINER_ECS_RUNNER_DISABLED=true` 时保留现有 hosted 降级。
2. 把 write PAT 从 agent 环境里拿掉。agent 用短生命周期只读 token 读 GitHub，
   所有写入表达为经校验的 draft，由独立 publisher 执行。
3. 容器化 agent job，使其行为除了经过净化的 workspace 外不在 runner 宿主机上
   留下任何持久化；真实模型 key 不进 agent 环境。
4. 保住全部下游契约：marker 字节、bot 身份、`approve-on-green` 协议、lifecycle
   评论，以及本地 `/triage` 的可用性。

## 非目标

- 不改 `tmux-testing`、`verify`、`publish-tmux`、`publish-verify` job，不改
  `qwen-triage-finalize.yml`，不改 `/review` 流水线（`qwen-code-pr-review.yml`）。
- 不改 triage 的判定逻辑、阶段结构、护栏与评论模板。
- 不抽取共享 model-proxy 脚本（本次是第三份 inline 副本；抽取列为 follow-up）。
- 「观察」一节列出的两处既有不一致只记录、不修复。

## 提议的改动

### A. Runner 路由

`triage` job 的 `runs-on` 收敛为 `publish-tmux` 同款形状：

```
(repo == QwenLM/qwen-code && MAINTAINER_ECS_RUNNER_DISABLED != 'true')
  → ['self-hosted', 'linux', 'x64', 'ecs-qwen']
  → 否则 ['ubuntu-latest']
```

`authorize` 的 `author_can_write` output 只为 triage 路由而存在；改造后没有
消费方，连同 `pull_request_target` 分支里的那次权限查询一起删除。
`verify_trust` 分类与所有拒绝门不变。`precheck-pr` 仍然 gate 自动 fork-PR
triage。

路由不再依赖目标 PR 的作者是谁，因为信任边界由下面的控制承担，而不是机器选择。
hosted 降级仍然安全：这些控制是叠加性的。

### B. Token 隔离

#### B1. 只读 agent 凭据

`triage` job 增加显式 job 级 `permissions`：`contents: read`、`issues: read`、
`pull-requests: read`、`checks: read`、`actions: read`。agent 拿到这个 job 作用
域的 `GITHUB_TOKEN` 作为 `GH_TOKEN`：只读、随 job 过期、对伪造 bot 写入毫无
价值。agent 前的 eyes-reaction 步骤从 `GITHUB_TOKEN` 改用 bot PAT（reaction
需要 write 作用域）。

今天 skill 里有两类读取用这个 token 做不了，搬到宿主侧：

- **collaborator-permission 查询。** 确定性 maintainer 解析器会调
  `repos/{repo}/collaborators/{login}/permission`，该 API 需要 write 级 token。
  整个解析器（env handle 覆盖 → owner map + canWrite 过滤 + 经
  `.github/scripts/assign-issue-owner.mjs` 的负载轮转 → 最近人类 reviewer 兜底）
  移入 publisher 脚本。agent 的 defer draft 只带理由；publisher 解析 maintainer、
  前置 @mention、发评论，并 best-effort 加 assignee。
- **跨仓库读取。** Stage 1c 读 `repos/anthropics/claude-code/contents/CHANGELOG.md`
  作为可选的方向信号；`GITHUB_TOKEN` 只对本仓有效。由宿主步骤（持 PAT、
  best-effort）把文件预取到 agent 的 context 目录；skill grep 本地文件，文件
  缺失按「信号不可用」处理——skill 本来就接受这不构成拒绝。

skill 的作者过滤（duplicate guard、reopen guard、review 去重）所用的 bot 登录
名，由宿主步骤持 PAT 解析后以 `BOT_LOGIN` 传给 agent；只读 token 下 `gh api user`
返回的是 `github-actions[bot]`，会悄悄打穿所有作者过滤。

#### B2. Draft 协议

agent 不再发出 GitHub 写命令，改为向宿主预备、以 `QWEN_TRIAGE_DRAFT_DIR` 导出
的目录写入：

```
actions.jsonl        # 有序动作，每行一个 JSON 对象
bodies/<name>.md     # 动作引用的评论/review 正文
```

动作词汇表（即今天 skill 的全部写入面）：

```json
{"action":"upsert-comment","marker":"stage=1","body":"bodies/stage-1.md"}
{"action":"review","event":"APPROVE","commit_id":"<head oid>","body":"bodies/review.md"}
{"action":"review","event":"REQUEST_CHANGES","body":"bodies/review.md"}
{"action":"close-pr"}
{"action":"close-issue","reason":"not planned"}
{"action":"labels","add":["type/bug"],"remove":["status/need-information"]}
{"action":"defer","body":"bodies/defer.md"}
```

`approve-on-green` marker 不是动作：它仍是 Stage 3 评论正文里的一行，与今天
完全一致，finalize workflow 看不到任何变化。

#### B3. Publisher

一个新脚本 `.github/scripts/triage-publish.mjs`，是 CI 与本地共用的唯一写入
路径实现。它：

1. 在写入任何内容之前解析并校验整个 draft 集（fail-closed 预检）：未知动作或
   字段拒绝整组；`marker` 必须在允许列表（`stage=1`、`stage=2`、`stage=3`、
   `stage=1-pre`、`stage=1b`）；每条评论正文必须以精确的
   `<!-- qwen-triage <marker> -->` 行开头（前缀由 publisher 强制，不信任
   agent）；超过 GitHub 65,536 字符上限的正文拒绝而非截断（截断可能切掉 CI 区域
   或 approve-on-green marker）；review event 仅限 `APPROVE` 与
   `REQUEST_CHANGES`；`APPROVE` 必须带 `commit_id`；body 路径必须解析为 draft
   目录内的常规文件。
2. 按序执行动作，逐动作 best-effort 并输出逐动作结果摘要：
   - `upsert-comment`：bot 作者 + 正文 startswith marker 去重，取 last，PATCH
     否则 POST——即 `publish-tmux` 的纪律，包括身份解析 fail-closed。
   - `review`：重读 head；`commit_id` 已不匹配 head 的 `APPROVE` 按 stale 跳过
     （与 finalize 一致）。幂等：bot 自己在该 commit 上已 `APPROVED`、或已存在
     `CHANGES_REQUESTED`，都抑制重复。
   - `close-pr` / `close-issue`：仅当目标仍 open。
   - `labels`：先验证每个 label 存在再应用；永不创建。
   - `defer`：运行搬过来的 maintainer 解析器，发带解析出的 @mention 的评论
     （解析不出就不带），best-effort 加 assignee。

CI 里由新 job `publish-triage` 运行该脚本：`needs: triage`、
`if: always() && needs.triage.result != 'skipped'`（超时或失败前写下的 draft
仍能发布）、与兄弟 publisher 相同的 per-RUN 并发组与 10 分钟上限、
`publish-tmux` 的 runner 路由，以及只含 publisher 脚本、`assign-issue-owner.mjs`、
`issue-owners.json` 的 sparse checkout，钉 `github.sha`、
`persist-credentials: false`（`publish-verify` 的模式）。它下载 drafts artifact
（按兄弟 lane 的规矩剥离符号链接与非常规文件），持 bot PAT 运行脚本。PAT 从不
进入 triage job 的 agent 环境；publisher 从不执行 agent 提供的代码，只处理数据。

本地则由 skill 在运行末尾用用户自己的 `gh` 认证运行同一脚本。一套协议、一份
实现、两种凭据上下文。

#### B4. Skill 改动

`SKILL.md`、`references/pr-workflow.md`、`references/issue-workflow.md` 把每条
写命令替换为对应的 draft 写入，保留全部读取，所有 marker 字节不变。新增
「Publishing」一节定义两种模式：`QWEN_TRIAGE_PUBLISH=workflow`（仅由 workflow
设置）时 agent 只写 draft 即止——CI denylist 挡 `node`，它在结构上就无法自己跑
publisher；否则以运行 `triage-publish.mjs` 作为最后一步。解析器 heredoc 与跨仓
CHANGELOG 抓取离开 skill。Rules 里关于 CI write PAT 的表述更新为只读 token。

### C. 容器化与 agent 启动

`triage` job 采用兄弟契约：

- `container: node:22-bookworm` 带 `--init`；工具步骤安装 `gh`、`jq`、`git`、
  `ca-certificates`（即 tmux 的 resolver-tools 步骤）。
- action 步骤替换为与 tmux/verify 同形的直接 CLI 启动：model proxy 在同一步骤内
  启动（加固版 loopback proxy 的第三份 inline 副本——临时端口、nonce 健康检查、
  bearer dummy key），然后 `timeout … runuser -u node -- env -i … qwen
--auth-type openai --approval-mode yolo --prompt '/triage …' --output-format
stream-json`。显式环境携带只读 `GH_TOKEN`、`BOT_LOGIN`、draft 目录变量、每 run
  全新的 `QWEN_HOME`，以及代理端点而非真实模型 key。denylist/settings 块随启动
  迁移，实质不变。
- 替换步骤保留名称 `Run Qwen Triage` 与 id `triage`，从 `output.jsonl` 的
  result 帧提取出同名 `summary` output，使 env 字面量被 pin 的
  `Check triage response`（`RESPONSE`/`TRIAGE_OUTCOME`）字节不变、其 API-error
  后缀检测原样保留。settings/denylist 块逐字迁入宿主在启动前写入每 run 全新
  `QWEN_HOME` 的 settings 文件。
- 既有 workspace 卫生保留（属主恢复、stale-agent-state 净化、git metadata 重建）；
  base checkout 增加 `persist-credentials: false`；job 末尾增加镜像 tmux 的属主
  恢复步骤。drafts 以 artifact 上传并剥离非常规文件。

## 关键设计决策

| 决策                                                   | 理由                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| agent 读取用只读 `GITHUB_TOKEN`，不新增只读 PAT secret | job 作用域、临时、无需置备/轮换新 secret；它服务不了的两种读取搬宿主侧                                    |
| draft + 独立 publisher job，不做写入代理 sidecar       | 与 `publish-tmux`/`publish-verify` 一致；凭据以 job 边界隔离，publisher 是确定性、可单测的脚本            |
| CI 与本地共用一份 publisher 脚本                       | 防止两条写入路径漂移；本地 `/triage` 用用户自己的认证继续可用                                             |
| 阶段评论在结束时批量发布                               | 流式转发 draft 的 sidecar 会把活写入通道重新引入 agent job。lifecycle 评论带实时 run 链接，已覆盖进度观察 |
| maintainer 解析器移入 publisher                        | 它是确定性逻辑（owner map、canWrite、负载轮转），且需要 write 级 token；从来不是 agent 判断               |
| 删除 `author_can_write`                                | 唯一消费方是 triage 路由；死开关是评审发现项，不是兼容资产                                                |
| 第三份 inline model-proxy 副本                         | 抽取会动 tmux/verify lane 及其 pin；记为 follow-up                                                        |
| publisher 在部分运行上也执行（`always()`）             | 超时前写下的 draft 仍能到达 PR；lifecycle 评论记录提前结束                                                |
| 保留步骤名/id `triage` 及其 `summary` output           | `Check triage response` 的 env 字面量被 pin；保住它们就保住了失败检测契约，避免 pin 无谓改动              |

## 契约保全

- marker（`stage=N`、`qwen-triage-ci sha=…` 区域、`approve-on-green sha=…`、
  lifecycle）字节不变；publisher 前缀校验后原样发布正文。
- 所有写入仍落在 PAT 的 bot 身份下，`qwen-triage-finalize.yml` 的作者过滤、
  CI 区域替换、延迟批准原样工作。
- `Finalize triage status comment` 留在 triage job（`always()`），消费 agent
  前的评论 id 与 API 状态，不读 workspace 文件。`Notify silent triage re-run`
  **移入** `publish-triage`、在发布步骤之后：它检查的是本次运行发出的 review，
  而这些现在在发布时才落地，留在 agent job 会永远看到「无 review」。步骤正文
  不变，仅编号来源改为 `needs.triage.outputs.pr_number`。
- duplicate guard、reopen guard、review 去重语义不变；变的只是读取背后的凭据。

## 受影响文件

- `.github/workflows/qwen-triage.yml` —— triage job（路由、permissions、容器、
  启动、drafts 上传）、authorize（删 `author_can_write`）、新 `publish-triage` job。
- `.github/scripts/triage-publish.mjs` —— 新 publisher（校验 + 执行 + maintainer
  解析器）。
- `.qwen/skills/triage/SKILL.md`、`references/pr-workflow.md`、
  `references/issue-workflow.md` —— draft 协议、发布模式、搬走的解析器与
  CHANGELOG 抓取、更新的 Rules 表述。
- `.github/scripts/qwen-triage-workflow.test.mjs`（node:test，由 `ci.yml`
  `lint_and_static` 的 HELPER_TESTS 步骤执行）—— 701-756 行的路由 pin 钉的是
  旧信任模型（`author_can_write`、`issues` 分支），重写为钉新契约：ECS 路由 +
  hosted kill-switch 降级、无 `author_can_write`、job 级只读 permissions、
  agent 环境无 write PAT、容器存在、宿主写入的 settings 文件中的
  settings/denylist 内容。卫生 pin（stale-state 净化、属主恢复）保留步骤名契约。
- `scripts/tests/qwen-triage-workflow.test.js`（vitest）—— 设计保留之处的步骤
  名/env 字面量 pin 存活（status claim/finalize、`Check triage response`、
  `QWEN_HOME` 路径）；`QWEN_HOME` env 字面量 pin 移入 `env -i` 列表；新增
  publish job 与 drafts artifact 剥离的断言。verify lane 的 runuser 计数 pin
  不受影响（本改动不在该区间加步骤）。
- `scripts/tests/qwen-runner-checkout-workflow.test.js` —— 预期无需改动：
  `Recreate runner Git metadata` 仍紧邻 checkout 之前。
- `scripts/tests/triage-publish.test.js` —— publisher 新单测（校验 fail-closed
  用例、去重、幂等、解析器、逐动作失败报告），对 stub 的 `gh` 运行。
- `.github/workflows/.size-baseline` —— 本 PR 内 bump `qwen-triage.yml` 条目
  （见「约束与风险」）。
- 本设计文档对。

## 约束与风险

- **合入前无法真实触发。** `issue_comment` 与 `pull_request_target` workflow
  从默认分支取 YAML；新路径只能在合入后真实演练。合入前的信心来自 pin/replay
  套件、publisher 单测，以及本地 draft→publish 端到端 dry run。
- **批量阶段评论**是可见的 UX 变化：结果在运行结束时落地，而非逐阶段。lifecycle
  评论保留实时日志链接。
- **publisher 是新的单点故障。** 预检拒绝则什么都不发；job 大声失败，lifecycle
  评论记录提前结束，重跑即恢复。逐动作执行失败单独报告。
- **skill/publisher 漂移。** publisher 的允许列表是权威；pin 测试把 marker 集与
  draft 模式契约绑在两侧。
- **改造后的残余风险。** 被提示注入的 agent 仍能在 triage 的预期能力内 draft
  恶意内容（错误的 review、误导的评论）——这是产品固有表面，由人评审。它不再能
  外泄写凭据、伪造词汇表之外的写入，或在宿主机上持久化。
- **workflow 体积棘轮。** `qwen-triage.yml` 受
  `.github/scripts/check-workflow-size.sh` 门禁（绝对上限 470,000 字节；超出
  `.size-baseline` + 4,096 即 CI 红）。该文件已超 378,242 字节基线约 1.2 KB，
  免更新余量仅约 2.9 KB；inline proxy 与 publish job 必然超出，须同 PR bump
  基线条目。publisher 逻辑放在脚本而非 YAML 里，以控制增长。

## 验证计划

1. `scripts/tests` pin 套件更新并全绿，含新断言：triage `runs-on` 形状、job 级
   只读 permissions、agent 环境无 write PAT、容器存在、publish job 形状、skill
   与 publisher 的 marker 允许列表一致性。
2. publisher 单测全绿，带变异见证（移除任一校验规则或 bot 身份过滤必须让测试
   变红）。
3. workflow YAML 用仓库的 `node yaml` 工具解析通过；执行内联 shell 的 replay
   harness 通过。
4. 本地端到端 dry run：在测试仓库（或确认可写的真实 PR）上跑 `/triage`，验证
   draft→publish 产出与今天同形的评论/review。
5. 合入后首批真实运行的观察清单：评论触发与自动 fork-PR triage 落在 ECS；阶段
   评论、lifecycle、rerun-summary，以及一轮延迟 approve-on-green 经 finalize
   兑现；kill-switch 降级演练一次。

命令（仓库根目录）：

```bash
PATH="$HOME/.local/bin:$PATH" npx vitest run \
  --config ./scripts/tests/vitest.config.ts \
  scripts/tests/qwen-triage-workflow.test.js \
  scripts/tests/qwen-runner-checkout-workflow.test.js \
  scripts/tests/workflow-size.test.js
node --test .github/scripts/qwen-triage-workflow.test.mjs
```

vitest 套件在 `PATH` 缺 `jq` 时会静默跳过 jq 门控用例；`.mjs` 套件是 node:test
（不是 vitest），需要已安装 `yaml` 包。体积门禁在 CI 的 `lint_and_static` job
执行，并由 `scripts/tests/workflow-size.test.js` 镜像。

## 验收标准

- 池启用时所有 triage 触发跑在 ECS；`MAINTAINER_ECS_RUNNER_DISABLED=true` 时
  全部降级 hosted 且仍可用。
- agent 环境不含写凭据与真实模型 key（`env -i` 列表的结构性性质，由测试 pin）。
- publisher 执行完整动作词汇表；finalize 互操作不变；本地 `/triage` 经同一
  publisher 可用。
- 全部更新后的 pin 套件与新单测通过；YAML 校验通过。
- 合入后观察清单完成且无契约漂移。

## 开放问题

- 是否在 follow-up 中把三份 inline model-proxy 副本抽取为共享脚本（会动
  tmux/verify 的 pin）。
- 批量评论的 UX 是否需要在 lifecycle 评论之外加轻量进度信号（暂不提议动作）。

## 观察（既有问题，范围外）

- `Notify silent triage re-run` 步骤假设 defer 会留下 `COMMENTED` review，但
  skill 的 defer 路径只发 issue comment 加 assignee，从不提交 `COMMENT` review。
  该步骤的 `deferred` 分支今天看起来不可达。
- `SKILL.md` 禁止触碰 `welcome-pr` process label，而
  `references/issue-workflow.md` 指示给无复现 bug 加它。publisher 只校验 label
  存在性，不裁决这个冲突。
