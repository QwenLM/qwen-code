# Managed Agent 类体量棘轮

[English](2026-11-04-managed-agent-class-size-ratchet.md) | [简体中文](2026-11-04-managed-agent-class-size-ratchet.zh-CN.md)

## 状态与范围

- 状态：已实现；仅由 verification 强制。回执 helper 提取保持运行时校验语义，并收紧上限。
- 日期：2026-11-04；更新于 2026-11-28
- 范围：`packages/managed-agent-server` —— `persistence` 与 `runtime-broker` 的生产源码。
- 基线：`origin/main` `14a5a2d98d`，store 分解（#16090、#16142）与 broker 提取簇落地之后。

本文解决[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md)留下的开放问题：类体量棘轮门禁是在 P1 之前引入（阻止再长），还是在拆分落地之后才引入。引入门禁时，两个头号上帝类已经分解——当时 `ManagedAgentStore` 为 1,170 行门面、`ManagedSessionStore` 为 357 行门面，`RuntimeBrokerService` 为九个协作者之上的 4,270 行门面——因此门禁在**拆分落地之后**引入，以锁住这些成果。结构评审的验收标准早已点名此门禁："P1 完成＝`persistence` 或 `runtime-broker` 中没有任何类超过约定的体量棘轮"。

在原始基线上，合并上游运行时供给失败处理逻辑的提取与已有 `sameReceipt` 纯比较函数向 `RuntimeBrokerSupport` 的迁移后，broker 门面为十个协作者之上的 4,216 行。当时回执比较函数体和两个确认调用位置保持不变；全局和 broker 专属上限也下调至 4,216。

## 当前落地状态（2026-11-28）

门禁覆盖 `persistence/src/main/java` 与 `runtime-broker/src/main/java` 两个源码根。当前全局上限为 **2,309 行**，与当前最大类 `ToolPublicationDataStore` 的实际行数及其按类 pin 一致。当前次大类是 `JdbcManagedExtensionRecordStore`，实际为 2,129 行，保留较早的 2,170 行 pin；`JdbcRuntimeBindingRepository` 实际 2,088 行，保留最近一次合并 main 后的 2,095 行 pin。由于 pin 仅由显式评审编辑下调、不会自动收紧，目前 25 条已入 pin 条目中有 16 条高于对应类的实测行数。

新增私有 `ossScope` helper 曾把 `ToolPublicationDataStore` 从 2,481 行增长到 2,485 行，超过 #17478 当时建立的 2,483 行上限。main 上 #18085 将该 scope helper 移入 `ToolPublicationContract`，使该类减到 2,482 行，并把全局上限与该类 pin 从 2,483 下调至 2,482。随后 `ToolPublicationObjectKeys` 删除了不再使用的 import，使该类、全局上限和按类 pin 均降至 2,481。以 main 的这一基线为起点，#17846 先提取 guard、再提取回执谓词到 `ToolPublicationRequirements`，使分支上的上限先后降至 2,476 和 2,470；合并 main 上的上述缩减后，该类行数、全局上限和按类 pin 均降至 2,306。随后合并 #18325，在其经评审的纯 import 宽免下增加三条 import 行；全局只降不升的棘轮也相应获得三行例外，最终该类行数、全局上限与按类 pin 均为 2,309。持久化 key 布局不变。上文历史叙述中的 4,216 行及其他类体量描述原始设计基线，而非当前上限。

## 问题

分解把职责移出了上帝类，但没有任何东西阻止它们长回去。没有门禁，未来的能力切片可以悄悄把数千行重新堆回 `ManagedAgentStore` 或它的某个聚合，一次一个便利方法地拆掉拆分成果。重载计数棘轮（`SessionCreationCommandContractTest`）保护的是会话创建 API 的形状，而非类体量。类体量棘轮让"再长"成为一个可见的、失败的改动，而不是静默漂移。

## 设计

单个 verification 测试 `ClassSizeRatchetTest`（置于 `architecture` 包、与 `ModuleArchitectureTest` 并列）遍历 `persistence/src/main/java` 与 `runtime-broker/src/main/java` 的生产源码树，按顶层类统计源码行数，并对照 pin 资源 `class-size-ratchet.properties` 强制四条规则：

1. **全局上限。** 任何类不得超过 `GLOBAL_MAX_LINES`（当前 2,309；原始设计基线为 4,216）。这就是验收标准里的"约定体量棘轮"，以当时的最大类作种子，随分解持续收窄，只降不升。
2. **按类上限。** pin 中列出的每个类，行数不得超过其钉住值。每条条目在类入 pin 时按当时行数作种子，且仅通过经评审的编辑下调，故被钉住的类不能超过其上限（之后缩小且尚未手动收紧 pin 的类，在收紧前仍保留到其上限之间的余量）。
3. **大类必须入 pin。** 任何达到或超过 `LARGE_CLASS_THRESHOLD`（800 行）却不在 pin 中的类都会失败。因此一个类无法悄悄长成大类；跨过 800 行就强制按其当时行数显式入 pin。
4. **无失效 pin。** 每条 pin 必须对应一个存在的生产类。删除或重命名一个类就强制剪掉它的 pin，保持 pin 诚实。

行数按换行符计数，与 `wc -l` 一致；排除 `package-info.java` 与 `module-info.java`。源码根经 `VerificationFixtures.moduleRoot()`（构建已注入的 `managed.module.root` 属性）解析，故门禁在 reactor 与 CI 中均可用。

### 阈值及其理由

- **`LARGE_CLASS_THRESHOLD = 800`。** 覆盖当前所有大聚合与门面的整数阈值，用于显式审视类增长。达到 800 行意味着需要评审该类的大小与职责，并非说 800 行本身就是架构缺陷。未入 pin 且低于 800 行的类可自由改动而不会触发门禁，故对小 helper 的普通编辑无需更新 pin；曾入 pin、之后缩小到 800 行以下的类在移出 pin 前仍受各自 pin 上限约束。
- **`GLOBAL_MAX_LINES = 2309`。** 这是当前最大值，与 `ToolPublicationDataStore` 的实际行数及其按类 pin 一致；当前次大类是 `JdbcRuntimeBindingRepository` 的 2,131 行。它仍是所有类（无论是否入 pin）的兜底，并随类分解而下调。
- **范围恰为 `persistence` + `runtime-broker`。** 这是验收标准点名的两个模块。`runtime-*` provider 模块（`runtime-http`/`host`/`local`/`external`/`ssh`/`static`）是独立顶层模块、不在范围；`contracts`、`control-plane`、`adapters`、`server` 同样不在此棘轮之列。

### 棘轮纪律

除经评审且行数精确对应 import 增量的宽免外，上限只**降**不升。一个类变小时，下调其在 pin 中的上限；一个类被删除或重命名时，移除其条目；随大类被拆分而下调 `GLOBAL_MAX_LINES`。任何其他上限或全局最大值上调都是评审会拒绝的可见 diff——与重载计数棘轮同一约定。pin 的头注在条目旁记录了这一纪律。

## 验证

- 历史基线验证：`ClassSizeRatchetTest` —— `Tests run: 1, Failures: 0, Errors: 0`（JDK 21，隔离任务仓库）。Checkstyle（含测试源码）对新测试报 0 违规。
- 每条规则都经字节级备份＋sha256 校验还原的变异验证：
  - 把 `ManagedAgentStore` 的上限降到 100 → 失败："grew to 1170 lines, above its ratchet ceiling 100"（规则 2）。
  - 删除 `ManagedAgentStore` 的 pin 条目 → 失败："reached 1170 lines (>= 800) but is not pinned"（规则 3）。
  - 为一个不存在的类加 pin → 失败："stale ratchet pin … no longer maps to a production class"（规则 4）。
  - 把 `GLOBAL_MAX_LINES` 降到 100 → 失败："… above the global ceiling 100"（规则 1）。
  - 还原后门禁重新转绿。

- 回执 helper 提取的验收要求 CI 中的源码体量门禁及精确回执确认测试（`RuntimeSshAcknowledgementTest`、`RuntimeBrokerServiceTest`）通过。提取仅改变方法所属类，比较函数体和确认锁定语义保持不变。

## 后续

- 每分解一个剩余大类，就下调其上限（或剪掉它）并下调 `GLOBAL_MAX_LINES`；当没有任何类超过约定棘轮时，结构评审账本的验收标准即达成。
- 门禁刻意不自动收紧 pin；收紧是一次经评审的编辑，让棘轮保持为有意识的决策，而非一份悄悄漂移快照。

相关设计：[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md)、[store 分解](2026-11-02-managed-store-decomposition.zh-CN.md)。
