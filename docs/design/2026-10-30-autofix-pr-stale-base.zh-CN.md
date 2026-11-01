# /autofix-pr：stale-base 提示与 base 合并

[English](2026-10-30-autofix-pr-stale-base.md) | [简体中文](2026-10-30-autofix-pr-stale-base.zh-CN.md)

状态：提案（2026-10-30）

## 问题陈述

PR 分支可能仅仅因为 base 过期而 CI 变红：`main` 已经带上了某个修复（依赖升级、被修正的测试、被改名的符号），而分支还没有合入它。今天的 `/autofix-pr` skill 识别不了这种情况，也永远不会为此合并 base：

- brief 模板对失败 check 只有二分法：PR 代码或测试的缺陷 → 修复；PR 之外的失败（网络、runner、无关的 flaky 测试）→ 不改任何东西，报告 `rerun`。
- base 过期型失败落入第二类。`rerun` 对同一个 (check, head, attempt) 只重跑一次；再次失败后，round 回答 `needs_human`。分支依旧落后，watch 把重跑预算花在一个重跑永远修不好的失败上。

CI 侧的 fleet workflow（`.github/workflows/qwen-autofix.yml`，rationale `af-109`/`af-110`）早已处理这种情况：红 check 在当前 `main` 上绿、且 PR 落后时，通过 `PUT /pulls/<n>/update-branch` 合入 `main`。本地 skill 与之不对齐。

## 现状

已在 `origin/main` 的 `38337f7257`（2026-10-30）上核实：

- `packages/cli/src/commands/autofix-pr/snapshot.ts`：`PR_QUERY` 取 `mergeable`（`MERGEABLE | CONFLICTING | UNKNOWN`），但不取 `mergeStateStatus`。gate 与 round snapshot 都不携带任何"分支落后于 base"的信号。
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` 的 brief 模板已含有合并 base 的配方（`git fetch <remote> <baseRefName>` 后 `git merge --no-edit FETCH_HEAD`，绝不 rebase），但只有 `conflict` 事件会触发它。
- 没有任何 helper 调用 `PUT /pulls/<n>/update-branch`，且 skill 规则 1 禁止模型绕开 helper 做 GitHub 写操作。
- `rerun.ts` 对每个 (check, head, attempt) 只允许一次重跑；同一 attempt 的第二次失败按真实失败处理（`needs_human`）。

## 目标

- round snapshot 在分支落后于 base 且有 check 失败时告知 fix agent。
- brief 指示 fix agent 在这种情况下先合并 base，复用现有 conflict 配方与现有 `push` 通道。
- 不新增 GitHub 写面；gate 探针保持不变。

## 范围边界（非目标）

- 不做"PR 上红、当前 main 上绿"的归因（workflow 的强判据）。它每次判定要多三个 REST 读取，留作可能的后续工作。
- 不做 `update-branch` API helper。所有写操作继续经 `push`。
- 不改重跑预算、push 预算（`MAX_PUSHES`）、信任规则与 gate 游标。
- 不做 `mergeStateStatus`/`BEHIND` 检测：GitHub 只在仓库开启"合并前要求分支最新"保护时才返回 `BEHIND`，对未开该保护的仓库是盲区。

## 提议的改动

### 1. `snapshot.ts` —— 仅在 prepared 模式做惰性 compare

- 新导出函数 `baseIsBehind(state, headSha)`：读取 `gh api repos/<owner>/<repo>/compare/<baseRefName>...<headSha> --jq .status`，仅当结果为 `behind` 或 `diverged` 时回答 `true`。任何错误（网络、跨 fork head 在 base 仓库无法解析时的 404、畸形输出）都回答 `false`：round 不带提示继续。
- `runSnapshot`（prepared、非 gate 路径）在 `buildSnapshot` 之后：当 snapshot 的 action 为 `fix` 且事件中至少有一个非 `startupFailure`、且未 `exhausted`（修复推送用完、这一轮不修复的检查）的 `ci_failed` 时，调用 `baseIsBehind`；回答 `true` 时，给写入 snapshot 文件与单行 stdout 摘要的 snapshot 加上 `baseBehind: true`。
- `Snapshot` 增加 `baseBehind?: true`，注释说明仅 prepared 模式：分支落后于 base，失败 check 可能是 base 的错。
- gate 路径（`runGate`、`buildGateSnapshot`）不动：它本就会在每个新的失败 attempt 上唤醒 round，由 round 重新计算提示。安静的 PR 零开销。

### 2. `SKILL.md` —— 提示与合并 base 的指令

- Round 步骤 2 在 `lagging` 与 `truncated` 旁边说明 `baseBehind: true`。
- brief 模板的 "What to do" 在 "Failed check" 之前新增一条：当 snapshot 标有 `baseBehind: true` 时，先合并 base（`git fetch <remote> <baseRefName>` 后 `git merge --no-edit FETCH_HEAD`，绝不 rebase），并解决任何冲突。合并已修好的失败 check 不需要改代码；其余的按下方失败 check 的规则处理。
- summary 指引说明：base 合并与其他已推送的修复一样报告。
- brief 的 Events 范围句豁免"这些指令点名的字段"，使 brief 不会禁止它所命令的 base 合并；`SKILL.test.ts` 的一致性 pin 保持两者一致。
- 用户指南的 round 描述（`docs/users/features/autofix-pr.md`）用一句话补上同一行为：分支落后时失败的 check 会先合入 base。

### 3. 测试

- `snapshot.test.ts`（或按 `snapshot.gate.test.ts` 既有 mock 模式组织的同置测试套件）：mock `gh` 后测 `baseIsBehind`（`behind`、`diverged`、`ahead`、`identical`、抛错）；`runSnapshot` 的标志条件（有失败 check → 发起 compare；无失败 / 仅 `startupFailure` / 仅 `exhausted` / `lagging` → 不发起 compare）。
- `SKILL.test.ts`：按既有压平文本断言风格为新句子加 pin。

## 设计决策与理由

- **REST compare 优于 `mergeStateStatus`。** `BEHIND` 依赖分支保护配置；`compare` 在任何仓库都是权威判据。调用是惰性的——只在已有新失败 attempt 的 round 里多一个 REST 读取——且任何错误都降级为"无提示"，gh 链路抖动不会让 round 失败。
- **弱判据（落后 + 红 → 试一次合并）优于强归因。** 提示是建议性的：fix agent 仍会读每份日志。误报的代价是一次 base 合并，而落后的分支通常本来就需要它。三条性质在不新增任何 state 字段的情况下约束重复：
  1. 失败按 (check, head, attempt) 只报告一次，提示只会出现在本来就有新东西要处理的 round 里；
  2. 合并成功后分支包含 base，`compare` 回答 `ahead`，提示自行熄灭；
  3. 验证或推送失败的 attempt 以 `needs_human` 结束，`handledChecks` 在同一 head 上抑制这些失败。
     曾考虑显式的 `baseHintSha` 守卫，因与上述三条重复而放弃。
- **经 worktree 与 `push` 合并，优于 `update-branch` helper。** 保住 skill"所有写操作经现有 helper"的不变式；不改 `allowedTools` 与工具 schema；合并经过本地验证，冲突时进入现有 conflict 解决流程；与后台 fix 模式兼容。
- **是提示，不是事件。** `baseBehind` 不新增 `SnapshotEvent`、不改 `action`、不碰任何游标。action 的选择保持与之前完全一致的事件驱动。
- **compare 方向 `<base>...<headSha>`。** compare 的 status 描述 head 相对 base 的状态（`behind` = head 缺少 base 的提交），与 fleet workflow 的用法一致。跨 fork 的 head SHA 在仓库网络内可解析；解析不了时，错误降级为"无提示"。

## 约束与风险

- 每个有失败的 round 多一个 REST 读取；gh 链路抖动时提示静默缺失（有文档的降级，与今天的行为一致）。该读取共享 gh 传输层的瞬时错误重试（3 s + 6 s 退避），因此瞬时 5xx 下退化代价约 9 秒，随后 round 不带提示继续（验证轮实测）。round 路径没有读取预算可超；gate 的 15 s 预算不受影响。
- 误报会多一个 merge commit，并消耗 watch 的 `MAX_PUSHES`（10）之一。接受：落后的分支要变得可合并，本来就需要这次合并。
- merge commit 移动 head，所有 `synchronize` 触发的 workflow 会重跑——与任何修复推送的成本曲线相同。
- autofix worktree 可能没有 `node_modules`，本地验证受限。这是 worktree 设置的既有约束，本设计不改变它。

## 验证计划

- mock `gh` 的单元测试覆盖 `baseIsBehind` 与 `runSnapshot` 的标志条件（见上文测试）。
- `SKILL.test.ts` 为新 brief 与 round 文本加 pin。
- 在真实落后 PR 上对 compare 端点做只读实测（E2E 测试计划中的 dry-run 基线）。
- E2E 测试计划：`.qwen/e2e-tests/2026-10-30-autofix-pr-stale-base.md`。
- `npm run build`、`npm run typecheck` 与改动文件的聚焦单元测试。

## 验收标准

- PR 有失败 check 且分支落后的 prepared watch，其 round snapshot 带 `baseBehind: true`；分支最新时不带；compare 失败既不使 round 失败也不置位标志。
- gate 输出不变：无新字段、事件或游标键。
- brief 指示合并 base，skill pin 覆盖新句子。
- 构建、类型检查与聚焦测试通过。

## 开放问题

- 是否根据真实 watch 观察到的误报率，后续升级到强归因（"这里红、main 上绿"）与专门的 `update-branch` helper。
