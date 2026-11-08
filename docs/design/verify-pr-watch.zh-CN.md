# verify-pr 的 watch 模式

[English](verify-pr-watch.md) | [简体中文](verify-pr-watch.zh-CN.md)

Status: implementing with this change.

## 问题

维护者跑完一轮 `/verify-pr <n> --publish` 后，得自己盯着有没有新提交，再手动开下一轮。仓库其实已经把自动触发的两半都做出来了——一个只打印"自上次以来的变化"的 PR 探针，和一个 gate 跑在模型之外的定时任务——但没有任何东西把它们接到验证轮次上，于是每个维护者都要自己重新拼一遍 cron，并重新踩一遍它的坑。

## 现状

- `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo>`（PR #15057）带游标，只输出新的转变：head 变了给 `head_moved_externally`、每个 attempt 一次的 `ci_failed`、他人评论、merged/closed。**静默表示没变化。**
- `cron_create` 接受 `gate`（PR #15211）：调度器在每次 fire 前于**模型之外**跑这段 shell。无输出则整次 fire 跳过；有输出则把 JSON 作为数据投给会话。gate 必须 recurring，current-session 任务必须 durable。
- 这两半都不认识 `/verify-pr`；skill 里也从没提过 watch，于是维护者要一个 watch 时只能临时拼 cron：gate 可能指向一个没有探针的二进制，prompt 可能在重启后重验同一个 head，任务在 PR 合并后还活着。

## 方案

给 skill 加 `--watch` 模式。它是**组合**而非新管线：探针仍是 CLI 命令，触发仍是带 gate 的定时任务。

- `/verify-pr <n> --watch` 为该 PR 建一个 recurring gated 任务，随后本身仍按普通轮次执行。被触发的轮次默认按 `--publish` 走（维护者要的是长期观察，不是只发一条评论）。
- 任务形态：cron 每 2 分钟；gate = `node <clone>/scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli <绝对路径 qwen>`；`recurring: true`、`durable: true`、`sessionMode: "current"`。包装脚本只转发 `resync`（head 移动）与 `stop`；评论或 CI 失败是 `action: "fix"`，会被丢弃——调度器只要看到非空输出就开一轮，prompt 无法"取消"已经开始的那一轮。
- prompt 消费包装转发的输出：`head_moved_externally` → 对该 sha 开一轮；`stop`（merged/closed）→ 删除任务并停止。
- 包装脚本的 `--check` 在 `.qwen/tmp` 已存在 `autofix-pr-<n>-gate.json` 或 `autofix-pr-<n>-state.json` 时拒绝安装：一个游标只服务一个消费者，第二个 watch 会抢走第一个需要的 head 移动与 `stop`。
- 去重写在状态文件（`.qwen/tmp/verify-pr-watch-<n>.json`）：本会话已验过的 sha，加一个 in-flight 标记。同一 sha 的重复 fire、或一轮还在跑时的 fire，都不产生模型 turn。**先写 sha 再开轮次**，这样中途死掉的轮次不会重放同一个 head。

## 设计决策

1. **做在 skill 里，不新增 CLI。** 探针与 gate 都已存在，缺的是两者之间的约定，而这份约定就是 agent 要遵守的 prose。新增命令只会重复它无法拥有的调度那一半。
2. **gate 用绝对路径。** gate 在新 shell 里跑，而 `PATH` 上的 `qwen` 可能早于探针。skill 要求先用 `which qwen` 取路径并确认 `autofix-pr snapshot --help` 能跑；没有该能力的二进制意味着任务永远不会触发，此时必须拒绝而不是排一个坏 gate。
3. **安静时零模型 turn。** gate 静默即跳过本次 fire，这正是重点：每次 tick 只花一次 `gh api`，110 分钟的轮次只在 head 真的变了时发生。
4. **`merged`/`closed` 时停。** 活得比 PR 久的 watch 会一直探一个死端点，还可能白唤醒模型；`stop` 事件删除任务。
5. **过滤做在包装里，不做在 prompt 里。** gate 的输出决定是否开一轮；等到 prompt 读到它，轮次已经开始。所以 `scripts/verify-pr-watch-gate.mjs` 是可测试的代码，skill 指向它而不是裸探针。
6. **共存直接拒绝，不假装多路复用。** 探针每个 PR 只有一个游标，而 `autofix-pr prepare` 过的 watch 还会通过 `knownHeads` 抑制 head。要"验证自有状态"需要探针提供当前不存在的开关，因此 watch 直接拒绝：明确说"不支持共存"，好过两个 watcher 静默互相饿死。只读检查本身有竞态——两个会话可以在任何探针跑之前都通过——所以安装时用 `wx` 原子地写下 `.qwen/tmp/verify-pr-watch-<n>.owner.json`，停止或建任务失败时释放。已存在的 claim **绝不自动抢占**：用时间戳判定过期本身就是同一类竞态，死掉的安装要用 `--release` 显式释放。

## 范围边界

- 不改 GitHub Actions：CI 的 verify lane 仍然由评论触发。
- 不做 webhook：不订阅仓库事件，不引入转发进程。
- 不新增 daemon 路由或设置项，`cron_*` 与探针按现状使用。
- 仓库级观察（`qwen review watch-repo`）作为"盯所有 open PR"的方式写进文档，但 `--watch` 本身仍是**按 PR**：验证轮次天然按 PR。

## 影响文件

- `.qwen/skills/verify-pr/SKILL.md` —— `--watch` 的契约与护栏。
- `scripts/verify-pr-watch-gate.mjs` —— gate 包装：只转发 `resync` 与 `stop`，并在别的消费者已占用探针状态时拒绝安装。
- `scripts/tests/verify-pr-watch-gate.test.js` —— 过滤的几种结果与共存检查。
- `scripts/tests/qwen-triage-workflow.test.js` —— 钉住包装命令、过滤、归属检查与二进制能力拒绝。
- `docs/design/verify-pr-watch.md` + `.zh-CN.md` —— 本文档。
- `.qwen/e2e-tests/verify-pr-watch.md` —— 测试计划与结果。

## 风险

- watch 会活得比创建它的会话更久（durable），所以状态文件与 `stop` 规则就是防止它变成僵尸的东西。
- gate 要跑 `gh` 且必须已认证；未认证的 runner 会让 gate 失败，调度器按 streak 报一次。skill 要求排任务前先确认 `gh auth status`。
- 每次 fire 花一次探针；2 分钟节奏约 720 次/天/PR，远在 API 预算内但并非免费——skill 明说这个代价，而不是藏起来。

## 验证计划

- 真实 PR 上的探针行为：不变时静默、head 变化后输出 `head_moved_externally`、再跑静默。
- 有能力的构建上的任务创建：`cron_create` 接受该 gate、拒绝 one-shot、拒绝超过 2048 字符的 gate。
- 降级：没有 `autofix-pr` 的二进制必须让 skill 拒绝并说明升级什么。
- stop 规则：merged 的 PR 产出 `stop`，任务被删除。

## 验收标准

- `/verify-pr <n> --watch` 产生的任务在 PR 安静时 gate 无输出，head 变化时输出一行 JSON。
- 同一 sha 的第二次 fire 不产生第二轮。
- `merged`/`closed` 后任务被移除，或可用 `cron_delete` 手动停止。
- 探针或 `gh` 不可用时什么都不排。
