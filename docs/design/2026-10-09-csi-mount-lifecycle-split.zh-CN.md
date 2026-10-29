# CSI 挂载身份与等待操作结束后的关闭

[English](2026-10-09-csi-mount-lifecycle-split.md) | [简体中文](2026-10-09-csi-mount-lifecycle-split.zh-CN.md)

## 状态与范围

本变更从 Draft PR #13526 的 `311b29ef5dec41f0a9da6d57885eade3ecd2e5fb` 向 main 拆出根目录与挂载生命周期组件。拆出的候选已通过有界本地 build、typecheck、bundle、针对性测试与独立产品验证。真实 Linux/CSI 验收仍开放。它适用于既有 boot-v3 CSI worker，不启用新的 worker、执行 profile 或公开选择入口。

## 问题与当前行为

既有 CSI mount 检查内核挂载元数据、可信磁盘序列号及根目录 device/inode。目录解析随后在两次观察之间委托给路径名遍历，而继承的根目录查询不执行 CSI mount 检查。分离的观察无法在整个解析期间保留原始目录。引入持有的描述符也需要明确的关闭责任方：启动失败与 worker 关闭必须等已接纳操作完成后释放它。

## 设计与消费方

原始根目录 owner 使用 `O_DIRECTORY | O_NOFOLLOW` 打开一个目录，记录描述符 device/inode，并在每个回调前后比较规范路径名对应的目录与描述符。身份不确定时永久阻断 owner。每个操作在首次 await 前登记；close 同步阻止新操作、保留同一个关闭 Promise、等待所有已登记操作结束，并仅关闭一次描述符。

首次获取的校验失败时，清理仍关闭已获取的描述符。清理失败保留两个错误并使 mount close 拒绝；清理成功的普通获取拒绝不会被误报为清理失败。独立拆分评审发现源实现缺少这一区分，因此本切片还包含该局部修正与正反回归对照。

CSI mount 将观察、根目录查询及目录解析包在该原始根目录作用域中。内核挂载元数据与序列号检查覆盖完整回调，包括失败路径。普通回调失败向外传播，但不使身份未变的挂载失效；根目录、挂载或序列号不确定时阻断挂载。开始关闭后不能进行新借用。

解析仅接受规范化的 Workspace 相对目录语法，包括 `.`。它逐个路径组件沿 `/proc/self/fd/<parent fd>` 使用不跟随链接的目录打开操作，在原始 device 上校验描述符与路径名身份，持有所有父目录直到遍历完成，并等待每个子描述符关闭。目录缺失、符号链接、非目录叶子、不同 device 及子目录被替换均拒绝解析。子描述符关闭失败保留为可观察的永久阻塞。复用既有 CLI Workspace 路径校验器；本切片无需将它移动到 core。

既有 CSI attestation 路由消费观察；既有 context 安装与 runtime-provider 目录选择消费解析；既有 sibling-directory 所有权检查消费根目录查询。它们的路由作用域仍分别属于原 live worker 与已安装 Session。普通 context mount 保留原实现。worker 启动在路由登记或监听失败后关闭 CSI mount；worker 退出在早先清理失败时也通过等待完成的清理关闭 executor、监听器与 mount。

只有已知挂载根目录且它不同于调用方目录时，sibling 所有权判断才允许调用方使用私有目录豁免。挂载根目录被阻断或身份不确定时，不能将无法解析的 sibling 转化为读取许可，包括阻断发生在已接纳的工具调用内部时。启动与关闭保留原始错误消息，并通过 `AggregateError` 保留同时发生的清理失败；executor 关闭结束后，无论成功或失败，都尝试清理监听器与 mount。mount close 同样保留子目录和根目录描述符的双重失败。

## 文件与拆分边界

生产改动仅包含 `managed-csi-root-directory.ts`、`managed-csi-mount.ts`、`managed-context-worker.ts` 的 sibling 所有权判断及 `managed-runtime-attestation-worker.ts` 的清理部分，并附带同目录测试与本设计文档对。排除源分支的 boot-v4/v5 支持、私有 file-profile 检查和移动到 core 的路径校验器。既有 boot-v1/v2/v3 解析、路由及选择入口保持原状。

## 验证与验收

先执行已安装全局 CLI 的基线 dry-run 和独立基线产品模块探针，因为 CLI 没有通用 CSI 测试命令。验证原描述符复用、规范化嵌套目录解析、根目录/挂载/序列号替换、符号链接、错误 device、畸形路径、并发回调、首次获取期间关闭、立即阻止新操作和仅一次清理。通过既有 worker 入口检查启动登记/监听失败及 executor 关闭失败。对拆出的候选运行 build、typecheck、bundle、针对性 CLI 测试、源码 lint/format 检查、两轮干净的完整 diff 自审与独立评审。

Darwin arm64、Node v22.22.3 与 pnpm 11.24.0 上的本地验证通过 build、typecheck、bundle、范围内 lint/format 与六个针对性 CLI 测试文件（970 通过，一个仅 Linux 的 procfd 测试跳过）。独立验证通过 16 个编译后产品行为用例及一项 API 能力检查、两个首次根目录获取清理对照与四个打包 CLI 子进程用例；基线和中间清理失败证据分别保留。这些结果仅在所述 fixture 边界内验证该组件。

Darwin 测试可使用实际拥有的目录与描述符，并明确标记合成的 Linux mountinfo、序列号及 procfs 地址适配。此类结果证明有限组件行为，不代表 Linux procfs、ext4/NVMe、Kubernetes CSI 或云环境验收。Windows 不接纳 CSI mount；仍可测试其拒绝路径和普通 worker 兼容性。

## 风险与剩余工作

前后检查无法发现两次观察之间所有先替换再恢复事件。持有目录描述符可防止被替换的父路径名重定向遍历，但不能提供不可变文件系统快照。返回的路径名只是经验证的目录选择，不是未来 I/O 的能力凭证。回调必须等全部自身工作完成后返回，且不能保留或关闭借用的描述符。

持有的描述符也会在健康 worker 拥有它期间使卷保持 busy。需要卸载存活 worker 卷的退休或 NodeUnpublish 消费方必须等待描述符释放；Kubernetes 在容器退出后的常规 unpublish 不受影响。本切片不实现该退休协调。

本切片不提供私有 Read/Write/Edit、file history、不可变 native 授权、SQL 迁移、receipt-tail 恢复、聚合 DRAINED、后代进程终止、CSI NodeUnpublish、原子 RELEASED 或安全卷复用。这些仍保留在 #13526，分别受独立验收门槛约束。没有线协议格式或数据库迁移。
