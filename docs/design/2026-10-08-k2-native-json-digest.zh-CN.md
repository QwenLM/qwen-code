# K2 原生 JSON 事务摘要兼容性

[English](2026-10-08-k2-native-json-digest.md) | [简体中文](2026-10-08-k2-native-json-digest.zh-CN.md)

状态：前置步骤已实现并完成局部组件验证；完整 K2 和云上验收尚未完成，仍需维护者评审。
日期：2026-10-08。关联 #12380、#13395、Draft PR #13526。

## 1. 问题与当前状态

原生 TypeScript 生产者允许 JSON 事件数据包含任意有限 binary64 数字。
它递归拼接 JSON，将每个对象的键按 UTF-16 码元排序、保持数组顺序，并对标量叶值
使用 `JSON.stringify`。在基线 `6fbdab868624e361257317ff8e50607366f77320`，Java 的
`CsiNativeActivationProof` 已匹配键和字符串规则，但所有数字叶值都经过结构字段的
非负整数解析器，会拒绝合法的负数、小数、极小或极大事件数据。此前置步骤替换该
数字转换，不开放原生 history 的语义消费者。

当前 SQL 准入有意只支持 genesis、原 activation、续期和唯一初始 checkpoint。
通用内容摘要正确，不等于事件、grant、worker 或 SQL 状态转换获得授权。

## 2. 拟议变更与消费者

保留 `CsiNativeActivationProof` 内的私有递归规范化函数。只替换数字叶值的转换，
匹配现有原生生产者的有限 binary64 序列化。不新增依赖或通用 JSON 框架。

规范化比较之前，显式用现有结构 `number` 函数解析 marker 的 `firstSequence`、
`lastSequence` 和 `eventCount`。这些原始 marker 字段此前间接依赖仅接受整数的
规范化函数。同时显式要求 operation/contentDigest/eventsDigest 是字符串，
previousCommitDigest 是 null 或字符串，防止数字支持扩大 marker 的错误类型边界。
metadata、事件 version/sequence、activation、时间、资源引用和
checkpoint 的结构校验保持不变，包括现有上限 `9_007_199_254_740_990`。

消费者包括 `transaction`（marker 同值比较、marker hash、完整事件数组 hash）、
`activation`（原 install 引用同值比较和事件数组 hash）以及 `initialCheckpoint`
（事件数组 hash）。`JdbcCsiActivationAdmission` 在新提交准入和历史重放中调用它们，
两条路径仍执行现有封闭语义门禁。不新增路由、字段、调用方、schema、数据库迁移、
boot envelope 或执行准入。

## 3. 数字与字节决策

数字叶值转成 Java `double`，拒绝非有限结果，两种有符号零均编码为 `0`。
这匹配生产者的有限 JavaScript Number 模型；很大的整数 JSON 字面量在此内容摘要中
也采用 binary64 语义。结构整数字段保留独立解析器。

Java 21 的 `Double.toString` 在最短精度至少两位时选择最近的最短十进制值。
对于一位有效数字，它可能选择两位十进制，例如 `4.9E-324`。直接使用它经
`BigDecimal.valueOf` 去掉尾零的表示，只有精度为两位时才校正：对精确的正 binary64
值（`new BigDecimal(double)`）分别向下和向上舍入到一位有效数字；只保留能转换回
相同 binary64 值的候选，选精确距离最近的十进制值，等距时选偶数有效数字。
两个候选均不能转换回原值时，保留 Java 的十进制表示。这是依据
[Java 21 转换契约](<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Double.html#toString(double)>)
和 [ECMAScript Number 转换规则](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-tostring)
作出的设计推论，已按下述方法用实际 Node 生产者完成局部验证。抽样验证不证明
全部有限 binary64 值均一致。

选出的十进制指数在 `-6..20` 时使用普通表示，否则使用小写 `e`、显式正指数符号，
不保留小数尾零。保持负号。算法最多检查两个一位数字候选，不搜索全部精度，
生产环境不调用 JavaScript 引擎。Runtime Broker 已要求 Java 21。

对象键继续按 UTF-16 码元的字典序排序，包括形似整数的键。不重建排序对象后再调用
序列化器，因为 JavaScript 可能重新排列这类键。字符串保持现有对孤立 surrogate
和控制字符的转义，合法 surrogate pair 保持原样。数组、布尔值和 null 的表示不变。

只有事件和 marker 内容参与规范化。`payloadJson` 字符串仍然是字符串；资源内容、
checkpoint 字节和 record-byte 摘要继续绑定原始 UTF-8 字节，其 hash 不得替换为
重新序列化结果。

## 4. 文件与范围

修改 Java proof 及同目录测试。在 Runtime Broker 测试资源中新增小型仅测试 Node
生成器和固定的生产者事务 fixture。生成器导入实际构建的 `parseManagedSessionEvent`、
`managedSessionEventsDigest` 和 `describeTransaction`，不另写规范化函数。
测试 envelope 明确为合成数据。使用合法 `cancel.requested.target` JSON 值覆盖通用
叶值，不放宽原生事件解析器。现有 activation fixture 保持不变。

不改变 TypeScript 生产行为或公开配置。私有文件 history/schema-2、完整 SQL batch
成员、可信 worker 回读、prepare/execute/publication、consumed receipt、聚合
DRAINED/RELEASED、物理 writer 终止、NodeUnpublish、安全卷复用和公开 Hosted/Spring
选择仍在此前置步骤之外。局部检查无需云上资源或新增 authority。

## 5. 验证与验收

先对全局 `qwen` CLI dry-run。它没有 Java proof 入口，记录这一限制后，以实际编译
proof 和实际构建 TypeScript 生产者作为 test-script fallback。编辑前证明包含合法
负数/小数叶值的生产者字节被拒绝，而原 activation/续期仍通过。

编辑后要求 Java 对未改动的 Node 生产者字节完成事务验证，包括 marker 和完整事件
数组 hash。覆盖有符号零、最小 subnormal、最大有限值、十进制表示阈值、大整数叶值、
最近值/等距用例、UTF-16 键顺序、形似整数的键、控制转义、孤立 surrogate、合法 pair
及原始 JSON 字符串。通过同一实际生产者运行有界、固定种子的 binary64 差分样本；
样本是局部证据，不是对全部有限值的证明。

拒绝 marker 和事件结构字段中的小数/指数、负或越界计数、改动的 hash/parent/scope、
重复 JSON 键、尾随 JSON、无效 UTF-8 和数值溢出。现有 activation、初始 checkpoint、
资源字节、新 SQL 准入和历史重放拒绝测试须继续通过。通用事务 hash 匹配后，仍必须
被私有 activation/checkpoint 语义门禁拒绝。

先执行根目录 build、typecheck、bundle，再执行会加载构建模块的 Java 检查；运行
相关 Core 生产者和 Runtime Broker proof/SQL 测试、Checkstyle 与 SpotBugs。
独立 test-engineer 只观察并管理自己创建的临时文件和进程。保留失败尝试，重复样本
只计一次。完整 diff 自审两遍，尝试仓库真实 native review 流程。保持 Draft；如评审
不可用，如实报告，人工替代不能算作批准。

局部候选结果：根目录 build、typecheck、bundle 通过；221 项相关 Core 测试和
225 项 Java 测试通过，无跳过，相关 ESLint、Prettier、Checkstyle、SpotBugs 通过。
独立基线复现五项合法数字被拒绝。变更后独立验证接受了这些原输入，完成 12,206 项
预期观察，无非预期失败：12,000 个独立固定种子数字事务、98 个数字边界事务，以及
108 项覆盖固定 fixture、原基线、结构/hash/编码拒绝和封闭语义/资源边界的对照。
35,381 字节 fixture 再生成后逐字节一致，SHA-256 为
`48da8ddf981bbbf564941dd0060db8a4d9b85d3aa6ab248035f9638962384d5b`。
这些观察数与 446 项相关测试分开计数。证据输入已检查漂移，自有临时文件和进程已
清理。本次未调用模型、DB 服务、CSI 挂载或云上运行，也不构成完整 K2 验收。

## 6. 风险与剩余问题

此小型数字校正依赖 Java 21 文档中的转换契约。Fixture 须来自实际 Node 生产函数，
重新生成时逐字节相同；由 Java 自行生成期望 hash 会掩盖不兼容。通用 JSON 数据不得
绕过结构整数门禁或封闭语义准入。

此前置步骤没有待选择的产品配置。精确性能和跨语言一致性属于验证事项。任何不一致
都要求在提交前重新考虑算法；局部样本成功不代表完整 K2 或新的云上运行已验收。
