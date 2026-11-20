# OpenTUI 扩展批次刷新

[English](2026-11-15-opentui-extension-batch-refresh.md) | [简体中文](2026-11-15-opentui-extension-batch-refresh.zh-CN.md)

组合检查点：这些已审修改现已迁入基于实际 main 检查点 `dab5253c` 的独立 Source 组合候选，不包含 SkillReview PR 的未合并增量。下文 `b6ec` / `7220` 结果属于原双工作树候选；在准备时，该组合尚未 build 或运行产品，未继承其通过资格。

## 状态与问题

这是基于3165314、分支 `fix/opentui-source-batch-refresh-20261115` 的实现候选。修复前，一次聚焦挂载回归失败，其余18项 filtered：第一插件 runtime reload 发生在下一插件安装器之前，原红结果保留。独立临时诊断另观察到一次从 A install 调用返回 Promise 到调用者恢复 await 共4.773s，包含初次同意等待，随后额外 native reload 耗时7.820s才开始 B。这是单次执行边界时长，不是性能分布，也不能确认唯一 OS/锁根因。

此前对应公开 Source 矩阵 Node/Ink、Bun/Ink 通过，strict Native 在 B 同意前失败。已安装 global Ink 对照达到业务流程，但冷自然退出仍失败。历史上，此时两者均不能转成新修复通过，正常检查及三 profile 验收尚待执行；当前检查点见下文。

## 行为与范围

Ink 顺序处理所选插件，不在项间执行完整 CLI runtime reload。Core 安装已尝试刷新 runtime tools；Native 又在每项后刷新 extension cache、tools 和 host commands，因此重复 runtime 工作延迟下一同意提示。

本修正只改三份 CLI 生产文件。Acquisition 保持解析、同意/设置提示、abort、所选 manager 参数、scope 偏好及 committed-warning 分类。第四个局部参数 `reloadAfterInstall = true` 保持既有单项默认；Discover 明确传 false，Sources 保留默认 true。刷新策略独立于 `rememberScope`，不加环境 flag、Core API 或权限绕过。

Discover 以必填 `reloadRuntime` callback 接入已有 guarded catalog reload，批次开始时与 installer 一同捕获。所有目标决策结束后，若至少一项已提交（含 committed-with-warning），在 catalog/status 完成及解锁前恰好 await 一次。全失败批次不 reload；单项详情或仅 B 重试仍 finalization 一次。A 成功/B 拒绝仍为 partial1/failed1 且选择清空，不自动重试 B 或追加同意输入。

## 所有权与失败

所选 Config/manager/session/cwd owner 仍是唯一权威。Finalization 前后检查捕获 owner 的 liveness；既有 mount callback 在 runtime/command reload 前后亦核对 owner。替换或卸载后，旧操作不能再分派目标或向后继发布状态。现有 API 不能原子取消已分派刷新。

刷新失败只追加 warning 详情，不改变已提交计数或覆盖 partial error。Scope 偏好和 committed-warning 行为不变。Finalization 期间保持批次锁，在显示最终状态前更新热命令。父 catalog-change 通知仍是 UI refresh，不代替异步 runtime finalizer。不改 watcher 或共享 reload helper。

## 消费者与验证

Acquisition hook 仅有扩展 dialog 的 Discover wrapper(第四参数 false)与 Sources wrapper(默认 true)两个生产调用。Discover 列表、详情、重试均走同一批次循环。Mount 继续提供相同 owner-guarded reload 和既有刷新状态通知，Sources 保持单项刷新及 catalog 加载。

保留挂载红测试，新增有意义的顺序/所有权覆盖：两次 installer 先于一次批次刷新、A 提交/B 拒绝、committed warnings、全失败、刷新失败保持计数、真实第四参数 false 接线、Sources 默认、单项详情/重试以及 stale/unmounted owner。Root 在实际应用验收前执行受影响整文件、build/typecheck、零警告 lint、格式及 bundle。

最初验收计划使用 a8be fixture 与0cae公开用例，验证 Node/Ink、Bun/Ink、strict Native，保持整案120s/local15s/CI45s/零重试及记录的外层180s。要求 A 批准/B 拒绝、精确 partial 和选择清空、明确仅重选 B 并重新同意、精确 ID/metadata/commit/policy/commands、热冷补全、模型 HTTP0、publisher/只读保护和两次自然退出。此段为最初待执行计划。后续只加强 Sources 列表准入并增加数据观测，未改业务断言、输入或预算；当前实际结果见下文。

## 当前验证检查点

当前已观察检查点：生产候选仍为产物 `b6ec1bb9…`（12 文件 tree `4dd28184…`），正常验证记录 148 项测试通过。独立验收 harness tree `7220217e…` 的 14 项 helper 合同测试以及 build、typecheck、针对性零警告 lint、格式检查通过；两者范围分离，不是 162 项应用测试。更强的 Sources 列表准入 predicate 和生命周期观测只改变 harness，不改变该生产产物、输入或预算。

| 当前已观察 profile | 完整公开 Source 整案 | 公开自然退出           | 模型 HTTP |
| ------------------ | -------------------- | ---------------------- | --------- |
| Strict Bun/OpenTUI | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |
| Bun/Ink            | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |
| Node/Ink           | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |

这三次执行达到 A 批准/B 拒绝、partial 状态与选择清空、明确仅重选 B/重新同意、精确持久 metadata/commands 及热冷补全，并保留 publisher 保护。Git/catalog 流量独立于模型 HTTP，且不为零。覆盖仅限 command-only HTTP catalog→Git fixture，不包含本地目录 publisher 或 hook-sensitive Source 路线。此前 `2a86` 失败以及同一 `b6ec` 的 Native 冷启动超时、Bun/Ink Sources 详情准入失败均保持原记录；新通过不证明这些失败已修复，也不解释其原因。已安装 global Ink 的冷退出失败也仍未关闭。

Bun/Ink 冷启动的 observer spawn-marker→ready 区间为 27.177843 秒，接近未改的本地 30 秒 ready 窗口。该时钟属于 harness observer 进程，spawn marker 在 PTY 创建后发出，因此不是完整进程初始化时长或精确 deadline 余量。同步 raw-output/lifecycle 文件写入可能扰动调度。每 profile 单次通过不证明启动失败频率、稳定性、性能改善或无观测 I/O 的结果。Config 修改仍需 Tier 2 维护者审查；跨平台/native 事件稳定性、最终 main 验收及整体迁移完成均未取得资格。

## 边界

这是窄范围刷新顺序修正，不是 Core、watcher、锁、策略或平台修复。原 Source 失败与 global 冷退出失败保持原记录。不声称最新/最终 main、安装包、Windows/Linux、GUI/设备、切默认、删除 Ink、发布或迁移整体验收通过。
