# K2 保留快照与 Agent 产物

[English](2026-10-18-k2-retained-artifacts.md) | [简体中文](2026-10-18-k2-retained-artifacts.zh-CN.md)

状态：基于 `cb806e74bf`，继续 #13395 和 Draft PR #13526 的拟议增量。

## 问题与完整目标

剩余 K2 目标包含可信安装与隔离、原 stop/unpublish 资格、最终物理 authority 与原子释放、保留回执校验，以及安全后续周期复用。本改动不删除其中任何要求。当前安装输入不能证明宿主互补策略、完整 actor/admission 边界或冷安装的 CSI 独占接线。此前限时实验节点不能提供当前资格。

一个可独立实现的依赖已位于生产保留进度路径中。`WorkspaceCsiApplicationHistory.readRetainedProgress` 通过 `HistoricalScan` 审计结构化载体，但其原生资源解码器不识别真实生产者生成的 snapshot manifest/page 和 agent instructions/skills。因此，其他合法公共 Session 也能阻断原退役的检查。仅把这些 kind 加入允许列表会隐藏所有权引用、缺页或借用的消息正文。

## 实现

复用 `ManagedSnapshotStore` 的真实 manifest/page DTO 解码，不改变序列化 DTO、已存字节、公共读取行为或 SQL schema。历史解码另外要求严格 JSON 类型、完整字段及现有有界行 metadata/digest 检查。

对于已发布快照，在原只读 Connection 上获取准确同租户/Session 的 root、manifest、有序页面及 SNAPSHOT 引用。检查标准 snapshot/resource 身份、root 版本/序列/projection/条目数、manifest digest 和 cursor-secret 编码、连续页序号、页面序列 metadata、条目归属与成员，以及完整正文引用集。页面末序列 metadata 是末项的 firstSequence。条目按 firstSequence 再按二进制 item-ID 排序，允许 firstSequence 相同。每页最多包含生产者规定的 100 项；单个大条目仍有效。空快照没有页面，只有 manifest 引用。旧 published root 在 retain_until 之后或不再是当前快照时仍有效，直到回收移除。root 和每次附加读取共享原有去重行数、完整行字节和耗时预算。

快照保留的旧消息正文不必仍是 `ma_message` 当前正文。根据保存条目的 owner 和 digest 核对真实资源身份；正文 revision 必须是规范正整数且不大于保存条目 revision，因为终态投影可以只更新条目而不重写正文。使用正文的 descriptor 必须有空的内联 content 列表。逐个 snapshot owner 要求准确引用集；同一正文还可以有当前 MESSAGE 引用和多个快照引用。验证生产消息 part 格式及其被 descriptor 覆盖的范围，不能只信任引用。快照与正文资源、快照引用保持生产者的空 workspace/publish-command/journal 字段。公共页面和正文使用原共享字节预算，不继承无关 native kind 的 8 MiB 上限。仅完整验证的图才能覆盖其页面、正文和引用。和原生 chunk manifest 一样，先处理 manifest 再处理被覆盖资源。未知格式、缺失 root、不完整图、意外引用和原所有者引用仍拒绝，不能扩大原期待像或引用根。

Agent instructions 保持有界 UTF-8 文本，包含生产者允许的空字符串，不作为嵌入 JSON 解析。Agent skills 复用现有已准入 skill 校验器。两者均要求真实内容寻址资源 ID、publish-command 身份、scope、schema 和 digest。指令或 skill 文本中出现字面标识符不会产生所有权引用。

## 涉及组件与决策

- `ManagedSnapshotStore`：提供包内共享解码和 DTO，保持生产者及公共行为。
- `WorkspaceCsiApplicationInventory`：将已识别产物接入现有历史扫描，包括完整 snapshot/body 归属和共享预算。
- 定向 inventory/producer 测试及 MySQL 集成场景：由真实 store 生成产物，再在只读快照中检查真实行。

不增加 route、可选运行开关、存储客户端、writer、authority DTO 或 migration。外部结构化对象存储载荷及尚不支持/孤立的载体形式继续拒绝。这些剩余 decoder 域仍属于完整 K2 工作，本增量不宣布整个历史读取器完成。

## 验证与验收

先以全局 CLI dry-run，并记录私有 Java 读取器必须使用 test-script fallback 的原因。实现前用真实公共 snapshot 和 agent-resource 生产者生成正向图，确认基线拒绝；实现后确认接受，同时期待历史字节不变、不增加根且没有写入。

覆盖空快照、多页面、仅由快照保留的旧正文、不同租户同本地 ID、字面 instruction/skill 文本、畸形 UTF-8/JSON/类型、错误内容寻址身份、缺失/额外/错序页面、root/ref/body/scope/sequence/digest 变化、条目 attributes 隐藏原引用、未覆盖资源及共享行数/字节/期限限制。保持现有未知/外部载荷拒绝。运行受影响 Java 测试、含静态门禁的模块 verify，以及一次性 MySQL 8.4 验证。分别保留失败及条件 skip。完整增量经过连续两轮 clean 自审及代码审阅。

验收结论仅覆盖这组共用历史产物解码器及真实调用者。当前原生 Linux/Kubernetes 安装、完整 Hosted 故障组、最终物理释放、已释放历史回执及跨周期复用仍需各自完整证据，整个目标才能结束。
