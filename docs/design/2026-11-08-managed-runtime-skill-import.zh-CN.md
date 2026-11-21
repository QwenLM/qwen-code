# Managed Runtime Skill 快照导入

[English](2026-11-08-managed-runtime-skill-import.md) | [简体中文](2026-11-08-managed-runtime-skill-import.zh-CN.md)

## 状态与依赖

本实现于 2026-11-08 从已评审完整 head `4736349cbe5d60f39251a148ef17df5f764a03bb` 拆出，依赖 PR #16500 的归档/表单安装，不依赖个人 MCP OAuth。在自身源码、契约和 CI 证据得到确认前保持 Draft。原整包 CI 不构成拆分后 head 的验收。

公共安装权威入口见[英文自助配置设计](2026-11-07-managed-skills-mcp-self-service.md)和[中文自助配置设计](2026-11-07-managed-skills-mcp-self-service.zh-CN.md)。

## 目标与边界

允许获授权用户从所选 Session 实际拥有的执行 Runtime 发现项目 Skill，审阅固定快照并显式安装。不回退到 daemon、主 Workspace 或替代 Runtime。发现与准备不创建 Runtime，不修改 Session 配置。

只使用所选 Workspace 的 `.qwen/skills` 和 `.agents/skills`，保留现有优先级并标记被遮蔽的候选。排除用户、全局和扩展目录。返回名称、描述、相对路径、兼容性结果和摘要。不支持的 manifest 成为不兼容候选，不使整个发现响应失效。名称最多 256 字符，描述最多 4096 字符，均不得含 NUL。

## 原 owner 约束下的来源访问

Hosted 能力为 `managed-runtime-skill-import/1`。通过现有 Runtime Broker 扩展元数据边界增加候选、快照及归档操作。只有候选查询可在没有预期 generation 时定位现有 owner。快照和归档请求携带已观察的 binding ID/generation；实际读取始终位于原 ready owner 和已解析的 Workspace。

Runtime worker 解析所选 Session 的挂载目录，并应用既有文件系统准入和跨 Session 目录归属检查。控制面不拼接同名主机路径。未知、非 ready、已变化、不可信或 draining 的 owner 明确失败，不申请 placement、不替换 attachment、不切换来源。发现 Harness boot 变化时使缓存 client/attachment 失效，不重放触发该发现的调用。

## 快照与发布

选择候选后才复制。复制前后检查文件身份、目录成员及内容摘要；来源变化返回 `source_changed`。发布复制出的不可变字节，并写入服务端生成的非执行来源元数据，包含 Workspace、相对路径和摘要。不承诺对任意并发写入提供文件系统事务。

每个 worker 最多保留 256 个快照、并发准备两个、累计保留归档最多 512 MiB，十五分钟后到期。读取最后一块后仍保留归档，使响应丢失时可以重试。复用 100 MiB 压缩内容、1 GiB 展开内容和 100,000 条目限制，以及路径越界、链接、特殊文件拒绝规则。控制面下载限制并发，所有路径归还 permit，包括临时文件分配失败。

每个归档块继续检查授权、Session 和原 owner。其准入开销属于承接的评审事项；本次拆分不为吞吐量删除这些检查。传输结果未知与来源拒绝保留不同的有界错误，不泄露私有传输细节，不重放操作。

复用首阶段的包预览、发布回执、settings 和显式 apply。编译器、包及选择协议保持版本 1。再次导入发布新的包 revision；更新保留原扩展身份，仍需用户对空闲 Session 显式应用。不增加 watcher，不自动刷新模型可见目录。

## 契约与 UI

在 `/v1/agents/sessions/{sessionId}/extensions/skills` 下增加候选查询、快照准备和快照导入，同步 WebShell provider、生成类型及 Java SDK。准备描述中返回原 owner/generation。保持精确输入幂等，拒绝快照摘要或目标不匹配。

Managed 扩展/Skills 视图提供“从当前 Workspace 导入”。一次确认发布/应用前先预览所选快照。Session 变忙、来源变化或 owner 被替换时要求重新显式确认。apply 无法继续时仍展示已发布内容；精确选择得到 `active` 回执前不显示已安装。

## 验证与发布

只有 `qwen.managed-agent.extensions.runtime-skill-import-enabled`、首阶段自助配置开关均开启且 Harness 支持能力时才能启用。关闭入口保留已发布包，不引入来源监听。

验证候选优先级、不兼容内容、所选目录约束、链接/特殊文件、来源变化、原 owner 替换、分块重试、保留容量和清理。验证 UI 的固定 operation 身份及显式 apply，保留无关扩展和基础 Hooks。复用仍有效的首阶段检查，执行受影响的 Runtime source、Hosted 路由及 WebShell 导入测试/build/typecheck。

Java 源码复核不构成已执行的契约覆盖。`ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`、SDK/传输门禁、真实 MySQL、原 Runtime 进程和进程故障验收仍需匹配 head 的 CI 证据。共享本地 Java 预算已经耗尽，本 PR 不重置预算。

## 承接的评审事项

保留 #16500 的原评审记录。非关键延期事项包括改变已审阅来源后残留的更新目标、完整 `503`/`415` 响应文档，以及更全面的分块/容量覆盖。延期不等于实现或验收；本次拆分不增加行为来关闭这些事项。安全及原 owner 准入继续生效。
