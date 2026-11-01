# Managed Agent Store 构造装配收敛

[English](2026-11-01-managed-agent-store-wiring.md) | [简体中文](2026-11-01-managed-agent-store-wiring.zh-CN.md)

- 状态：本地已实现，定向验证通过；完整 CI 验收仍待完成。
- 日期：2026-11-01
- 基线：`06c1f989715fa812fc26258525ef97627c15b855`。
- 范围：`ManagedAgentStore` 依赖装配及直接验证夹具，独立于 PR #16029。

## 问题与当前状态

[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md) 指出了 Session store 的七个公开 setter。其中三个是 Spring 必需依赖（`WorktreeFiles`、`ManagedSessionSkills`、`ExtensionPackages`），四个可选（`WorkspaceLifecycleStore`、`ManagedAgentDefinitionStore`、`SessionWorktreeStore`、`JournalEventTransport`）。构造器还会创建一个 standalone skills store，随后由 Spring 替换。因此，对象可以在依赖尚未装配完整时存在。

另有第八处注入：可选且延迟的 `ManagedExtensionRecordStore` 字段注入。它经 `AgentStateStore` 存在真实回环。skills store 自身也有现存的延迟 resource-store 依赖。其余直接依赖的构造器不立即回调 Session store：lifecycle 经 provider 获取 runtime 资源，definitions 依赖 JDBC/digests，worktrees 依赖 JDBC/registry/storage guard，extension packages 依赖 catalog/registry/archive，journal transport 依赖消息组件。

## 目标与边界

将八个依赖引用全部改为 final，经构造赋值，移除七个 setter 与注入字段。保留 Spring 必需/可选解析、延迟 record-store 回环边界、qualifier、事务、SQL、协议字节和功能关闭行为。不修改相邻 store 的注入，不拆业务逻辑，不改 schema/路由，也不在生产代码引入依赖容器、builder 或通用 provider 抽象。

## 构造设计

使用一个显式 `@Autowired` 构造器，包含现有七个输入、三个必需依赖和五个可选依赖。必需依赖使用普通构造参数，缺少 Spring bean 时继续启动失败。可选依赖使用 `@Nullable`，业务方法保留原空值判断。record store 使用 `@Lazy @Nullable` 注入：构造期间不解析延迟代理，保留原延迟字段行为，避免立即解析其 `AgentStateStore` 回引。构造器不解析该代理，也不调用依赖。

构造器直接保存注入的 skills 实例，不再制造随后被替换的临时对象。保留现有 JDBC、mapper、clock 的 qualifier，以及全部根据 settings 推导的字段。可选 definitions、lifecycle、worktree 和 transport 仍是具体对象，避免 provider 的重复解析改变当前空值判断或依赖身份。

保留已有七参数 standalone 构造器，因为两个生产 private-CSI helper 在 Spring 外构造最小 store。它只委托一次到完整构造器，提供同样的 standalone skills 实现，并像以前一样不配置集成依赖。Spring 只选择带注解的完整构造器。这是已有的具体用途，不新增兼容重载链：不保留 setter 桥，也不继续添加构造器重载。

## 调用方与测试夹具

生产环境继续由组件扫描构造 store；private-CSI helper 保留已有 standalone 构造。原先在构造后补 local worktree files 的测试夹具改为构造工厂。默认形式构造相同的 standalone skills 行为和本地 worktree adapter。第二种仅测试形式接收已有测试实际配置的 definitions 与 lifecycle 对象，这些调用方改为构造前提供。保留相同的事务包络、settings、JDBC 实例和测试断言。

将所有 `VerificationFixtures.configure(new ManagedAgentStore(...))` 调用迁到该工厂。只读/private 夹具使用的裸 standalone 构造继续有效。少量 definitions/lifecycle 配置语句移到工厂构造前；若 lifecycle 夹具通过 result-store provider 回引，则按原 provider 图在 Session store 构造后登记 result store。不通过反射修改 final 字段，不重建已构造 store 来模拟 setter。

## 验证

新增禁用循环引用的真实 Spring context 测试。覆盖必需依赖全部存在、分别缺少各必需依赖、可选依赖缺席、实际 record-store/Session-store 回环、延迟 target 解析及事务代理身份。断言 store 没有注入字段或修改依赖的方法，八个依赖字段全部 final。必需 bean 检查必须验证 Spring 解析行为，不能只检查构造器注解。

复用应用 context 准入与 skills 测试、definition/approval 测试及装配迁移影响的 lifecycle 夹具。包括一个有代表性的现有完整应用 context，以便最小 context 之外也覆盖真实组件装配。SQL/repository 算法不变，对比构造器和已删除 setter 之外的方法体。在模块共享的 10 分钟本地验证预算内，以 JDK 21 和匹配源码的 SDK 运行定向 Java 测试与 Checkstyle；完整 Java/SpotBugs 及平台/集成验收交给 CI。该内部装配重构不需要全局 CLI 基线或 TypeScript 构建。

文档验证覆盖两个完整语言版本、相对链接和格式。对包含机械迁移夹具的完整 diff 进行自审，直到连续两轮干净。分别记录选中测试与未运行门禁；本地 context/H2 通过不构成 MySQL、Hosted 或生产验收。

## 风险、验收与待定问题

主要风险是把可选 bean 变成必需、立即解析 record-store 回环、注入原始早期引用而非事务代理，或改变手动夹具行为。保留延迟注解，不用立即 `getIfAvailable` 替换，并用测试固定运行时 bean 图。standalone 构造器刻意缺席的集成依赖保持不变；完整 Spring 构造器继续要求其三个 bean。

验收要求：移除七个公开 setter 与字段注入；八个依赖字段 final；业务方法体和 SQL 不变；直接调用方迁移完成；必需/可选/回环/代理 context 测试和受影响回归通过；双语设计完整同步；两轮自审干净。没有待定产品决策；在目标修订通过所需门禁前，完整 CI 验收仍待完成。
