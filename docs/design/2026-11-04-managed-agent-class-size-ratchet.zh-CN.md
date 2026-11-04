# Managed Agent 类体量棘轮

[English](2026-11-04-managed-agent-class-size-ratchet.md) | [简体中文](2026-11-04-managed-agent-class-size-ratchet.zh-CN.md)

## 状态与范围

- 状态：由本改动实现；仅 verification 门禁，不改任何生产代码。
- 日期：2026-11-04
- 范围：`packages/managed-agent-server` —— `persistence` 与 `runtime-broker` 的生产源码。
- 基线：`origin/main` `14a5a2d98d`，store 分解（#16090、#16142）与 broker 提取簇落地之后。

本文解决[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md)留下的开放问题：类体量棘轮门禁是在 P1 之前引入（阻止再长），还是在拆分落地之后才引入。两个头号上帝类现已分解——`ManagedAgentStore` 是 1,170 行门面、`ManagedSessionStore` 是 357 行门面，`RuntimeBrokerService` 是十个协作者之上的 4,255 行门面——因此门禁在**拆分落地之后**引入，以锁住这些成果。结构评审的验收标准早已点名此门禁："P1 完成＝`persistence` 或 `runtime-broker` 中没有任何类超过约定的体量棘轮"。

## 问题

分解把职责移出了上帝类，但没有任何东西阻止它们长回去。没有门禁，未来的能力切片可以悄悄把数千行重新堆回 `ManagedAgentStore` 或它的某个聚合，一次一个便利方法地拆掉拆分成果。重载计数棘轮（`SessionCreationCommandContractTest`）保护的是会话创建 API 的形状，而非类体量。类体量棘轮让"再长"成为一个可见的、失败的改动，而不是静默漂移。

## 设计

单个 verification 测试 `ClassSizeRatchetTest`（置于 `architecture` 包、与 `ModuleArchitectureTest` 并列）遍历 `persistence/src/main/java` 与 `runtime-broker/src/main/java` 的生产源码树，按顶层类统计源码行数，并对照 pin 资源 `class-size-ratchet.properties` 强制四条规则：

1. **全局上限。** 任何类不得超过 `GLOBAL_MAX_LINES`（4,255）。这就是验收标准里的"约定体量棘轮"，以当前最大类（`RuntimeBrokerService`）作种子，只降不升。
2. **按类上限。** pin 中列出的每个类，行数不得超过其钉住值。pin 以每个大类的当前行数作种子，故被钉住的类完全不能再长。
3. **大类必须入 pin。** 任何达到或超过 `LARGE_CLASS_THRESHOLD`（800 行）却不在 pin 中的类都会失败。因此一个类无法悄悄长成大类；跨过 800 行就强制按其当时行数显式入 pin。
4. **无失效 pin。** 每条 pin 必须对应一个存在的生产类。删除或重命名一个类就强制剪掉它的 pin，保持 pin 诚实。

行数按换行符计数，与 `wc -l` 一致；排除 `package-info.java` 与 `module-info.java`。源码根经 `VerificationFixtures.moduleRoot()`（构建已注入的 `managed.module.root` 属性）解析，故门禁在 reactor 与 CI 中均可用。

### 阈值及其理由

- **`LARGE_CLASS_THRESHOLD = 800`。** 一个略低于当前最小大类（802 行）的整数行界。它覆盖当前每个聚合与门面，并把"达到 800 行"视为一个类大到值得拥有一个显式、经评审的上限的临界点。低于它的类可自由改动，故对小 helper 的普通编辑不会触发门禁。
- **`GLOBAL_MAX_LINES = 4255`。** 今天能通过的最紧值（当前最大值）。它是一道任何类——无论是否入 pin——都不得超过的兜底，并随剩余大类（`WorkspaceCsiApplicationInventory` 3,329、`ToolPublicationDataStore` 2,709、`JdbcRuntimeBindingRepository` 2,671、`ManagedExtensionRecordStore` 2,170，以及 broker 门面）被分解而下调。
- **范围恰为 `persistence` + `runtime-broker`。** 这是验收标准点名的两个模块。`runtime-*` provider 模块（`runtime-http`/`host`/`local`/`external`/`kubernetes`/`ssh`/`static`）是独立顶层模块、不在范围；`contracts`、`control-plane`、`adapters`、`server` 同样不在此棘轮之列。

### 棘轮纪律

上限只**降**不升。一个类变小时，下调其在 pin 中的上限；一个类被删除或重命名时，移除其条目；随大类被拆分而下调 `GLOBAL_MAX_LINES`。上调某个上限或全局最大值是一个评审会拒绝的可见 diff——与重载计数棘轮同一约定。pin 的头注在条目旁记录了这一纪律。

## 验证

- 门禁在基线上通过：`ClassSizeRatchetTest` —— `Tests run: 1, Failures: 0, Errors: 0`（JDK 21，隔离任务仓库）。Checkstyle（含测试源码）对新测试报 0 违规。
- 每条规则都经字节级备份＋sha256 校验还原的变异验证：
  - 把 `ManagedAgentStore` 的上限降到 100 → 失败："grew to 1170 lines, above its ratchet ceiling 100"（规则 2）。
  - 删除 `ManagedAgentStore` 的 pin 条目 → 失败："reached 1170 lines (>= 800) but is not pinned"（规则 3）。
  - 为一个不存在的类加 pin → 失败："stale ratchet pin … no longer maps to a production class"（规则 4）。
  - 把 `GLOBAL_MAX_LINES` 降到 100 → 失败："… above the global ceiling 100"（规则 1）。
  - 还原后门禁重新转绿。

## 后续

- 每分解一个剩余大类，就下调其上限（或剪掉它）并下调 `GLOBAL_MAX_LINES`；当没有任何类超过约定棘轮时，结构评审账本的验收标准即达成。
- 门禁刻意不自动收紧 pin；收紧是一次经评审的编辑，让棘轮保持为有意识的决策，而非一份悄悄漂移快照。

相关设计：[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md)、[store 分解](2026-11-02-managed-store-decomposition.zh-CN.md)。
