# Managed 媒体保留边界

[English](managed-media-retention-boundary.md) | [简体中文](managed-media-retention-boundary.zh-CN.md)

## 当前生产者与问题

P3 issue [#13884](https://github.com/QwenLM/qwen-code/issues/13884) 早于共享
schema 整合。在 `06efd789b1` 上，Session 回收器已经释放退役 journal owner，
并且不限制 kind 地回收没有引用的不可变 SQL 资源。剩余工作必须区分实际生产者与
尚待设计的共享对象生命周期。

Hosted 文件结果生产者在既有转换与持久大小限制内接受 inline 媒体与
`fileData` 定位符，并将其转换为 function-response part。普通 Hosted turn 将
转换后的响应发布为 `managed-tool-outcome`，将工具结果历史单独写为
`managed-message`，再结算引用 outcome 的 Harness checkpoint。这些字节使用
Session 私有的 `MYSQL_INLINE` 资源
命名空间。两个 Session 可以包含完全相同的字节及相同 resource ID，但
`resource_key` 不同。这是独立存储，并非一个物理共享对象。

普通 omni 管线使用另一套内容寻址文件系统存储和全局媒体记忆账本。其既有 GC
保护被引用的对象，在 memory 不可读或最近损坏时停止，并在删除后使 upload 与
degradation 缓存失效。它没有连接到 Hosted Session 的永久退役。
普通 Hosted 恢复验证器明确拒绝非空的 `output.mediaRefs` 布局；源码检查没有发现
当前 Hosted 生产者填充该字段。私有 CSI Session profile 受独立保护，仍不参与 Session
回收器。

## 受支持的 SQL 生命周期

原生见证在既有的 `hosted-workspace-shell/1` profile 上执行普通 Hosted
`read_file` turn，运行真实转换、outcome 发布、消息 sink、activation、Harness
Runtime 结算、事务描述器和嵌套引用发现。只将外部 Runtime 边界替换为 inline
媒体结果。小型内存 resource/journal transport 捕获全部八个事务和十一个资源；
Java 见证获取真实 writer，再通过真实 SQL Session 库提交这些事务。测试不手工
构造 checkpoint，也不把引用资源改成可回收 publication。此 fixture 证明已接受的
inline 结果保留；它不测试远端文件系统、模型、codec 或外部 Runtime 进程。

存活 Session 与已关闭 writer 保留媒体证据。持有存活 writer grant 的鉴权读取，以及
writer 封存后新建的恢复读取器，必须返回完全相同的原始字节；封存不会授予普通读取。
读租约与持久恢复保护分别阻止退役 Session 释放 owner。
GC 继续默认关闭。永久退役、宽限期到期且读者与恢复均结束后，有界 owner 释放才可
先于字节回收执行。持久回收结果对各个实际清空的字节只计数一次，在回收器重启后
保持，并保留原始资源身份与摘要墓碑。fixture 在真实退役与关闭 GC 验证之后，只
提前自己的退役时间戳，避免依赖零宽限期的时钟边界。回收一个 Session 的私有副本，必须让另一个
Session 的相同副本与 journal 仍可读取。

引用谓词按 `resource_key` 检查全部 owner，包括其他 Session 的账本行。一项防御性
测试显式插入这样的行，证明它会阻止删除。这是安全谓词见证，并不是创建物理共享的
API。当前已完成的回收游标不会在外部 owner 稍后释放时重新遍历此前被保留的行，因此
该测试不能证明完整的共享对象生命周期。

## 尚未实现的边界

Hosted 媒体物理共享需要实际生产者契约和持久的 Session 到对象引用闭包，之后回收器
才可释放共享字节。该工作必须区分已验证的空账本与缺失或损坏的账本，保留所有存活
Session 引用，在最后一次释放后重新遍历延迟候选，并防止 upload/degradation 缓存
复活已删除对象。外部 `fileData` 字节仍归其外部生产者所有；回收 SQL 定位符不会
删除远端对象。

此变更不新增推测性的 Hosted omni adapter，也不启用新恢复布局。它不会关闭
[#13884](https://github.com/QwenLM/qwen-code/issues/13884)，也不宣称生产物理回收验收通过。后续物理共享生命周期和
[#13090](https://github.com/QwenLM/qwen-code/issues/13090) 的部署门禁仍然开放。

## 验证与验收

聚焦 H2 和一次性 MySQL 8.4 用例覆盖真实原生生产者生成的 inline 媒体 outcome 与历史、完整
读取与重新打开、相同内容的 Session 隔离、读者与恢复保护、默认关闭 GC、owner
释放顺序、退役栅栏、回收器重启与记账，以及外部引用的防御性保护。临时绕过 owner
释放或引用谓词的 mutation 必须使相应见证失败，再恢复生产源代码。普通 omni 的
损坏与缓存测试验证其既有的独立边界，不代表支持 Hosted 退役。

使用 JDK 21、聚焦 MySQL class/method 过滤器、两道 Checkstyle 门禁和 SpotBugs
执行 Java 检查。原生 fixture 需要与未修改 main TypeScript 源码一致的 Core/CLI
构建产物。完整集成和模块验证、独立评审是另外的证据。不修改 schema、生产代码、
公共 API 或默认值。
