# K2-A2：文件工具与历史共用一个保留后端

[English](2026-10-08-k2-retained-file-backend.md) | [简体中文](2026-10-08-k2-retained-file-backend.zh-CN.md)

状态：实现设计，2026-10-08。基线为
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 中的
`3d64d91d35bd74ce6a4c8f5ba5ca091940d61d28`。
本文实现[原生文件链](2026-10-07-k2-native-file-execution.zh-CN.md)中的存储组件；
不启用 boot4/CSI2、原生修改准入或公开 CSI 选择器。

## 1. 问题与范围

挂载现在通过可等待完成、验证前后的回调借出原 root，Read 也能在完整格式流程中
使用同一个描述符。实际 Write/Edit 的元数据、mkdir、写后 stat 仍使用路径名。
历史校验、指纹、备份复制、复用和 diff 同样使用路径名及全局 home 目录。
仅替换文本写入会遗漏这些路径。

增加一个具体 Linux 后端与内部文件专用组合器。组合器实际把后端设置到 Config，
并在历史初始化前传入同一对象，含回滚构造器。旧调用方省略依赖时保持原行为。
通用 worker 继续拒绝保留 profile：组件组合不构成原生派发授权。

## 2. 原目录与生命周期

后端借用传入的原 `ManagedCsiMount`，不重新打开第二个 root。
保留同设备上 `.qwen-csi-file-history/<规范 owner UUID>` 的 no-follow 目录描述符。
首次绑定排他创建 owner 目录；任何既有 owner 目录（包括空目录）均拒绝接管。
既有 prefix 目录只在同设备 no-follow 检查后打开。缺失目录只能从已准入父目录逐个合法组件创建、同步父目录并保留原身份。
在每个完整操作前后验证命名入口与描述符身份。

工作路径必须是该逻辑挂载 root 内的规范绝对路径。拒绝整个保留子树及原/临时
备份 inode 别名。沿 `/proc/self/fd/<parent fd>` 使用
`O_DIRECTORY | O_NOFOLLOW` 逐组件遍历父目录。叶节点只准入同设备普通文件，
使用 `O_NOFOLLOW | O_NONBLOCK`，保留全部父目录至最终检查和关闭完成。
只有通过这些检查的父目录/叶节点缺失才表示不存在；其他错误不能变成空文件。
按原 device/inode 拒绝备份别名，包括部分失败尝试保留的 handle。

首次 await 前登记待完成工作。close 立即封锁新工作、保留唯一 promise，等待已准入
操作并仅关闭一次全部自有描述符。身份、I/O、复制、同步、关闭失败持续可见且阻断；
借用回调不能等待自身 close。非法词法输入在 I/O 前拒绝。
包装器只借用后端，元数据回滚不会关闭它。

## 3. 有限工具与历史契约

现有 FSS 增加可选 `textFileIo` 成员，其两个方法在成员存在时均必需。
实际私有 producer 同时填充两者；Standard/ACP 省略该成员。

| 操作               | 实际行为                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`          | 一次可等待完成的只读 missing/file 观察，返回解码文本、编码/BOM/行尾及同 fd 的 Stats；不 mkdir，不提供 writer，不泄漏描述符。                                                                                   |
| `withMutation`     | 在实际 execute 全程保留同一原 root，提供新的原内容观察及唯一绑定 writer。writer 只接受该逻辑路径，仅被调用时创建父目录，在准入 inode 上写入编码字节，同步文件/父目录并返回实际提交 Stats；回调结束后不能使用。 |
| FSS `withReadFile` | 使用现有完整描述符 Read 流程，保持全部格式及 helper 生命周期要求；缺失 Read 抛错，不退回 Standard 路径。                                                                                                       |

确认和 modify 使用 `inspect`。execute 在算法、writer 和结果期间使用
`withMutation`。其 Stats 替换直接写后 stat，父目录创建替换直接 mkdir。
私有组合器继续禁用 Config 内重复的工具历史及 prior-read 缓存校验。
保持既有编码和结构化工具错误语义。artifact 元数据使用已准入的规范逻辑路径与
返回的 Stats，不在私有写入后解析第二条路径。Config 构造时的 root 元数据观察
也处于原挂载借用范围内。

有限工具的默认权限保守返回 `ask`，不查询 host memory 或按路径名规范化。
逻辑工作区 `.qwen/team-memory` 子树仍启用敏感信息扫描；no-follow 后端拒绝
别名，不解析别名。私有 Read 跳过 host Git/home 自动记忆归属和路径名
`.qwenignore` discovery。该内部 profile 依赖后端成员准入，不启用自动记忆
权限豁免，也不声称具备普通本地 ignore 策略。普通工具保持既有权限、记忆
及 ignore 行为。有限修改同样不进入 host Git commit attribution；实际变更由
managed 保留历史记录。

既有文件写入保留准入 inode。这不是原子替换或 compare-and-swap：中断写入可能
留下部分工作字节和持续 blocker，保留的原始 preimage 不受清除。
新文件使用排他创建；execute 前观察为缺失的父目录逐个排他创建，不退回递归路径。
外部并发原地 writer 不在本组件的不可变内容版本保证内。
未来私有修改准入仍要求原生 prepared history。

`RetainedFileHistoryStorage` 只有三个必需方法：`withWorkingFile`、
`withBackupFile`、`createBackup`。前者借出描述符 source 或真正不存在的 null。
第二个认证既有原 pin，绝不返回 missing。第三个把原始字节复制到唯一、排他、
no-follow 叶节点，通过同一组 handle 处理短读/短写、保留权限，在成功前同步文件
和目录。

排他创建后、写字节前，立即登记备份尝试 handle/inode。排他创建及原 inode 登记、
完整目录 inventory 检查和别名检查通过同一内部队列串行执行。inventory/别名检查
等待此前的创建完成登记；创建不能在该检查期间改变 inventory。字节复制在队列外
进行，嵌套历史借用不会等待自身。独立于旧 snapshots 保留
这些 handle、不可变成功 pin 及失败尝试。失败复制不覆盖、不删除、不作为替换重试，
也不通过重算当前字节 hash 接管。每次借用备份前后检查原命名/描述符 inode、
原始 digest、长度和 mode。元数据回滚不能丢失原 pin。

## 4. 实际历史消费者与组合

在恢复 snapshot 校验前，把后端沿私有组合器 → tool set → executor history bind →
`ManagedRuntimeFileHistory` → 正常/回滚 `ManagedToolFileHistory` →
`FileHistoryService` 传递。全部保留 stat/read/备份/校验/复用/diff/指纹操作使用
有限端点，在进入旧路径 helper 前选择该分支。指纹按位置分块 hash 并使用捕获 mode。
非 null 备份缺失是错误。

保留失败必须传播，不能省略行、标记正常缺失、修复失败元数据或发布已完成 snapshot。
并行组的所有已启动操作完成后才能返回组失败。diff 的相同备份指针快速分支仍须认证。
第 101 个 snapshot 在 I/O 或元数据变化前拒绝。保留 `getDiffStats` 拒绝超过既有
`MAX_DIFF_SIZE_BYTES` 上限的内容，不再无界读取；`getTurnDiff` 保持既有 oversized
行行为。rewind、apply、cleanup 在破坏性 I/O 前拒绝。

内部组合器只构造 Read/Write/Edit，通过 Config 现有 setter 实际设置后端，提供
保留观察和可等待完成的 close。保留观察将完整实际目录 inventory 与原尝试比较，
认证全部成功 pin。未知/未完成叶节点阻断资格确认。既有 snapshot projection
保持封闭；目录/pin 是供后续 schema-2 producer 使用的独立观察。
组合器观察等待捕获的历史 tail 完成、认证存储 inventory，再检查历史元数据是否
在借用期间发生变化。组合器 close 立即封锁其 tool set 与后端，等待捕获的历史
tail 和后端操作，最后关闭传入的原挂载。这不构成聚合 worker QUIESCENT/DRAINED
或原生授权。此处不增加 route、provider worker 或环境选择器。

## 5. 涉及文件与验证

修改 CLI 保留后端/组合器、executor 历史依赖和 managed runtime history；core FSS、
FileHistoryService、managed history、Read/Write/Edit 与团队记忆敏感信息 guard；
邻接测试和本文双语版本。Read 完整 source 格式流程与旧 helper 不需要缩减格式。

先用全局 `qwen` 建立普通文本工具基线。独立验证实际组件组合，build/default permission/confirmation/modify/execute
无路径名 discovery、Node 命名导入正控制、团队记忆敏感信息拒绝保持，缺失与拒绝区别、
非 UTF8/BOM 原始备份、原 pin 替换/变更、硬链接别名、symlink/父目录替换、
短写/同步失败与保留 orphan、回调/writer close 等待、全部历史消费者与回滚、
snapshot 容量及被拒 rewind。确认预览不创建目录，返回 Stats 来自实际提交 fd。
运行聚焦 core/CLI 测试、build/typecheck/bundle、自审和仓库 review 流程。
Darwin 测试必须标明映射 fixture，不能声称真实 Linux syscall 资格；Linux-only
跳过项明确报告。后续仍须新的 Linux CSI/MySQL/Hosted 证据。

## 6. 验收与剩余工作

组件验收要求真实 producer 填充两套契约、全部有限消费者使用同一原 owner，
保持旧兼容性并通过独立失败/生命周期验证。裸接口或仅测试 setter 不算已连接生产实现。

完整 A2 仍要求 boot4/CSI2、精确原 native reservation → intent → prepare → prepared →
整批 outcomes/checkpoints、helper 资格及保留 Session 完成。K2-B 聚合 drain/物理
stop/NodeUnpublish、K2-C 原子 release/reuse、K2-D 公开/deployment/新云上验证仍未完成。
继续 Draft 并要求 maintainer review。组件结果或绿色 CI 不替代这些门禁。

寻址与同步设计使用文档化的
[Linux directory-fd/open 行为](https://man7.org/linux/man-pages/man2/open.2.html)及
[Node 22 FileHandle 操作](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle)。
这些 API 本身不证明并发安全、原 CSI 身份或物理 writer 关闭。
