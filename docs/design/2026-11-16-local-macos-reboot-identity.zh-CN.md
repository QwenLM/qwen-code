# 本地 macOS 重启恢复与文件系统身份

[English](2026-11-16-local-macos-reboot-identity.md) | [简体中文](2026-11-16-local-macos-reboot-identity.zh-CN.md)

## 问题与范围

macOS 重启后可能为同一个 APFS 卷分配不同的 `st_dev`。当前本地存储登记对数值设备号、inode 和原生出生时间计算摘要，会话 worktree 另行保存同样包含设备号的 JDK file key。因此，正常重启后两处校验都可能拒绝原目录。Linux 已有可信整机重启的 writer-stop 恢复，但设备号发生变化时，数值存储身份仍有同样的局限。macOS 还明确排除了使用其原生 boot 身份进行该类恢复。

本次增加稳定的 macOS 卷身份，将现有显式开启的整机停止证明扩展至 macOS，并为旧登记及其已完成的会话 worktree 提供显式离线重新认定。保留原会话、未提交文件、Git 分支、journal 和不可变 Runtime 请求。Linux 文件系统 UUID 探测、目录搬迁、冲突物理 owner 合并及中断 Git 维护的恢复不在本次范围内。

## 稳定身份与兼容性

macOS 原生读取器先解析 canonical 路径的 FileStore 设备，再从有界 `diskutil info -plist` 输出获取唯一 `VolumeUUID`。校验返回设备，并在探测前后复核路径的数值设备号、inode 和创建时间。UUID 缺失、歧义或格式错误时拒绝。不跨探测缓存设备到卷的映射。

新存储登记使用去连字符的小写 UUID 作为 32 字符设备身份、`local-storage/2` 物理 key 命名空间和版本 3 存储 marker。旧的无符号十进制设备号最长 20 字符，继续使用版本 2 marker 和 `local-storage/1`。普通校验仍能将旧登记与当前数值身份完整比较，但不会推断历史 UUID 或改写登记。文件读取、上传协议通过旧式原生读取路径继续接收当前数值 `stat.dev` 和 inode。

新的 macOS worktree 锚点使用带版本的 `macos-volume/1` 身份，包含卷 UUID、inode 和 JDK 创建时间。旧锚点继续完整比较包括设备号在内的旧 file key。稳定身份覆盖根目录、源 common Git 目录、目标 worktree、gitfile 和登记的 Git 元数据目录。仍要求 canonical 路径、无符号链接、gitfile/反向引用/common 目录精确匹配以及完成记录。

## 整机 writer-stop 证明

设置 `trusted-local-reboot-recovery=true` 后，仅在已保存 Runtime 的硬件 host 相同、平台 namespace 形态相同且原生内核 boot ID 不同时，才能使用现有重启清理。macOS 使用成对的 `macos` namespace 标签和 `kern.bootsessionuuid`；Linux 保留现有来源。进程重启、同 boot namespace 变化、其他主机或平台不匹配均不足以作为证明。

清理在现有锁下将原登记置为 retired，并返回既有丢失和 writer-stop 证据。既不启动替代进程，也不向其他 boot 的 PID 发信号。Broker 清理仍只收敛不确定执行、不重新派发，并仅释放原 binding/generation。新执行仍需另行授权准入。

## 显式离线旧身份重新认定

私有维护入口接收准备好的请求和 `--offline-confirmed`。操作员停止共用 catalog 和目录的全部服务，并保存干净的数据库、状态和文件备份。请求标识精确旧 owner、预期当前卷 UUID、原生 host/boot 证据、全部逻辑 alias、全部已完成 worktree 行以及精确旧 marker 字节。只读预演在修改前生成完整清单。这是操作员建立新的可信基线，不是证明未记录的历史卷 UUID。

工具支持一个物理 owner 及其全部已完整登记的 alias。存在其他重叠 owner、清单不完整、活动 Runtime binding、执行成员、holder、上传、维护、journal writer lease 或未收敛生命周期操作时拒绝最终提升。在持久围栏保护下，retire 为每个精确原 generation 取得 claim，仅记录与保存的 seed、handle 和 lease 匹配的原生丢失与 writer-stop 证据。随后由 Broker 恢复执行既有的有界 abandonment/成员清理，再到达退休终态。工具不会通过改写 Runtime handle、seed、请求、凭据、lease、generation 或执行成员来伪造清理。

工具验证 canonical 路径、host、inode 和出生时间未变，旧 worktree 锚点的 inode/创建时间未变，Git 登记精确匹配，存储/计划/完成 marker 的原字节完全一致。旧 worktree 锚点必须位于显式认定的卷。二进制升级之后、重启之前创建的 worktree 在旧 owner 上已携带稳定锚点：plan 对照认定卷校验这些锚点，并原样保留其计划与完成记录，仅改写旧锚点。计划仍为旧格式、但完成记录已按稳定格式捕获的情形（升级后重试被中断的准备流程），升级计划锚点并保留完成记录字节。锚点指向其他卷，或稳定计划搭配旧完成记录时，拒绝。持久化 `STORAGE_MIGRATION` 操作，以 `same-path-identity-reattest/1` 请求子类型保存完整新旧清单和 marker 字节。在改文件前对现有 alias 和 owner 安装准入围栏。复用现有 schema 类型，无需重建 catalog。

已提交且因 `hosted_harness_recovery_blocked` 停驻的 RUNNING Turn 可以在同路径身份修复时保留原状态，前提是全部原 Runtime 已退休，且没有 holder、执行成员或有效 journal writer。其他活动 Turn、待处理命令和生命周期操作仍阻塞提升。该例外不修改 Turn 或输入记录，也不授权重放；是否继续执行仍由普通 Harness 恢复决定。目录搬迁有不同约束，保留其既有的全部活动 Turn 拒绝规则。

每次 marker 替换仅接受记录的旧字节或本操作预期的新字节，写入并 fsync 临时文件、原子替换 marker，再 fsync 所在目录。若不匹配则保留围栏并拒绝。相同操作可依据持久 receipt 重试；相同 ID 的不同请求被拒绝。

全部新 marker 和原生身份验证后，一个 SQL 事务更新 owner 的物理 key 和 mount 身份、全部覆盖 alias、已完成 worktree 的物理 key 和锚点计划，以及对应 `SESSION_WORKTREE` 操作的物理 key。只有因身份冲突阻塞的已完成 worktree 可以变为 READY；其他失败状态拒绝。原 worktree 操作的请求/摘要以及计划中记录历史准入的 `storageIdentity` 保持不变。终态历史操作保持不变。事务完成 receipt 并移除本操作围栏。已完成请求的重试只验证新状态，不再修改。

## 受影响组件

`MacOsHostIdentity` 提供卷探测和稳定锚点身份。`NativeStorageIdentityReader` 保留供旧身份校验和实时文件操作使用的数值读取。`WorkspaceStorageGuard` 识别两种登记编码，本地身份兼容和搬迁历史读取委托给已有的 `LocalStorageOwners` 辅助代码。`SessionWorktreeGit` 校验两种锚点格式，并单独暴露离线重新认定计算。runtime-local 复用现有停止协议。持久化维护 store 和 server 私有 main 负责持久离线转换；参考发行包将该 main 作为 `workspace-identity-reattest` 接入既有离线 admin 启动器。无需新增公共路由或修改 TypeScript payload。

待完成的目录导入 receipt 重试时按照其保存身份选择编码。对未发生变化的旧 owner 新增 alias 时，复用完整匹配的数值身份，不创建竞争的 UUID owner。已完成重新认定 receipt 使用独立 phase，使文件历史校验跳过它们并继续找到最近真正的搬迁 receipt。本地 serve 启动器保留默认关闭可信重启的既有行为；私有维护命令显式启用可信原生重启观测。

## 验证与验收

聚焦 Java 测试覆盖原生 UUID 解析和探测失败、数值设备号变化下稳定身份不变、不同 UUID/inode/出生时间拒绝、旧身份拒绝且不修改、每个 worktree 锚点和 Git 指针、实时数值文件身份、两个平台的可信重启证明、同 boot/跨平台拒绝以及已有逃逸 writer 保护。离线测试覆盖清单遗漏、活动 writer、字节冲突、每个 marker 边界后的重试、冲突请求 ID 和原请求/journal 不变。旧锚点与已稳定锚点混合的清单必须能够完成，且稳定记录逐字节原样保留，包括旧计划搭配已稳定完成记录的情形；指向其他卷的稳定锚点必须在安装任何围栏之前被拒绝。

原会话验收要求：先证明旧 Runtime 已清理，完成离线重新认定，恢复查询允许新 Turn，并在同一会话、同一分支和保留修改的前提下提交并执行新 Turn。不重放已取消 Turn。此前提交超时和根因证据单独保留。Java 检查共享用户授权的 1,800 秒预算。本地不可用的真实 MySQL 8.4 和完整 Hosted/fault profile 仍为必须执行的 CI 检查；H2 不替代这些证据。

## 风险与未决事项

原生探测增加有界进程开销，不得加入新的无界循环。旧 marker 丢失、不支持卷 UUID、物理 owner 冲突、Git 创建/删除中断或 writer 未被证明停止时，仍明确阻塞。卷 UUID 是本地主机信任证据，不保证抵御有权限克隆卷的主体。不存在未决的自动降级或历史身份推断方案；不支持的场景拒绝。
