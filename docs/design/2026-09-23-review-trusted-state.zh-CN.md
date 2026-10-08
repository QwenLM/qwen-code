# 将 Review 可信状态移出 Workspace

[English](2026-09-23-review-trusted-state.md) | [简体中文](2026-09-23-review-trusted-state.zh-CN.md)

状态：本变更已实现，尚未合入。

## 问题

Review 流程把 worktree lease 和 base-tree 记录作为宿主机侧权威。Lease 可以授权 cleanup 删除 worktree 和分支，base-tree 记录则决定已构建的对照树是否可以安全复用。这些记录当前位于 `<repository>/.qwen/review-leases`。

工具执行沙箱会让仓库 workspace 可写。Bubblewrap 通过 mask `.qwen/review-leases` 进行补偿，但加法式 Landlock 规则集无法在一个整体可写的 workspace 下表达隐藏或拒绝访问某个子目录。因此，只要可信状态仍在 workspace 中，Landlock 就无法保持相同的 review 安全边界。

## 目标

- 将 review lease 和 base-tree 可信记录放到所有可写仓库 workspace 之外。
- 让 review 的外层仓库及其嵌套 review worktree 继续共享同一个锁作用域。
- 让仓库命名空间抗碰撞，并在符号链接路径的不同拼写下保持稳定。
- 不再依赖特定后端的 mask，同时保留用户配置的 sandbox mask。
- 忽略已废弃 workspace 目录里的权威状态，不迁移也不信任它。

## 非目标

- 本变更不实现 Landlock。
- 本变更不保证未启用沙箱时可以抵御同一用户身份运行的其他进程。
- 本变更不保证与只认识 workspace 内旧路径的 CLI 版本并发协调 lease。
- 本变更不删除更早的 `.qwen/tmp` 兼容镜像；该镜像仍只是提示信息，绝不会作为权威读取。

## 设计

可信 review 状态迁移到 `$QWEN_HOME/review-state/<repository-hash>`。哈希是规范化最外层仓库根路径的 SHA-256。已存在的根路径通过 `realpath` 解析，在统一符号链接拼写的同时，不会合并大小写敏感卷上的不同仓库。

目录布局如下：

```text
$QWEN_HOME/review-state/<repository-hash>/
├── qwen-review-lease-pr-<n>.json
└── base-tree/pr-<n>/
    ├── <plan-hash>.json
    └── review-pr-<n>-base.lock/
```

如果在另一个 review worktree 内启动 review，路径计算会按字面寻找第一个最外层 `.qwen/tmp` 边界，并对该外层仓库根路径做哈希。因此，内外两层 review 会使用相同的 lease 和 base-tree 命名空间。计算过程不会读取 reviewed content 内的 Git 指针。

Sandbox policy admission 已把 `QWEN_HOME` 视为受保护根。若配置的 `QWEN_HOME` 与 workspace 重叠，执行前就会被拒绝。在沙箱中，全局状态保留在只读宿主视图中，而 workspace 保持可写。

CLI 不再把 `<workspace>/.qwen/review-leases` 自动追加到 `maskedPaths`。Operator policy 显式提供的 mask 保持不变。已废弃目录仍从 local-diff 捕获中排除，避免旧版本遗留内容进入 review 输入，但任何 lease 或 base-tree 决策都不会再读取该目录。

## 迁移与兼容性

新版本第一次 capture 会在全局命名空间中创建新 lease。即使 `.qwen/review-leases` 中的现有内容格式正确，也会被忽略，因为 reviewed code 可能在 workspace 可写时修改它。自动导入会把攻击者可控状态跨越可信边界迁入新位置。

在切换使用不同 lease 路径的版本前，操作者应完成或清理进行中的 review。旧版本无法安全使用新的全局 lease，新版本也无法安全信任旧的 workspace lease。

## 风险

- 修改 `QWEN_HOME` 会改变可信状态命名空间，并可能在旧根目录留下过期状态。
- 移动仓库会改变路径哈希，并可能在旧命名空间留下过期状态。
- 不同版本并发 review 无法跨路径变更协调；安全的操作规则是避免这种重叠。

这些情况会导致无法复用或需要清理，但不会把新状态的权威交给 reviewed code。

## 验证计划

- 验证直接仓库和嵌套仓库路径选择预期的全局命名空间，并且不同仓库不会碰撞。
- 在 `.qwen/review-leases` 中放置格式有效的伪造 lease，验证 acquisition 和 base-tree identity 都会忽略它。
- 在新路径上覆盖原子 acquisition、同 session refresh、cleanup、可信记录回收和 base-tree 复用测试。
- 验证 sandbox 配置保留 operator 显式 mask，且不再添加已废弃的内建 mask。
- 构建并 typecheck Core/CLI，执行定向 lint、格式检查和 review 宿主执行 canary。
- 在 Linux 上验证 workspace-write 沙箱可以修改已废弃 workspace 路径，却不能修改全局可信状态，同时 review cleanup 仍只根据真实 lease 执行。

## 验收标准

- 所有生产 lease 和 base-tree 权威路径都不在仓库 workspace 中。
- 外层仓库及其下嵌套的 review worktree 共用一个仓库命名空间。
- Workspace 内伪造状态不能阻止 acquisition、轮换 base-tree trust 或重定向 cleanup。
- 自动 `.qwen/review-leases` mask 已移除，显式 mask 保持不变。
- 定向测试、build、typecheck、lint、格式和 diff 检查全部通过。

## 后续工作

本变更合入后，可以把 Landlock fallback 重放到 `main`。它必须拒绝所有仍然非空的 `maskedPaths` policy，并保留已有的 bubblewrap 加固与 fail-closed 行为。
