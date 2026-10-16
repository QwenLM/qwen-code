# K2：在完整操作期间借用原挂载根目录

[English](2026-10-08-k2-scoped-mount-root.md) | [简体中文](2026-10-08-k2-scoped-mount-root.zh-CN.md)

## 状态与问题

2026-10-08。本项是[原生文件执行设计](2026-10-07-k2-native-file-execution.zh-CN.md)
的一项实现依赖，基于 `950950311f102a745556debc261009af677b125c`，归入 Draft PR
#13526 和跟踪 issue #13395。它不代表私有文件 worker 通过资格验证，也不代表 K2 完成。

原 `ManagedCsiRootDirectory` 已持有唯一目录描述符，检查名称与描述符身份，同步登记
callback，并在关闭前等待 callback 完成。但 callback 不能使用这个描述符。
`ManagedCsiMount.observe()` 只拥有一次观察；`resolve()` 结束观察后，交给路径解析，
然后再观察一次。中间的解析和后续文件后端都没有在完整操作期间借用原描述符。
继承的 `rootDirectory()` 也绕过了 CSI 挂载观察器。

## 范围与决策

扩展原 owner，不重新打开根目录，也不引入另一 owner。`withVerifiedDirectory()` 只在
callback 返回的 promise 生命周期内借出原 `FileHandle`。调用方不得关闭它、在 promise
结束后保留它，或启动脱离该 promise 的工作。只读可用性 getter 让挂载层区分 owner
身份失败与普通 callback 失败。

添加 `ManagedCsiMount.withVerifiedRoot(operation)`。在首次打开 mountinfo 之前登记
pending，包含首次取得目录描述符的阶段。调用 callback 前检查 Linux 支持性、有界内核
mountinfo、可信 serial、原 mount/root 身份与既有 pin。借出原描述符与冻结 receipt，
callback 之后再次检查内核、serial 和 pin，包括 callback 失败的路径。原 root 检查
包围整个 callback。挂载或 root 身份不确定时永久 fence，并启动保留的 close，不能在
当前 callback 内等待自己完成。若权限身份保持不变，普通 callback 错误直接向上传递，
不丢弃原 mount。Close 等待所有 callback 和元数据句柄。

`observe()` 使用同一操作返回 receipt。`rootDirectory()` 使用它返回验证后的逻辑根目录。
`resolve()` 只接受既有规范 Workspace 相对目录语法，包括 `.`。从借用的原 root 出发，
每次只追加一个组件到 `/proc/self/fd/<parent fd>/<one component>`。每个子目录用
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW` 打开，用 BigInt 描述符与名称 stats 比较，并
要求属于原设备，直到 walk 结束才释放。在释放子描述符前再次检查整条名称链，对最终
描述符验证读与搜索权限。即使一个 close 失败，也关闭其他已取得的子描述符。Close
失败必须向上暴露并 fence 挂载，不能把失败的 close 算作完成等待。

这是 Linux 专用目录解析。目录缺失、各级 symlink、非目录、其他设备和非法路径都拒绝
本次解析。它不为未来操作永久 pin 每个子目录，也不会把返回的 pathname 变成 I/O
能力。后续文件工具仍必须自己借用原 root，并保护实际叶访问。本实现不追加多组件
procfd 后缀、不独立重开根目录，也不回退到继承的路径解析。

Linux 机制基于 [open(2)](https://man7.org/linux/man-pages/man2/open.2.html) 的稳定描述符
与最终组件 flag 语义、进程自己的 [proc fd 条目](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html)，
以及 [Node 22 FileHandle 操作](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle)。
这些 API 定义说明实现依据，实际消费者在目标平台上的行为仍须测试验证。

## 文件与消费者

| 层             | 变更与实际消费者                                                                       |
| -------------- | -------------------------------------------------------------------------------------- |
| 原目录 owner   | `managed-csi-root-directory.ts`：callback 接收原句柄；可用性由挂载层读取。             |
| CSI 挂载 owner | `managed-csi-mount.ts`：统一完整操作范围，观察、context 目录解析及根目录解析实际调用。 |
| 既有 worker    | CSI attestation 和 context installation 使用这些方法；不新增 route 或配置字段。        |
| 测试           | 两个 owner/mount 同目录测试覆盖借用身份、callback 等待、失败与目录解析范围。           |

普通 `ManagedContextMount`、boot1/2/3、CSI1 envelope、私有 reserved digest 的拒绝、
route 所有权和公开选择器保持既有合同。本项不创建新 generation、SQL 权限、原生
history record、backup pin 或私有文件变更权限。

## 验证与验收

编辑前由独立 test engineer 在自有目录运行全局 `qwen` CLI，并以脚本 fallback 调用
基线的生产 owner。记录缺失的借用及生命周期缺口，不把全局普通 CLI 行为作为 CSI 资格。

验证原描述符复用、成功与失败 callback、多个 pending callback、同步 close fence、
首次元数据取得期间 close、callback 之后的 root/mount/serial 替换，以及每个子描述符
的清理。验证 `.` 与多级规范目录、各级 symlink、错误类型或设备、walk 中目录替换、
目录缺失和非法 cwd；不得回退到 pathname。重复既有 context/CSI worker 的拒绝与普通
兼容性检查。完成 build、typecheck、bundle、相关测试和两轮完整 diff 的干净自审。

Darwin 测试可以使用真实自有目录描述符，但替代元数据和 proc 地址必须明确标为 fixture。
这些测试不证明 Linux procfs、ext4/NVMe、真实 CSI、私有 worker 或完整 K2。真实 Linux
和云上资格仍需分别提供证据。原生 review 使用仓库 workflow；workflow 不可用时明确
报告，不能用 approval 声明替代。

## 剩余集成与风险

下一项必要连接是具体私有 Linux file/history 后端：借用此原范围，保护 reserved backup
子树与 retained backup inode，供应实际 Read/Write/Edit 和每个 history constructor。
原生 schema2 intent 必须在 preimage I/O 之前持久提交；invocation 采用父设计明确列出
的九个字段。Prepared 批次结算、retained pins/orphans、helper 生命周期、Hosted
消费及不可变 retirement inventory 仍需完整连接与测试。DRAINED、物理 writer 终止、
NodeUnpublish、RELEASED、安全复用和公开上线继续保持门禁。

前后身份检查不能检测所有发生在两次观察之间的替换再恢复。目录描述符能避免 walk
跟随被替换的父目录进入另一个目录，但不提供不可变文件系统快照，也不隔离控制进程或
mount namespace 的 actor。调用方若不把借用期间所有工作纳入返回的 promise，就违反
范围合同，不能据此主张 retirement 资格。
