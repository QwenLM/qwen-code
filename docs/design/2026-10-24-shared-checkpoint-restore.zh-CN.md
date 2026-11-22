# 共享 checkpoint restore 正确性

[English](2026-10-24-shared-checkpoint-restore.md) | [中文](2026-10-24-shared-checkpoint-restore.zh-CN.md)

## 状态与范围

基于 [#15384](https://github.com/QwenLM/qwen-code/pull/15384) 的完整会话重放/恢复批次。精确源码、产物及运行时结果记录在本批 PR 的验证报告中。它修复现有 Ink checkpoint restore 行为，不宣称新增 OpenTUI checkpoint 创建或切换默认 renderer。B 将依赖该共享合同交付完整 OpenTUI 捕获、scheduler/writer 与热/冷验收。Read generation fence 纳入本次 A，不另开细碎 PR。历史 aggregate 运行只证明原缺陷与预期行为，不代表本提取版本已验收。

## 问题

加载保存的 API history 会清除 prior-read 权限，因此 checkpoint edit 即使成功回退文件仍可能拒绝重放。本地重放还拥有新的物理执行 ID：若将其视为无关模型结果，原逻辑 pending call 会悬空；若保留旧 active journal 后缀，冷恢复会看见过时 OLD1 与废弃回答，而非实际 NEW2。

## 副作用前的 restore 权限

从 checkpoint API history 唯一解析原 pending function call，核对名称、原模型参数、逻辑 ID 与最近真实 user prompt 元数据。捕获真实 recorder/session，并在文件 rewind、UI history load 或 API history replacement 前验证已持久 assistant anchor。缺失、歧义、已配对、错误 prompt 或 recorder 必须在这些副作用前拒绝。无 pending API history 的 legacy tool-only checkpoint 保留原本地行为；关闭 recording 的会话保留 hot-only 路径。

替换 history 后，若现有 edit 目标要求先读，使用真实 interactive scheduler 执行新 Read，保留既有 client-tool Mod policy 和普通 Core Read 权限/hooks。Ask 使用已有 confirmation API，不追加新的 UI history。拒绝、取消、abort、owner 丢失、session 替换或原参数变化均不可授权 edit。新文件创建和缺失目标保持既有合法语义。真实 Read 执行时采样 cache-clear generation，防止过时读取的 fast path、record 或 catch cleanup 跨 replacement generation 授权或误清继任权限。

checkpoint writer 保存原逻辑 call ID，实际执行参数可被合法 hook 或审批改写，不与原模型参数混为一谈。新 checkpoint 按 call ID 选择原调用；旧格式仅允许同名调用唯一时恢复身份。执行参数在合法改写后不能证明原调用身份，因此缺 ID 且有多个同名候选时，即便某组参数恰好匹配，也必须在副作用前拒绝。recorder anchor 始终用原模型参数校验。调度前将物理 execution ID 绑定到现有 owner，完成时校验执行 ID 与工具名称，并保留原会话、history revision、tail 和 recorder guards；允许同一授权执行的实际参数变化，实际结果仍配对原逻辑调用。

## 实际重放绑定

绑定捕获 config、client/chat identity、session、replacement revision、真实 history tail/length、原调用身份、当前 submission owner 和精确 recorder。即使传相同 array/tail/length，破坏性/替换 chat API 仍推进 revision；普通 append 不推进。append 周围仍需 raw-tail/length 和真实 owner 检查。restore-only captured submission predicate 防止竞争请求接管已接纳的 restore。

在调度前将绑定注册到已有 Ink continuation owner。UI/telemetry 保留重放的新物理 ID。真实工具及 PostToolUse hook 完成后，使用实际最终 parts、终态、输出文件/artifacts 与 Goal provenance，不以合成 OLD success 或复制响应冒充 NEW。重复完成最多启动一次 durable publication。持久发布前和 API append 前均复核 owner；strict recording 失败不得追加 API result。完成时实时收集 file-history snapshots，保留日期与 backup 元数据。

## 持久冷分支

复用已有 active branch、topology fence、rewind record、strict append 和 metadata projection。唯一解析已持久的原 assistant-call anchor，保留完整 message、media 和兄弟调用。仅将所选重放的实际新结果以原逻辑 ID 发布；旧结果/回答离开 active ancestry，原 raw records 仍物理保留。未重放兄弟保持真实 missing/error 或实际 cancellation，不伪造 success；不悄悄引入 single-pending-only 拒绝策略。

strict write 部分失败时保持真实 persisted cursor。若 rewind 已落盘而 NEW result 写入失败，应报告真实 partial branch，不宣称 atomic rollback，也不将未持久 result UUID 当 cursor。fence 释放时，buffered successor records 必须保持实际重新挂接的 topology、turn boundaries、title 和 snapshots。录制的提示身份与父边界须从同一批保留记录重建，确保后续提示的普通回退保留已恢复的祖先链。session、owner、writer lease、prompt 和 metadata guard 均绑定到捕获的操作。

## Confirmation 消费者

现有 Ink extension-consent hook 与 OpenTUI generic consent bridge 均消费此共享 command API 的 signal/current 选项，对 pre-aborted、过期、卸载或 late-yes callback 单次拒绝，释放 listener 并保留无关 successor dialog。这是已有 API consumer 修复；A 不增加 OpenTUI scheduleTool/capture/snapshot port。

## Ready 前验证

在实际提取源码上执行正常 build、完整 typecheck、lint 及所有受影响 CLI/core 完整文件。保留真实 Read descriptor/cache race、破坏性 chat revision、recorder disk/lease/fence 失败、command pre-effects 拒绝、permission deny/cancel/current loss、captured binding/duplicate/recorder replacement、两种已有 confirmation consumer 与实际 Ink completion owner 测试。语法解析不等于上述门禁。

以新完整 inventory 绑定产物，在 Node+Ink 与 Bun+Ink 执行永久 checkpoint case：真实模型 Read/Edit 和审批 checkpoint、原 backup A、初次 OLD1、实际回退 A、仅一次批准重放 NEW2、明确 followup 中以原逻辑 call 配对 NEW2、两次自然退出、相同 UUID 冷恢复及 active-ancestry/backup/old-answer 负控。记录 raw HTTP、journal、PTY、实际 runtime 与有限 cleanup。多调用兄弟真实状态和权限/owner 负控仍需实际验证，单个 selected case 绿不能冒充它们。其他 collected 名称明确为 NOT_SELECTED，不算产品通过。需两轮 clean 源码审查与实际 fresh 验收。B 只有具备真实 creation/capture/writer consumer 后，才将同一永久 fixture 扩展到严格 OpenTUI。

## 边界

不引入新 schema、全局 registry、通用 snapshot 框架、runtime pin、headless/updater 行为或自动 LLM 请求。不宣称全部平台、安装包或未来 B 行为已验收。即使超过建议规模，也保留完整事务与测试，并提供实际生产/测试/文档统计供评审。
