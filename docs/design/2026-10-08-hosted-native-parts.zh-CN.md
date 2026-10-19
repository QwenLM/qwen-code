# 为 K2 对话前置保留原生模型 Parts

[English](2026-10-08-hosted-native-parts.md) |
[简体中文](2026-10-08-hosted-native-parts.zh-CN.md)

状态：已实现并完成本地无工具 producer 前置的独立验证；私有 Java 对话准入仍待完成。源码基线：
`88c72fa1a8c30826a3995f32beebe3abc64203f8`。
这是 K2 和 Draft PR #13526 的前置工作，由 #13395 跟踪。
[batch 设计](2026-10-08-k2-native-batch-reservation.zh-CN.md) 记录剩余的私有
对话、分配与执行工作。

## 1. 问题与当前行为

在源码基线上，Hosted 模型调用方从流事件累计展示文本，无工具分支仅返回该文本
和模型名称。主流程与恢复流程因此在写入 assistant 时重建一个文本 Part。实际 provider
history 可以包含更多 Parts，包括带 `thought: true` 的推理，这些内容在此边界
丢失。工具分支已克隆完整的最终模型 history，保留 Part 顺序，并将 function ID
关联到实际流调用。

K2 必须取得原 assistant 及其完整 Part 位置，才能认可对话或 batch。
伪造空工具回调以走到已有 Parts 返回，会掩盖无工具行为缺口，也不会连接私有
Runtime Session。

## 2. 提议变更与消费者

两个分支都读取并克隆实际最终模型 history，随已有展示文本与模型名称返回完整
Parts。保留已有模型角色和 history 缺失拒绝；保留工具分支的实际 function 数量、
名称、call ID 核对，以及全部无工具流拒绝。不从展示文本重建 Parts，不增加开关。

任一分支的 `MessageDisplay` 抑制都必须同时返回空文本与空 Parts，避免被抑制的
答案成为持久 assistant 内容。Retry、fallback、continuation 和 Stop 决策维持当前
顺序；这些决策之后的最终模型 history 是返回 Parts 的来源。克隆数组不能与
provider history 共享引用。Hook 生成的停止原因继续使用已有显式合成文本 Part。

生产变更仅涉及 `packages/cli/src/serve/hosted-harness-model.ts` 及其同位置测试。
`hosted-harness-session.ts` 的两个 assistant 消费者已优先消费 `result.parts`，
再使用历史文本 fallback，无需新增选择器。Message projection 和后续模型 history
经已有 sink 取得保留的 Parts。不增加 daemon 路由或 API。

## 3. 原生产记录采集与边界

使用自有 loopback OpenAI 兼容服务和实际 CLI settings/config/provider SDK。
在自有子进程中以 `QWEN_HOME` 隔离配置、以 `QWEN_RUNTIME_DIR` 隔离运行制品。
将 `QWEN_CODE_SYSTEM_SETTINGS_PATH` 与 `QWEN_CODE_SYSTEM_DEFAULTS_PATH` 指向
自有空配置；使用仅含自有 provider 凭据和 endpoint 的受控子环境，不继承未知
proxy/provider 覆盖。观察实际 endpoint 请求；仅设置环境变量不能证明路由。Provider fixture 提供确定的
SSE 推理和答案内容；它是受控协议基础设施，不是真实外部模型。

通过完整 `openManagedSession` Session、`submitInput`、真实模型槽 controller 与
model scope、Harness、模型调用方和 sink 采集原文本链。普通 ChatRecord 使用已有
Hosted 结构；原 authority 必须生成事件、资源和 hash。采集 user、started/terminal
attempt、assistant、原子 settlement/checkpoint，并在同一 Session 上运行下一 turn。
保留原 bytes 和两条 parent 链。私有 Hosted turn 调用方没有导出，因此自有采集在该调用方 seam 使用已有 Hosted
结构组合普通 ChatRecord。Session、controller、model scope、模型调用方与 sink
保持原实现且未打补丁；这不是公开 HTTP turn 或私有生产 runner。
自有 HTTP store collector 只能证明生产输出，不能证明私有 Java/SQL 准入或生产私有 Harness runner。

本变更不开放公开私有 profile 选择器，不在 Java 准入这些对话事件，不分配 batch、
执行工具或认可 CSI retirement。测试清理使用的通用 Session close 不能作为物理
writer 终止、DRAINED/RELEASED 或 NodeUnpublish 的证据。

## 4. 验证与验收

独立基线已尝试全局安装 CLI（0.24.6）并记录内部入口边界。实际构建的 Hosted caller
通过自有 provider 复现了缺口：两个完成回合都缺少 Parts，assistant 资源丢失推理，
下一次请求缺少 `reasoning_content`。同一原 Session 采集了三个 turn 场景，包括真实
无工具调用方对工具请求的拒绝。这些是 producer 观察，不是 SQL 准入。

实现后，聚焦 CLI 测试覆盖完整有序 Parts、克隆、两个分支的抑制、history 缺失、
原工具拒绝及 retry/fallback 行为。独立验证修改后的构建前，先完成 build、typecheck
和 bundle。验证完整返回 Parts 进入原 assistant 资源，且下一 turn 请求保留这些
内容；记录实际 native grammar 与尚未支持的私有消费者边界。

修改后构建的独立验证通过三个唯一 turn 场景：两个完成的推理/答案回合在原
assistant 字节及 projection 中保留完整有序 Parts，下一次实际 provider 请求保留
`reasoning_content`，真实工具请求 SSE 仍被拒绝且不产生 assistant 或 tool intent。
19 项数据/字节/协议审计谓词全部匹配，与单测和 CLI metadata 数量分别记录。
两个聚焦 CLI 文件报告 272 个测试用例通过，build、typecheck、bundle 和范围 lint
通过。自有进程、端口及临时文件均已清理。Collector/组合 seam 与 Darwin 环境继续
受上述边界限制；这些观察均不授予 Java/SQL、部署 CSI worker 或完整 K2 资格。

验收要求原无工具 producer 保留实际 Parts，无需伪造工具分支，同时抑制与已有工具
行为维持正确。独立报告必须区分 producer 采集与 SQL 准入，并保留自有清理和精确
执行来源。Native 对话准入仍是后续 fresh/history 共享 fold 的独立变更。

## 5. 风险与待确认项

保留 provider Parts 会改变普通无工具 transcript 内容。必须明确验证展示抑制与
history 复用，不把可见文本等同于全部持久 Part。已有资源大小限制继续生效。
Provider 特有 Part 字段仍是原 provider 数据，不是新增 K2 grant。

后续对话设计必须根据这些实际采集确定 message/model-attempt、usage 和 checkpoint
的封闭语义。不能用推断的 `modelAttemptId` 字段、手写事件序列或完整 K2 声明代替
这些证据。
