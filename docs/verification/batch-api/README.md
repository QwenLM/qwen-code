# Batch API 验证工具

本目录是 `qwen batch` 传输层与 `/batch-api` 工作流（PR #12492）的离线验证工具：
假服务器 + 真实构建产物，不联网、不需要凭证、不花钱。设计约定见
[`docs/design/2026-09-23-agent-prepared-batch-api.md`](../../design/2026-09-23-agent-prepared-batch-api.md)，
首轮人工实测数据与分析见 [`results-2026-09-23.md`](./results-2026-09-23.md)。

## 工作流 E2E（主验证入口）

`workflow-e2e.mjs` 自带假 Batch API、隔离 `HOME`，驱动构建产物 `dist/cli.js`
走完整链路：预检、提交、运行中收取、`--wait` 收取、文件交付、幂等重收（不重下载、
不重删远端）、截断失败、截断项不带更高上限时被跳过、提高上限后重试、目标冲突 held、
解决后交付、任务取消、清理（未收取时拒绝），共 27 项断言：

```sh
npm run build && npm run bundle
node docs/verification/batch-api/workflow-e2e.mjs "$(pwd)/dist/cli.js"
```

最近一次：2026-09-24 在 review 修复后的 head（`d400a1c3`）上 27/27 通过
（macOS arm64 / Node 24）；更早一次在 `06a1278572`（macOS / Node 22）通过。

## 传输层回归

`fake-dashscope.mjs` 是假的百炼兼容服务（`/files`、`/batches`、`/batches/:id/cancel`、
`/files/:id/content`、`/chat/completions`），按场景推进 batch 状态并记录每条请求；
`regression.sh` 驱动 `npm run dev` 的**真实 CLI 进程**跑 happy / stuck 两个场景，
断言退出码、stdout 与请求序列（`fake-dashscope.mjs` 支持 `SLOW_SECONDS` slow 场景，
但脚本没有启动它，`pollJob` 的 slow 分支未被覆盖）：

```sh
bash docs/verification/batch-api/regression.sh   # 约 10–15 分钟（受 tsx 冷启动影响）
```

覆盖（R1–R4）：submit 只创建一个 batch（不被内存重启重复提交）、四个子命令退出码、
已结算作业的 cancel 被拒绝（与真实提供方一致）、运行中作业的 cancel 成功、
远端文件在 `--delete` 后被清掉、鉴权门禁（QWEN_OAUTH 下退出 1 且不落进主流程）、
未 settle 时拒绝 fetch。

它证明的是 qwen-code 这一侧的进程行为，**不能**证明服务商侧的协议行为。

## 一次性探针与阶段 B（已删除，结论保留）

早期评估用的线上探针 `00-plumbing` / `01-tools` / `02-cache` / `03-queue-timing`
（及其 `lib.mjs`）、阶段 B 付费对照的辅助脚本 `stage-b-*`，连同
`docs/plans/2026-09-14-batch-api-feasibility.md` 都已完成使命并从分支删除
（需要时从 git 历史恢复）。它们的结论保留如下：

- **判定（2026-09-18/19 实测，华北2·北京，`qwen3.7-max`）**：工具调用能穿过 batch
  body（01 通过）；batch 内不命中 context cache（02 两臂 `cached_tokens: 0`，
  实时对照 0.647，`cost_vs_realtime = 1.03`）→ 只做形态 A（扇出），不做
  headless `--batch` 置换（已从 #11874 移出）。
- **阶段 B（真实付费对照）还没跑**：方法纲要在 `results-2026-09-23.md` 第六节；
  在跑完之前，任何"省钱"结论都只是估算。
